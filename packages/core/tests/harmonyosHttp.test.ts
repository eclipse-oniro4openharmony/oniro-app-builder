import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpClient, describeResponse, previewBody, redactUrl } from '../src/harmonyos/http.js';
import { OniroError } from '../src/ports/errors.js';

describe('createHttpClient', () => {
  let server: http.Server;
  let base: string;
  let client: ReturnType<typeof createHttpClient>;
  const requests: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    // A proxy configured on the host running the tests must not intercept loopback calls.
    for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) vi.stubEnv(name, '');
    client = createHttpClient();
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        const { pathname } = new URL(req.url ?? '', 'http://x');
        if (pathname === '/slow') return void setTimeout(() => res.end('late'), 1_000);
        if (pathname === '/binary') return void res.end(Buffer.from([0, 1, 2, 255]));
        if (pathname === '/missing') {
          res.writeHead(404, 'Nope');
          return void res.end('{"ret":{"code":404}}');
        }
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const last = () => requests.at(-1)!;

  it('sends the query, skipping unset values, with the default headers', async () => {
    const response = await client.get(`${base}/echo`, {
      query: { a: 1, b: 'two', none: undefined, nil: null },
      headers: { oauth2Token: 'at' },
    });
    expect(response).toEqual({ data: 'ok', statusCode: 200, statusText: 'OK' });
    expect(last().url).toBe('/echo?a=1&b=two');
    expect(last().headers.oauth2token).toBe('at');
    expect(last().headers.accept).toBe('application/json, text/plain, */*');
  });

  it('sends a body as JSON', async () => {
    await client.post(`${base}/echo`, { body: { certIds: ['1'] } });
    expect(last().method).toBe('POST');
    expect(last().headers['content-type']).toBe('application/json');
    expect(JSON.parse(last().body)).toEqual({ certIds: ['1'] });

    await client.delete(`${base}/echo`, { query: { id: 'p1' } });
    expect(last()).toMatchObject({ method: 'DELETE', url: '/echo?id=p1' });
  });

  it('resolves a failing status with its reason phrase and body, for the caller to read', async () => {
    const response = await client.get(`${base}/missing`);
    expect(response).toEqual({ data: '{"ret":{"code":404}}', statusCode: 404, statusText: 'Nope' });
    expect(describeResponse(response)).toBe('HTTP 404 Nope: {"ret":{"code":404}}');
  });

  it('downloads bytes, and rejects a failing download', async () => {
    await expect(client.getBinary(`${base}/binary`)).resolves.toEqual(Buffer.from([0, 1, 2, 255]));
    await expect(client.getBinary(`${base}/missing`)).rejects.toThrow(/failed \(HTTP 404\)/);
  });

  it('reports a timeout', async () => {
    await expect(client.get(`${base}/slow`, { timeoutMs: 50 })).rejects.toThrow(/timed out after 50ms/);
  });

  it('reports an unreachable host without leaking credentials from the URL', async () => {
    // A port nothing listens on: bind one, then release it.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));

    const error = await client.get(`http://127.0.0.1:${port}/x`, { query: { tempToken: 'SECRET' } }).catch((e) => e);
    expect(error).toBeInstanceOf(OniroError);
    expect(error.message).toMatch(/GET .*tempToken=\*\*\* failed/);
    expect(error.message).not.toContain('SECRET');
  });
});

describe('log redaction', () => {
  it('strips credentials from a URL but keeps the rest legible', () => {
    const redacted = redactUrl('https://h.example/authrouter/auth/api/temptoken/check?tempToken=SECRET&site=EU&appid=1009');
    expect(redacted).not.toContain('SECRET');
    expect(redacted).toContain('tempToken=***');
    expect(redacted).toContain('site=EU');
    expect(redacted).toContain('appid=1009');
  });

  it('strips every sensitive parameter name, case-insensitively', () => {
    const redacted = redactUrl('https://h.example/x?jwtToken=A&CODE=B&oauth2Token=C&accessToken=D&keep=E');
    expect(new URL(redacted).searchParams.getAll('keep')).toEqual(['E']);
    for (const key of ['jwtToken', 'CODE', 'oauth2Token', 'accessToken']) {
      expect(new URL(redacted).searchParams.get(key)).toBe('***');
    }
  });

  it('leaves a non-URL untouched rather than throwing', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });

  it('previews an error body for diagnosis', () => {
    expect(previewBody('<html><title>404 Not Found</title></html>')).toContain('404 Not Found');
    expect(previewBody('')).toBe('(empty body)');
    expect(previewBody('   ')).toBe('(empty body)');
  });

  it('never echoes a token-shaped body', () => {
    // A successful exchange returns a bare JWT; it must not reach an error string.
    expect(previewBody('aaa.bbb.ccc')).toBe('(a token-shaped value)');
  });

  it('truncates long bodies', () => {
    expect(previewBody('x'.repeat(1000))).toBe(`${'x'.repeat(300)}…`);
  });

  it('collapses newlines so a multi-line page stays one log line', () => {
    expect(previewBody('line one\nline two')).toBe('line one line two');
  });
});
