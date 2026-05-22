import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const DAEMON_ROOT_KEY_COMPONENT_LENGTH = 16;
const DAEMON_SALT_KEY_LENGTH = 16;
const DAEMON_WORK_KEY_LENGTH = 16;
const KEY_FILE_DIRECTORY_PERMISSIONS = 0o755;
const KEY_FILE_PERMISSIONS = 0o600;

const COMPONENT = Buffer.from([
  49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119,
]);

/**
 * Encrypts data using AES-128-GCM.
 * Output layout: [4-byte BE length][12-byte IV][ciphertext][16-byte auth tag].
 */
function encrypt(key: Buffer, data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const totalLength = ciphertext.length + authTag.length;
  const out = Buffer.alloc(4 + iv.length + ciphertext.length + authTag.length);
  out.writeUInt32BE(totalLength, 0);
  iv.copy(out, 4);
  ciphertext.copy(out, 16);
  authTag.copy(out, 16 + ciphertext.length);
  return out;
}

function decrypt(key: Buffer, data: Buffer): Buffer {
  const totalLength = data.readUInt32BE(0);
  const iv = data.subarray(4, 16);
  const ciphertextLength = totalLength - 16;
  const ciphertext = data.subarray(16, 16 + ciphertextLength);
  const authTag = data.subarray(16 + ciphertextLength);
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function xorBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) {
    throw new Error('No buffers provided for XOR.');
  }
  const result = Buffer.from(buffers[0]!);
  for (let i = 1; i < buffers.length; i++) {
    const buf = buffers[i]!;
    if (buf.length !== result.length) {
      throw new Error('Buffers have different lengths in XOR.');
    }
    for (let j = 0; j < result.length; j++) {
      result[j] = result[j]! ^ buf[j]!;
    }
  }
  return result;
}

function getRootKey(fdComponents: Buffer[], salt: Buffer): Buffer {
  const components = fdComponents.concat([COMPONENT]);
  const xored = xorBuffers(components);
  return crypto.pbkdf2Sync(xored.toString(), salt, 10000, 16, 'sha256');
}

function createAndStoreKey(dir: string, keyLength: number): Buffer {
  const key = crypto.randomBytes(keyLength);
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const filePath = path.join(dir, hash);
  fs.writeFileSync(filePath, key);
  fs.chmodSync(filePath, KEY_FILE_PERMISSIONS);
  return key;
}

function createAndStoreEnKey(rootKey: Buffer, ceDir: string): void {
  const workKey = crypto.randomBytes(DAEMON_WORK_KEY_LENGTH);
  const encrypted = encrypt(rootKey, workKey);
  const hash = crypto.createHash('sha256').update(encrypted).digest('hex');
  const filePath = path.join(ceDir, hash);
  fs.writeFileSync(filePath, encrypted);
  fs.chmodSync(filePath, KEY_FILE_PERMISSIONS);
}

/**
 * Generates the signing-material directory tree: fd/{0,1,2}, ac, ce.
 * Each subfolder contains a randomly-named keyfile derived as described in
 * the OpenHarmony hap-sign-tool reference implementation.
 */
export function createMaterial(materialPath: string): void {
  fs.mkdirSync(materialPath, { recursive: true });
  fs.chmodSync(materialPath, KEY_FILE_DIRECTORY_PERMISSIONS);

  const fdDir = path.join(materialPath, 'fd');
  const acDir = path.join(materialPath, 'ac');
  const ceDir = path.join(materialPath, 'ce');

  fs.mkdirSync(fdDir, { recursive: true });
  fs.mkdirSync(acDir, { recursive: true });
  fs.mkdirSync(ceDir, { recursive: true });

  const fdSubDirs = ['0', '1', '2'];
  const fdComponents: Buffer[] = [];
  for (const sub of fdSubDirs) {
    const subDir = path.join(fdDir, sub);
    fs.mkdirSync(subDir, { recursive: true });
    const comp = createAndStoreKey(subDir, DAEMON_ROOT_KEY_COMPONENT_LENGTH);
    fdComponents.push(comp);
  }

  const salt = createAndStoreKey(acDir, DAEMON_SALT_KEY_LENGTH);
  const rootKey = getRootKey(fdComponents, salt);
  createAndStoreEnKey(rootKey, ceDir);
}

function readSingleFile(dir: string): Buffer {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Missing signing material directory: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f !== '.DS_Store');
  if (files.length !== 1) {
    throw new Error(`Signing material in ${dir} is illegal (expected exactly one file).`);
  }
  return fs.readFileSync(path.join(dir, files[0]!));
}

/**
 * Re-derives the work key from an existing material directory.
 */
export function getKey(materialPath: string): Buffer {
  if (!fs.existsSync(materialPath) || !fs.statSync(materialPath).isDirectory()) {
    throw new Error('Material directory does not exist.');
  }

  const fdDir = path.join(materialPath, 'fd');
  const fdComponents = ['0', '1', '2'].map((sub) => readSingleFile(path.join(fdDir, sub)));
  const salt = readSingleFile(path.join(materialPath, 'ac'));
  const rootKey = getRootKey(fdComponents, salt);
  const workMaterial = readSingleFile(path.join(materialPath, 'ce'));
  return decrypt(rootKey, workMaterial);
}

/**
 * Encrypts a password using the work key derived from `materialPath`.
 * Returns the encrypted blob as a hex string (the format expected in build-profile.json5).
 */
export function encryptPwd(password: string, materialPath: string): string {
  const key = getKey(materialPath);
  const pwdBuffer = Buffer.from(password, 'utf-8');
  return encrypt(key, pwdBuffer).toString('hex');
}

/**
 * Inverse of `encryptPwd`. Exposed for parity with the original CLI.
 */
export function decryptPwd(encryptedHex: string, materialPath: string): string {
  const key = getKey(materialPath);
  const encryptedBuffer = Buffer.from(encryptedHex, 'hex');
  return decrypt(key, encryptedBuffer).toString('utf-8');
}
