/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/auth/login/local-auth-server.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 */
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CancelledError, OniroError } from '../../ports/errors.js';

/** What the login page hands back once the user has signed in. */
export interface LoginCallback {
  tempToken: string;
  /** The account's region; see `siteForId`. */
  siteId: string;
}

const CALLBACK_PATH = '/callback';
const MAX_BODY_BYTES = 65_536;

export interface CallbackServer {
  /** Port the loopback listener bound to. Handed to the login page as `?port=`. */
  readonly port: number;
  /** Resolves with the browser's callback, including one that arrived before this was called. */
  waitForCallback(timeoutMs: number): Promise<LoginCallback>;
  stop(): Promise<void>;
}

/**
 * Constant-time compare of the `code` parameter against the secret this process
 * generated. Without it any local page could POST a token of its own choosing to
 * the loopback port while a login is in flight.
 */
function codeMatches(code: string | null, secret: string): boolean {
  const a = Buffer.from(code ?? '', 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isQuit(quit: string | null): boolean {
  return quit === 'true' || quit === 'access_denied' || quit === 'quit';
}

export interface StartCallbackServerOptions {
  /** Secret echoed back by the login page; proves the callback is ours. */
  clientSecret: string;
  /** Host the browser is redirected to after the callback is handled. */
  baseUrl: string;
  successPath: string;
  failedPath: string;
}

/**
 * Start a loopback HTTP server that receives the browser's login callback.
 *
 * Bound to 127.0.0.1 on an OS-assigned port: the login page is told which port
 * to redirect to, so nothing needs to be reserved or configured.
 */
export async function startCallbackServer(
  opts: StartCallbackServerOptions,
): Promise<CallbackServer> {
  // Settled by the first valid callback, whenever it arrives: the browser can come
  // back before anyone is waiting for it.
  let resolveCallback!: (value: LoginCallback) => void;
  let rejectCallback!: (reason: Error) => void;
  const callback = new Promise<LoginCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // A cancellation nobody waits for yet must not surface as an unhandled rejection.
  callback.catch(() => {});

  const server = http.createServer((req, res) => {
    // Reject requests that did not address us by our own loopback authority —
    // cheap defence against DNS-rebinding onto the callback port.
    const host = (req.headers.host ?? '').toLowerCase();
    const port = (server.address() as AddressInfo | null)?.port;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(400);
      res.end('Bad Host');
      return;
    }

    const url = new URL(req.url ?? '', `http://${host}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const finish = (params: URLSearchParams) => {
      if (!codeMatches(params.get('code'), opts.clientSecret)) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }
      if (isQuit(params.get('quit'))) {
        res.writeHead(302, { Location: `${opts.baseUrl}/${opts.failedPath}` });
        res.end();
        rejectCallback(new CancelledError('Login was cancelled in the browser.'));
        return;
      }
      const tempToken = params.get('tempToken');
      const siteId = params.get('siteId');
      if (!tempToken || !siteId) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }
      res.writeHead(302, { Location: `${opts.baseUrl}/${opts.successPath}` });
      res.end();
      resolveCallback({ tempToken, siteId });
    };

    if (req.method === 'POST') {
      let body = '';
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new Error('Request body too large'));
          return;
        }
        body += chunk.toString();
      });
      req.on('end', () => finish(body.trim() ? new URLSearchParams(body) : url.searchParams));
    } else {
      finish(url.searchParams);
    }
  });

  // Keep-alive would hold the process open after the single callback we care about.
  server.keepAliveTimeout = 1;

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err) => reject(new OniroError('Failed to start the local login callback server.', err)));
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as AddressInfo).port;

  return {
    port,

    waitForCallback(timeoutMs: number): Promise<LoginCallback> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new OniroError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser login to complete.`)),
          timeoutMs,
        );
      });
      return Promise.race([callback, timeout]).finally(() => clearTimeout(timer));
    },

    stop(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        // The browser may still be holding the redirect response; do not let a slow
        // client keep the CLI alive.
        const timer = setTimeout(resolve, 100);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
