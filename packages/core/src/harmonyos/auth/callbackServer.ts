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
  /**
   * Hand the callback in by hand: the address the browser was sent to, as pasted
   * from its address bar (see {@link parseCallbackInput}). It goes through the
   * same checks as a request to the loopback port and settles the same login.
   */
  submit(input: string): CallbackVerdict;
  stop(): Promise<void>;
}

/**
 * What became of one callback: `accepted` settled the login (signed in, or
 * cancelled in the browser); otherwise `reason` says why it was refused.
 */
export type CallbackVerdict = { accepted: true } | { accepted: false; reason: string };

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

/**
 * The query of a pasted login callback. Takes what a user copies once a browser
 * on another machine fails to load the loopback redirect: the whole address
 * (`http://127.0.0.1:<port>/callback?code=…`), its path and query, or the bare
 * query string, optionally quoted.
 *
 * @internal exposed for tests.
 */
export function parseCallbackInput(input: string): URLSearchParams {
  let text = input.trim();
  // Shells and chat clients wrap what they copy.
  const quoted = /^(['"<`])([\s\S]*)(['">`])$/.exec(text);
  if (quoted) text = quoted[2]!.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      return new URL(text).searchParams;
    } catch {
      // Not a URL after all; read it as a query.
    }
  }
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
  // A fragment is never part of what the login page sends.
  return new URLSearchParams(query.split('#')[0]);
}

/** The outcome of one set of callback parameters, checked against the secret. */
type Evaluation =
  | { kind: 'signedIn'; callback: LoginCallback }
  | { kind: 'quit' }
  | { kind: 'refused'; reason: string };

function evaluate(params: URLSearchParams, secret: string): Evaluation {
  if (!params.has('code')) return { kind: 'refused', reason: 'it has no `code` parameter' };
  if (!codeMatches(params.get('code'), secret)) {
    return { kind: 'refused', reason: 'its `code` belongs to another sign-in attempt' };
  }
  if (isQuit(params.get('quit'))) return { kind: 'quit' };
  const tempToken = params.get('tempToken');
  const siteId = params.get('siteId');
  if (!tempToken || !siteId) return { kind: 'refused', reason: 'it has no `tempToken` or no `siteId`' };
  return { kind: 'signedIn', callback: { tempToken, siteId } };
}

export interface StartCallbackServerOptions {
  /** Secret echoed back by the login page; proves the callback is ours. */
  clientSecret: string;
  /** Host the browser is redirected to after the callback is handled. */
  baseUrl: string;
  successPath: string;
  failedPath: string;
  /**
   * Port to listen on. Default 0, an OS-assigned one. A fixed port lets an
   * `ssh -L <port>:127.0.0.1:<port>` tunnel from the machine with the browser be
   * set up before the login starts.
   */
  port?: number;
}

/**
 * Start a loopback HTTP server that receives the browser's login callback.
 *
 * Bound to 127.0.0.1, on `opts.port` or else an OS-assigned port: the login page
 * is told which port to redirect to, so nothing needs to be reserved.
 */
export async function startCallbackServer(
  opts: StartCallbackServerOptions,
): Promise<CallbackServer> {
  const requested = opts.port ?? 0;
  if (!Number.isInteger(requested) || requested < 0 || requested > 65_535) {
    throw new OniroError(`Invalid login callback port ${requested}: expected an integer from 1 to 65535.`);
  }

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

  const settle = (verdict: Exclude<Evaluation, { kind: 'refused' }>) => {
    if (verdict.kind === 'quit') rejectCallback(new CancelledError('Login was cancelled in the browser.'));
    else resolveCallback(verdict.callback);
  };

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
      const verdict = evaluate(params, opts.clientSecret);
      if (verdict.kind === 'refused') {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }
      const page = verdict.kind === 'quit' ? opts.failedPath : opts.successPath;
      res.writeHead(302, { Location: `${opts.baseUrl}/${page}` });
      res.end();
      settle(verdict);
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
    server.once('error', (err: NodeJS.ErrnoException) => {
      const why =
        err.code === 'EADDRINUSE'
          ? `port ${requested} is already in use on 127.0.0.1; pick another with --port`
          : err.code === 'EACCES'
            ? `this user may not listen on port ${requested}; pick one above 1023`
            : err.message;
      reject(new OniroError(`Failed to start the local login callback server: ${why}.`, err));
    });
    server.listen(requested, '127.0.0.1', resolve);
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

    submit(input: string): CallbackVerdict {
      const verdict = evaluate(parseCallbackInput(input), opts.clientSecret);
      if (verdict.kind === 'refused') return { accepted: false, reason: verdict.reason };
      settle(verdict);
      return { accepted: true };
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
