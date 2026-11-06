import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { OniroError, noopLogger, type Logger } from '@oniroproject/core';
import {
  DEFAULT_STORE_URL,
  StoreApiError,
  StoreClient,
  assetSha256,
  buildRegisterBody,
  publishPackage,
  readPackageIdentity,
  removeStoreToken,
  resolveReleaseAsset,
  resolveStoreToken,
  resolveStoreUrl,
  saveStoreToken,
  storeCredentialsPath,
  type FetchFn,
  type GithubAsset,
} from '../src/commands/store.js';
import { makeStoredZip } from '../../core/tests/_helpers/storedZip.js';
import { runCli } from './_helpers/runCli.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-store-cli-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeFile(name: string, data: Buffer): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, data);
  return file;
}

const moduleJson = (bundleName: string) =>
  Buffer.from(JSON.stringify({ app: { bundleName, versionCode: 1000000, versionName: '1.0.0' }, module: { name: 'entry' } }));

function hapZip(bundleName: string): Buffer {
  return makeStoredZip([
    { name: 'module.json', data: moduleJson(bundleName) },
    { name: 'ets/modules.abc', data: Buffer.from('code') },
  ]);
}

function appZip(bundleName: string): Buffer {
  const packInfo = { summary: { app: { bundleName, version: { code: 1000000, name: '1.0.0' } } }, packages: [] };
  return makeStoredZip([
    { name: 'pack.info', data: Buffer.from(JSON.stringify(packInfo)) },
    { name: 'entry-default.hap', data: hapZip(bundleName) },
  ]);
}

/** A logger that records warnings, so tests can see what a command told the user. */
function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { ...noopLogger, warn: (m: string) => warnings.push(m), warnings };
}

// ---------------------------------------------------------------------------
// A stand-in store: answers by "METHOD /path" and records each request.
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
type Handler = (req: Recorded) => { status: number; body?: unknown };

let server: http.Server;
let baseUrl: string;
let routes: Record<string, Handler> = {};
let requests: Recorded[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(recorded);
      const handler = routes[`${recorded.method} ${recorded.url}`];
      const answer = handler ? handler(recorded) : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no route' } } };
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  routes = {};
  requests = [];
});

const LIMITS = { status: 200, body: { data: { maxPackageBytes: 300 * 1024 * 1024, maxIconBytes: 512 * 1024 } } };

// ---------------------------------------------------------------------------

describe('store URL', () => {
  it('takes --url, then ONIRO_STORE_URL, then the public store, without a trailing slash', () => {
    expect(resolveStoreUrl(undefined, {})).toBe(DEFAULT_STORE_URL);
    expect(resolveStoreUrl(undefined, { ONIRO_STORE_URL: 'https://staging.example.org/' })).toBe('https://staging.example.org');
    expect(resolveStoreUrl('https://a.example.org', { ONIRO_STORE_URL: 'https://b.example.org' })).toBe('https://a.example.org');
    expect(resolveStoreUrl('http://localhost:3000/', {})).toBe('http://localhost:3000');
  });

  it('refuses plain http to another host, and garbage', () => {
    expect(() => resolveStoreUrl('http://store.example.org', {})).toThrow(/https/);
    expect(() => resolveStoreUrl('not a url', {})).toThrow(/not a valid store URL/);
  });
});

describe('stored tokens', () => {
  const env = { ONIRO_STORE_AUTH_DIR: path.join(tmp, 'auth') };

  it('saves a token per store, 0600, and forgets it on logout', () => {
    const file = saveStoreToken('https://a.example.org', 'oas_aaa', 'alice', env);
    expect(file).toBe(storeCredentialsPath(env));
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveStoreToken('https://a.example.org', env)).toEqual({ token: 'oas_aaa', source: 'file' });
    // Never sent to another store.
    expect(() => resolveStoreToken('https://b.example.org', env)).toThrow(/No token for https:\/\/b\.example\.org/);
    expect(removeStoreToken('https://a.example.org', env)).toBe(true);
    expect(removeStoreToken('https://a.example.org', env)).toBe(false);
    expect(() => resolveStoreToken('https://a.example.org', env)).toThrow(/ONIRO_STORE_TOKEN/);
  });

  it('prefers ONIRO_STORE_TOKEN over the saved one', () => {
    saveStoreToken('https://a.example.org', 'oas_saved', null, env);
    expect(resolveStoreToken('https://a.example.org', { ...env, ONIRO_STORE_TOKEN: ' oas_env ' })).toEqual({
      token: 'oas_env',
      source: 'env',
    });
  });

  it('refuses a token a header cannot carry, without echoing it', () => {
    const run = () => resolveStoreToken('https://a.example.org', { ...env, ONIRO_STORE_TOKEN: 'oas_secret\n# prod\n' });
    expect(run).toThrow(/^ONIRO_STORE_TOKEN contains spaces, line breaks/);
    expect(run).not.toThrow(/oas_secret/);
  });
});

describe('package identity', () => {
  it('reads a .hap from module.json and an .app from pack.info, lowercased', async () => {
    expect(await readPackageIdentity(writeFile('a.hap', hapZip('com.Example.Alpha')))).toEqual({
      bundleName: 'com.example.alpha',
      format: 'hap',
    });
    expect(await readPackageIdentity(writeFile('b.app', appZip('com.example.beta')))).toEqual({
      bundleName: 'com.example.beta',
      format: 'app',
    });
    const fa = makeStoredZip([{ name: 'config.json', data: Buffer.from(JSON.stringify({ app: { bundleName: 'org.fa.app' } })) }]);
    expect(await readPackageIdentity(writeFile('fa.hap', fa))).toEqual({ bundleName: 'org.fa.app', format: 'hap' });
  });

  it('rejects files that are not packages', async () => {
    await expect(readPackageIdentity(writeFile('junk.hap', Buffer.from('not a zip')))).rejects.toThrow(OniroError);
    const empty = makeStoredZip([{ name: 'readme.txt', data: Buffer.from('hi') }]);
    await expect(readPackageIdentity(writeFile('empty.hap', empty))).rejects.toThrow(/no module\.json, config\.json or pack\.info/);
    await expect(readPackageIdentity(path.join(tmp, 'missing.hap'))).rejects.toThrow(/does not exist/);
  });
});

describe('store publish', () => {
  it('creates a listing when the package is not among the publisher\'s apps', async () => {
    routes['GET /api/v1/limits'] = () => LIMITS;
    routes['GET /api/v1/publisher/apps'] = () => ({ status: 200, body: { data: [{ packageName: 'com.other.app', name: 'Other' }] } });
    routes['POST /api/v1/publisher/apps'] = () => ({
      status: 201,
      body: { data: { packageName: 'com.example.alpha', versionCode: 1000000, status: 'approved', storeSigned: [] } },
    });
    const bytes = hapZip('com.example.alpha');
    const file = writeFile('alpha.hap', bytes);

    const result = await publishPackage(
      new StoreClient(baseUrl, 'oas_tok'),
      file,
      { name: 'Alpha', description: 'An app', category: 'game', tags: ['a', 'b'] },
      noopLogger,
    );

    expect(result).toEqual({
      action: 'created',
      url: `${baseUrl}/apps/com.example.alpha`,
      packageName: 'com.example.alpha',
      versionCode: 1000000,
      status: 'approved',
      storeSigned: [],
    });
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.headers.authorization).toBe('Bearer oas_tok');
    expect(post.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = post.body.toString('latin1');
    expect(body).toMatch(/name="name"\r\n\r\nAlpha\r\n/);
    expect(body).toMatch(/name="category"\r\n\r\ngame\r\n/);
    expect(body).toMatch(/name="tags"\r\n\r\na,b\r\n/);
    expect(body).toContain('name="hap"; filename="alpha.hap"');
    // The package itself arrives whole, streamed from disk.
    expect(post.body.includes(bytes)).toBe(true);
    // The limits are public: no token sent there.
    expect(requests.find((r) => r.url === '/api/v1/limits')!.headers.authorization).toBeUndefined();
  });

  it('needs --name to create a listing, and says so before uploading', async () => {
    routes['GET /api/v1/limits'] = () => LIMITS;
    routes['GET /api/v1/publisher/apps'] = () => ({ status: 200, body: { data: [] } });
    const file = writeFile('noname.hap', hapZip('com.example.noname'));
    await expect(publishPackage(new StoreClient(baseUrl, 't'), file, {}, noopLogger)).rejects.toThrow(/--name/);
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('adds a version to an existing app, and warns that listing flags are ignored', async () => {
    routes['GET /api/v1/limits'] = () => LIMITS;
    routes['GET /api/v1/publisher/apps'] = () => ({ status: 200, body: { data: [{ packageName: 'com.example.beta', name: 'Beta' }] } });
    routes['POST /api/v1/publisher/apps/com.example.beta/versions'] = () => ({
      status: 201,
      body: { data: { versionCode: 1000001, status: 'approved', format: 'app', storeSigned: ['entry-default.hap'] } },
    });
    const logger = recordingLogger();
    const file = writeFile('beta.app', appZip('com.example.beta'));

    const result = await publishPackage(new StoreClient(baseUrl, 't'), file, { name: 'Beta', tags: ['x'] }, logger);

    expect(result).toMatchObject({ action: 'version', packageName: 'com.example.beta', versionCode: 1000001, storeSigned: ['entry-default.hap'] });
    expect(logger.warnings.join('\n')).toMatch(/--name, --tags were not applied/);
    const body = requests.find((r) => r.method === 'POST')!.body.toString('latin1');
    expect(body).toContain('name="hap"; filename="beta.app"');
    expect(body).not.toContain('name="name"');
  });

  it('stops before uploading a package over the store\'s limit', async () => {
    routes['GET /api/v1/limits'] = () => ({ status: 200, body: { data: { maxPackageBytes: 10, maxIconBytes: 10 } } });
    const file = writeFile('big.hap', hapZip('com.example.big'));
    await expect(publishPackage(new StoreClient(baseUrl, 't'), file, { name: 'Big' }, noopLogger)).rejects.toThrow(/over the store's/);
    expect(requests.map((r) => r.url)).toEqual(['/api/v1/limits']);
  });

  it('surfaces the store\'s error envelope, and explains a name taken by someone else', async () => {
    routes['GET /api/v1/limits'] = () => LIMITS;
    routes['GET /api/v1/publisher/apps'] = () => ({ status: 200, body: { data: [] } });
    routes['POST /api/v1/publisher/apps'] = () => ({
      status: 409,
      body: { error: { code: 'PACKAGE_NAME_TAKEN', message: 'Package "com.example.taken" is already published' } },
    });
    const file = writeFile('taken.hap', hapZip('com.example.taken'));
    const err = await publishPackage(new StoreClient(baseUrl, 't'), file, { name: 'Taken' }, noopLogger).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreApiError);
    expect((err as StoreApiError).message).toBe('The store answered 409 PACKAGE_NAME_TAKEN: com.example.taken is already published by another publisher.');

    routes['POST /api/v1/publisher/apps'] = () => ({
      status: 422,
      body: { error: { code: 'UNSIGNED_PACKAGE', message: 'Not signed: entry-default.hap.' } },
    });
    await expect(publishPackage(new StoreClient(baseUrl, 't'), file, { name: 'Taken' }, noopLogger)).rejects.toThrow(
      'The store answered 422 UNSIGNED_PACKAGE: Not signed: entry-default.hap.',
    );

    // Two runs of the same publisher racing: the name was taken by the other run.
    let listed = 0;
    routes['GET /api/v1/publisher/apps'] = () => ({
      status: 200,
      body: { data: listed++ === 0 ? [] : [{ packageName: 'com.example.taken', name: 'Taken' }] },
    });
    routes['POST /api/v1/publisher/apps'] = () => ({
      status: 409,
      body: { error: { code: 'PACKAGE_NAME_TAKEN', message: 'Package "com.example.taken" is already published' } },
    });
    await expect(publishPackage(new StoreClient(baseUrl, 't'), file, { name: 'Taken' }, noopLogger)).rejects.toThrow(
      /com\.example\.taken was just created by another publish of yours\. Publish again/,
    );
  });

  it('never echoes the token in a network error, and says a POST may have gone through on a timeout', async () => {
    const token = 'oas_secret-token-value';
    const leaky: FetchFn = async () => {
      throw new TypeError(`Headers.append: "Bearer ${token}" is an invalid header value.`);
    };
    const err = (await new StoreClient(baseUrl, token, leaky).me().catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^Could not reach the store at .*\[redacted\]/);
    expect(err.message).not.toContain(token);

    const headersTimeout: FetchFn = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    };
    const body = buildRegisterBody('acme/app', 'v1', asset(), PACKAGE_SHA);
    await expect(new StoreClient(baseUrl, token, headersTimeout).registerRelease(body)).rejects.toThrow(
      /^The store at .* did not answer in time\. It may still have completed the request/,
    );
  });

  it('points a 401 at a new token', async () => {
    routes['GET /api/v1/auth/me'] = () => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } } });
    await expect(new StoreClient(baseUrl, 'oas_revoked').me()).rejects.toThrow(/401 UNAUTHORIZED: Authentication required\nThe token is invalid, expired or revoked/);
  });
});

// ---------------------------------------------------------------------------
// GitHub releases: a fake fetch answering by URL.
// ---------------------------------------------------------------------------

function fakeFetch(answers: Record<string, () => Response>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const answer = answers[url];
    return answer ? answer() : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const PACKAGE = Buffer.from('the package bytes');
const PACKAGE_SHA = createHash('sha256').update(PACKAGE).digest('hex');
const RELEASE_URL = 'https://api.github.com/repos/acme/app/releases/tags/v1.2.0';

function asset(overrides: Partial<GithubAsset> = {}): GithubAsset {
  return {
    id: 4242,
    name: 'app.app',
    size: PACKAGE.length,
    state: 'uploaded',
    digest: null,
    browser_download_url: 'https://github.com/acme/app/releases/download/v1.2.0/app.app',
    ...overrides,
  };
}

describe('store register-release', () => {
  it('finds the asset by name or id', async () => {
    const f = fakeFetch({ [RELEASE_URL]: json({ id: 7, tag_name: 'v1.2.0', draft: false, assets: [asset()] }) });
    expect((await resolveReleaseAsset({ repo: 'acme/app', tag: 'v1.2.0', asset: 'app.app', fetchImpl: f })).asset.id).toBe(4242);
    expect((await resolveReleaseAsset({ repo: 'acme/app', tag: 'v1.2.0', asset: '4242', fetchImpl: f })).asset.name).toBe('app.app');
  });

  it('pages through the asset list when the release does not embed it', async () => {
    const f = fakeFetch({
      [RELEASE_URL]: json({ id: 7, tag_name: 'v1.2.0', draft: false, assets: [] }),
      'https://api.github.com/repos/acme/app/releases/7/assets?per_page=100&page=1': json([asset({ id: 9, name: 'other.app' }), asset()]),
    });
    expect((await resolveReleaseAsset({ repo: 'acme/app', tag: 'v1.2.0', asset: 'app.app', fetchImpl: f })).asset.id).toBe(4242);
  });

  it('rejects drafts, unknown tags and missing assets', async () => {
    const draft = fakeFetch({ [RELEASE_URL]: json({ id: 7, tag_name: 'v1.2.0', draft: true, assets: [asset()] }) });
    await expect(resolveReleaseAsset({ repo: 'acme/app', tag: 'v1.2.0', asset: 'app.app', fetchImpl: draft })).rejects.toThrow(/draft/);
    await expect(resolveReleaseAsset({ repo: 'acme/app', tag: 'v1.2.0', asset: 'app.app', fetchImpl: fakeFetch({}) })).rejects.toThrow(
      /No release tagged v1\.2\.0 in acme\/app/,
    );
    const f = fakeFetch({
      [RELEASE_URL]: json({ id: 7, tag_name: 'v1.2.0', draft: false, assets: [asset()] }),
      'https://api.github.com/repos/acme/app/releases/7/assets?per_page=100&page=1': json([asset()]),
    });
    await expect(resolveReleaseAsset({ repo: 'acme/app', tag: 'v1.2.0', asset: 'nope.app', fetchImpl: f })).rejects.toThrow(
      /has no asset nope\.app\. Its assets: app\.app \(4242\)/,
    );
    await expect(resolveReleaseAsset({ repo: 'not-a-repo', tag: 'v1', asset: 'x', fetchImpl: f })).rejects.toThrow(/owner\/name/);
  });

  it('uses GitHub\'s digest without downloading, else hashes a download or a local copy', async () => {
    const noDownload = fakeFetch({});
    const digest = 'a'.repeat(64);
    expect(await assetSha256(asset({ digest: `sha256:${digest}` }), { fetchImpl: noDownload })).toBe(digest);
    expect(noDownload.calls).toEqual([]);

    const download = fakeFetch({ [asset().browser_download_url]: () => new Response(PACKAGE) });
    expect(await assetSha256(asset(), { fetchImpl: download })).toBe(PACKAGE_SHA);

    const short = fakeFetch({ [asset().browser_download_url]: () => new Response(PACKAGE.subarray(1)) });
    await expect(assetSha256(asset(), { fetchImpl: short })).rejects.toThrow(/Downloaded \d+ bytes/);

    const local = writeFile('local.app', PACKAGE);
    expect(await assetSha256(asset(), { localFile: local })).toBe(PACKAGE_SHA);
    await expect(assetSha256(asset({ digest: `sha256:${digest}` }), { localFile: local })).rejects.toThrow(/does not match the asset/);
  });

  it('sends the listing block only when listing flags were given', async () => {
    expect(buildRegisterBody('acme/app', 'v1.2.0', asset(), PACKAGE_SHA)).toEqual({
      repository: 'acme/app',
      tag: 'v1.2.0',
      assetId: 4242,
      sha256: PACKAGE_SHA,
      size: PACKAGE.length,
    });
    expect(buildRegisterBody('acme/app', 'v1.2.0', asset(), PACKAGE_SHA, { name: 'App', tags: ['x'] }).app).toEqual({
      name: 'App',
      tags: ['x'],
    });
  });

  it('posts the registration as JSON and returns the store\'s answer, 200 or 201', async () => {
    const data = {
      packageName: 'com.acme.app',
      versionCode: 1000000,
      versionName: '1.0.0',
      status: 'approved',
      format: 'app',
      hosting: 'github_release',
      buildKind: 'uploaded',
      created: false,
      appCreated: false,
      downloadUrl: `${baseUrl}/api/v1/apps/com.acme.app/versions/1000000/download`,
    };
    routes['POST /api/v1/publisher/releases'] = () => ({ status: 200, body: { data } });
    const body = buildRegisterBody('acme/app', 'v1.2.0', asset(), PACKAGE_SHA, { name: 'App' });
    const answer = await new StoreClient(baseUrl, 'oas_tok').registerRelease(body);
    expect(answer).toEqual({ status: 200, data });
    expect(requests[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(requests[0]!.body.toString('utf8'))).toEqual(body);
  });
});

describe('oniro-app store (binary)', () => {
  const env = { ONIRO_STORE_AUTH_DIR: path.join(tmp, 'cli-auth'), ONIRO_STORE_TOKEN: '', ONIRO_STORE_URL: '' };

  it('lists its subcommands', () => {
    const r = runCli(['store', '--help']);
    expect(r.status).toBe(0);
    for (const cmd of ['login', 'logout', 'whoami', 'publish', 'register-release']) expect(r.stdout).toContain(cmd);
  });

  it('explains how to get a token when there is none', () => {
    const r = runCli(['store', 'whoami', '--url', 'https://store.example.org'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No token for https:\/\/store\.example\.org.*ONIRO_STORE_TOKEN/s);
  });

  it('refuses to send a token over plain http to another host', () => {
    const r = runCli(['store', 'publish', 'x.hap', '--url', 'http://store.example.org'], { ...env, ONIRO_STORE_TOKEN: 'oas_x' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/https/);
  });

  it('logout without a saved token is a no-op', () => {
    const r = runCli(['store', 'logout', '--url', 'https://store.example.org'], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/nothing to do/);
  });
});
