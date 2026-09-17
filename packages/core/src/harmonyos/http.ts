/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/utils/http-client.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 */
import { EnvHttpProxyAgent, fetch, type Response } from 'undici';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import { OniroError } from '../ports/errors.js';

/**
 * Upstream's request headers, kept identical: these are private endpoints, and
 * matching the client they were built for removes one variable when they misbehave.
 */
const DEFAULT_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept-language': 'zh-CN',
  accept: 'application/json, text/plain, */*',
};

const DEFAULT_TIMEOUT_MS = 20_000;

export interface HttpResponse {
  /** Body as text. Several endpoints send JSON under a non-JSON content type. */
  data: string;
  statusCode: number;
  /** Reason phrase. Some AGC errors are reported only here. Empty over HTTP/2. */
  statusText: string;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  /** Sent as JSON. */
  body?: unknown;
  timeoutMs?: number;
}

/**
 * `get`, `post` and `delete` resolve for any HTTP status: AGC reports failures
 * through the status, the reason phrase and the body, so callers read all three.
 * `getBinary` is for downloads and rejects on a non-2xx status.
 */
export interface HarmonyOsHttpClient {
  get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
  post(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
  delete(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
  getBinary(url: string, opts?: HttpRequestOptions): Promise<Buffer>;
}

/** Query parameters that carry credentials for the user's Huawei account. */
const SENSITIVE_PARAMS = new Set(['temptoken', 'jwttoken', 'code', 'oauth2token', 'accesstoken']);

/**
 * A log-safe form of a URL: credential-bearing query values become `***`.
 *
 * @internal exposed for tests.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_PARAMS.has(key.toLowerCase())) parsed.searchParams.set(key, '***');
  }
  return parsed.toString();
}

/**
 * A short, log-safe preview of a response body. Suppressed entirely when it looks
 * like a bare JWT, so a credential cannot leak into an error message.
 *
 * @internal exposed for tests.
 */
export function previewBody(body: string, limit = 300): string {
  const trimmed = body.trim();
  if (!trimmed) return '(empty body)';
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) return '(a token-shaped value)';
  const collapsed = trimmed.replace(/\s+/g, ' ');
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** `HTTP 500 Internal Server Error: <body preview>`, for error messages. */
export function describeResponse(response: HttpResponse): string {
  const status = `HTTP ${response.statusCode}${response.statusText ? ` ${response.statusText}` : ''}`;
  return `${status}: ${previewBody(response.data)}`;
}

function buildUrl(url: string, query?: Record<string, unknown>): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

/** The HTTP client for the HarmonyOS auth and signing flows. */
export function createHttpClient(opts: { logger?: Logger } = {}): HarmonyOsHttpClient {
  const logger = opts.logger ?? noopLogger;
  // Node's own fetch ignores HTTPS_PROXY / HTTP_PROXY / NO_PROXY; this agent honours them.
  const dispatcher = new EnvHttpProxyAgent();

  async function send(method: string, url: string, options: HttpRequestOptions): Promise<Response> {
    const target = buildUrl(url, options.query);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...options.headers };
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }

    // The query string can carry credentials, so only the redacted URL is logged.
    logger.debug(`[harmonyos] ${method} ${redactUrl(target)}`);
    try {
      return await fetch(target, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? `timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new OniroError(
        `${method} ${redactUrl(target)} failed: ${reason}. ` +
          'Check the network connection and any proxy configuration (HTTPS_PROXY / HTTP_PROXY).',
        err,
      );
    }
  }

  async function request(method: string, url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const response = await send(method, url, options);
    return { data: await response.text(), statusCode: response.status, statusText: response.statusText };
  }

  return {
    get: (url, o) => request('GET', url, o),
    post: (url, o) => request('POST', url, o),
    delete: (url, o) => request('DELETE', url, o),
    async getBinary(url, o = {}) {
      const response = await send('GET', url, o);
      if (!response.ok) {
        throw new OniroError(`Download of ${redactUrl(response.url || url)} failed (HTTP ${response.status}).`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
