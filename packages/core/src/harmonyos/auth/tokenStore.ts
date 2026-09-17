/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/auth/utils/local-crypto.ts`, `src/auth/utils/token-storage.ts`),
 * Copyright (c) 2026 Huawei Device Co., Ltd., licensed under the MIT License.
 * See packages/core/src/harmonyos/NOTICE.md.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ConfigProvider } from '../../ports/config.js';
import { defaultPaths } from '../../ports/config.js';
import type { Logger } from '../../ports/logger.js';
import { noopLogger } from '../../ports/logger.js';
import { OniroError } from '../../ports/errors.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TOKEN_FILE = 'token.enc';
const WRAPPED_DEK_FILE = 'token.dek';
const KEK_FILE = 'kek.bin';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface EncryptedBlob {
  version: 1;
  algorithm: typeof ALGORITHM;
  ciphertext: string;
  iv: string;
  authTag: string;
  timestamp: number;
}

/**
 * Envelope encryption for the account token at rest.
 *
 * The token is encrypted with a random data key (DEK); the DEK is itself
 * encrypted with a key-encryption key (KEK) kept in a *different* directory.
 * Both halves live on the same disk, so this is defence against a stray copy of
 * one directory — a config-dir backup, a synced dotfile repo — not against a
 * local attacker who can read the user's whole home. Treat the token as a
 * credential regardless.
 */
function encryptWith(key: Buffer, plaintext: Buffer): EncryptedBlob {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: ALGORITHM,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    timestamp: Date.now(),
  };
}

function decryptWith(key: Buffer, blob: EncryptedBlob): Buffer {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (!value || typeof value !== 'object') return false;
  const b = value as Partial<EncryptedBlob>;
  return (
    b.algorithm === ALGORITHM &&
    typeof b.ciphertext === 'string' &&
    typeof b.iv === 'string' &&
    typeof b.authTag === 'string'
  );
}

function permissionHint(dir: string): string {
  return process.platform === 'win32'
    ? `Permission denied writing ${dir}. Grant write permission to that directory.`
    : `Permission denied writing ${dir}. Try: chown -R "$(whoami)" ${dir}`;
}

function ensureDir(dir: string): void {
  if (fs.existsSync(dir)) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new OniroError(permissionHint(dir), err);
    }
    throw err;
  }
}

/**
 * A signed-in account: the durable credential plus its region, since every later
 * request goes to that region's hosts and only the login callback reports it.
 */
export interface StoredSession {
  jwtToken: string;
  /** `siteId` from the login callback. */
  siteId: string;
}

export interface TokenStore {
  save(session: StoredSession): void;
  load(): StoredSession | null;
  clear(): void;
  /** Where the encrypted token lives — surfaced by `auth status`. */
  readonly tokenPath: string;
}

export interface CreateTokenStoreOptions {
  config: ConfigProvider;
  logger?: Logger;
}

/**
 * Persist the Huawei account JWT under the configured auth directory
 * (`ONIRO_HARMONYOS_AUTH_DIR`, default `~/.oniro/harmonyos`).
 */
export function createTokenStore(opts: CreateTokenStoreOptions): TokenStore {
  const logger = opts.logger ?? noopLogger;
  const authDir = opts.config.get('harmonyosAuthDir', defaultPaths.harmonyosAuthDir());
  const tokenPath = path.join(authDir, TOKEN_FILE);
  const wrappedDekPath = path.join(authDir, WRAPPED_DEK_FILE);
  // Deliberately outside the auth dir, so the two halves are not backed up together.
  const kekPath = path.join(os.homedir(), '.local', 'share', 'oniro-app', 'keys', KEK_FILE);

  function loadOrCreateKek(): Buffer {
    ensureDir(path.dirname(kekPath));
    if (fs.existsSync(kekPath)) {
      const existing = fs.readFileSync(kekPath);
      if (existing.length === KEY_LENGTH) return existing;
      logger.warn('[harmonyos] KEK file was malformed; regenerating (you will need to log in again).');
    }
    const kek = crypto.randomBytes(KEY_LENGTH);
    fs.writeFileSync(kekPath, kek, { mode: FILE_MODE });
    return kek;
  }

  function loadOrCreateDek(): Buffer {
    const kek = loadOrCreateKek();
    if (fs.existsSync(wrappedDekPath)) {
      try {
        const wrapped: unknown = JSON.parse(fs.readFileSync(wrappedDekPath, 'utf8'));
        if (isEncryptedBlob(wrapped)) {
          const dek = decryptWith(kek, wrapped);
          if (dek.length === KEY_LENGTH) return dek;
        }
      } catch {
        // A DEK we cannot unwrap is as good as absent: fall through and mint a new
        // one. The token encrypted under the old DEK becomes unreadable, which
        // `load()` reports as "not logged in".
      }
    }
    const dek = crypto.randomBytes(KEY_LENGTH);
    ensureDir(authDir);
    fs.writeFileSync(wrappedDekPath, JSON.stringify(encryptWith(kek, dek), null, 2), {
      mode: FILE_MODE,
    });
    return dek;
  }

  return {
    tokenPath,

    save(session: StoredSession): void {
      if (!session.jwtToken) throw new OniroError('Refusing to store an empty token.');
      const dek = loadOrCreateDek();
      ensureDir(authDir);
      const payload = Buffer.from(JSON.stringify(session), 'utf8');
      fs.writeFileSync(tokenPath, JSON.stringify(encryptWith(dek, payload), null, 2), {
        mode: FILE_MODE,
      });
    },

    load(): StoredSession | null {
      if (!fs.existsSync(tokenPath)) return null;
      try {
        const blob: unknown = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        if (!isEncryptedBlob(blob)) return null;
        const { jwtToken, siteId } = JSON.parse(decryptWith(loadOrCreateDek(), blob).toString('utf8')) as Partial<StoredSession>;
        return typeof jwtToken === 'string' && jwtToken && typeof siteId === 'string' ? { jwtToken, siteId } : null;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // A permissions problem is transient and the user can fix it; anything else
        // means the stored token is unusable, so drop it rather than failing every
        // later command with the same decrypt error.
        if (code === 'EACCES' || code === 'EPERM') {
          logger.warn(`[harmonyos] Cannot read ${tokenPath}: ${permissionHint(authDir)}`);
          return null;
        }
        logger.debug(`[harmonyos] Discarding unreadable token at ${tokenPath}.`);
        try {
          fs.rmSync(tokenPath, { force: true });
        } catch {
          // Best effort.
        }
        return null;
      }
    },

    clear(): void {
      for (const file of [tokenPath, wrappedDekPath]) {
        try {
          fs.rmSync(file, { force: true });
        } catch (err) {
          throw new OniroError(`Failed to remove ${file}.`, err);
        }
      }
    },
  };
}
