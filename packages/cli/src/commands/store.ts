import { Command, InvalidArgumentError, Option } from 'commander';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { OniroError, readHapBundleName, readZipEntry, type Logger } from '@oniroproject/core';
import { EnvHttpProxyAgent, FormData, fetch as undiciFetch, type Dispatcher } from 'undici';
import { getRuntime } from '../lib/runtime.js';

/** The public Oniro App Store. `--url` or ONIRO_STORE_URL point elsewhere (a staging or local store). */
export const DEFAULT_STORE_URL = 'https://store.iparo.app';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'oniro-app';
const METADATA_TIMEOUT_MS = 30_000;
/** The store downloads, hashes and parses the asset before it answers a release registration. */
const REGISTER_TIMEOUT_MS = 15 * 60_000;

/** What the store commands send: a subset of fetch's RequestInit. */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  signal?: AbortSignal;
}

/** What the store commands read from a response; undici's and the global Response both fit. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  readonly body: unknown;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchFn = (url: string, init: FetchInit) => Promise<FetchResponse>;

let dispatcher: Dispatcher | undefined;

/**
 * undici's fetch through an agent that honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY, which
 * Node's own fetch ignores, and that waits for response headers as long as a release
 * registration may take: Node's default gives up after 5 minutes. undici restarts that
 * wait while the body is being sent, so a slow upload does not count against it.
 */
export const storeFetch: FetchFn = (url, init) => {
  dispatcher ??= new EnvHttpProxyAgent({ headersTimeout: REGISTER_TIMEOUT_MS });
  return undiciFetch(url, { ...init, dispatcher });
};

/** Printable ASCII without spaces: all an HTTP header can carry, and all a token is made of. */
const TOKEN_RE = /^[\x21-\x7e]+$/;

/**
 * Refuse a token a header cannot carry (a stray line break from a secret or a file), naming
 * where it came from but never echoing it: fetch's own error would quote the whole header.
 */
export function checkToken(token: string, origin: string): string {
  if (!TOKEN_RE.test(token)) {
    throw new OniroError(`${origin} contains spaces, line breaks or other characters a token cannot have. Copy the token again.`);
  }
  return token;
}

// ---------------------------------------------------------------------------
// Store URL and credentials
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The store's base URL: `--url`, else ONIRO_STORE_URL, else the public store. Plain
 * http is accepted only for a store on this machine, since every request carries a token.
 */
export function resolveStoreUrl(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const raw = (flag || env.ONIRO_STORE_URL || DEFAULT_STORE_URL).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OniroError(`"${raw}" is not a valid store URL.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new OniroError(
      `Refusing to talk to ${url.origin}: the store must be reached over https (plain http only for localhost), ` +
        'since every request carries a token.',
    );
  }
  if (url.search || url.hash) throw new OniroError(`The store URL ${raw} must not have a query or fragment.`);
  return url.toString().replace(/\/+$/, '');
}

interface StoredStore {
  token: string;
  githubLogin: string | null;
  savedAt: string;
}

interface CredentialsFile {
  version: 1;
  /** Keyed by store base URL, so a token is only ever sent to the store that issued it. */
  stores: Record<string, StoredStore>;
}

/** Where `store login` keeps tokens: ONIRO_STORE_AUTH_DIR, default ~/.oniro/store. */
export function storeAuthDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ONIRO_STORE_AUTH_DIR || path.join(os.homedir(), '.oniro', 'store');
}

export function storeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(storeAuthDir(env), 'credentials.json');
}

function readCredentials(env: NodeJS.ProcessEnv): CredentialsFile {
  const file = storeCredentialsPath(env);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, stores: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as Partial<CredentialsFile>;
    return { version: 1, stores: parsed.stores && typeof parsed.stores === 'object' ? parsed.stores : {} };
  } catch {
    throw new OniroError(`${file} is not valid JSON. Delete it and run \`oniro-app store login\` again.`);
  }
}

function writeCredentials(creds: CredentialsFile, env: NodeJS.ProcessEnv): void {
  const file = storeCredentialsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Written beside the target and renamed over it, created 0600 so the token is never world-readable.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function saveStoreToken(
  storeUrl: string,
  token: string,
  githubLogin: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const creds = readCredentials(env);
  creds.stores[storeUrl] = { token, githubLogin, savedAt: new Date().toISOString() };
  writeCredentials(creds, env);
  return storeCredentialsPath(env);
}

/** Forget the token stored for a store. False when there was none. */
export function removeStoreToken(storeUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const creds = readCredentials(env);
  if (!creds.stores[storeUrl]) return false;
  delete creds.stores[storeUrl];
  writeCredentials(creds, env);
  return true;
}

export interface ResolvedToken {
  token: string;
  source: 'env' | 'file';
}

/** ONIRO_STORE_TOKEN wins; otherwise the token `store login` saved for this store. */
export function resolveStoreToken(storeUrl: string, env: NodeJS.ProcessEnv = process.env): ResolvedToken {
  const fromEnv = env.ONIRO_STORE_TOKEN?.trim();
  if (fromEnv) return { token: checkToken(fromEnv, 'ONIRO_STORE_TOKEN'), source: 'env' };
  const stored = readCredentials(env).stores[storeUrl];
  if (stored?.token) {
    return { token: checkToken(stored.token, `The token saved in ${storeCredentialsPath(env)}`), source: 'file' };
  }
  throw new OniroError(
    `No token for ${storeUrl}. Create an API token at ${storeUrl}/publisher/tokens, then either ` +
      'set ONIRO_STORE_TOKEN or run `oniro-app store login --token <token>`.',
  );
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** A request the store answered with an error envelope `{ error: { code, message } }`. */
export class StoreApiError extends OniroError {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    hint?: string,
  ) {
    super(`The store answered ${status} ${code}: ${detail}${hint ? `\n${hint}` : ''}`);
    this.name = 'StoreApiError';
  }
}

async function readBody(res: FetchResponse): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/**
 * A request that got no answer. `secrets` are cut out of the underlying error's text, which
 * can quote a header; `sentWork` adds that a request the store may have acted on could
 * have gone through.
 */
function networkError(
  target: string,
  err: unknown,
  opts: { secrets?: Array<string | undefined>; sentWork?: boolean } = {},
): OniroError {
  const inner = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const code = inner && typeof inner === 'object' ? (inner as { code?: unknown }).code : undefined;
  const timedOut =
    (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
    (typeof code === 'string' && TIMEOUT_CODES.has(code));
  if (timedOut) {
    return new OniroError(
      `${target.charAt(0).toUpperCase()}${target.slice(1)} did not answer in time.` +
        (opts.sentWork ? ' It may still have completed the request: check before retrying.' : ''),
      err,
    );
  }
  let cause = inner instanceof Error ? inner.message : err instanceof Error ? err.message : '';
  for (const secret of opts.secrets ?? []) if (secret) cause = cause.split(secret).join('[redacted]');
  return new OniroError(
    `Could not reach ${target}${cause ? `: ${cause}` : ''}. ` +
      'Check the network connection and any proxy configuration (HTTPS_PROXY / HTTP_PROXY).',
    err,
  );
}

export interface StoreProfile {
  id: string;
  githubLogin: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: string;
}

export interface OwnApp {
  packageName: string;
  name: string;
}

export interface CreatedApp {
  packageName: string;
  versionCode: number;
  /** `approved`, or `pending` on a store that reviews new apps: then it is not listed yet. */
  status: string;
  storeSigned: string[];
}

export interface AddedVersion {
  versionCode: number;
  status: string;
  format: string;
  storeSigned: string[];
}

export interface RegisterReleaseBody {
  repository: string;
  tag: string;
  assetId: number;
  sha256: string;
  size: number;
  app?: { name?: string; description?: string; category?: string; tags?: string[] };
}

export interface RegisteredRelease {
  packageName: string;
  versionCode: number;
  versionName: string;
  status: string;
  format: string;
  hosting: string;
  buildKind: string;
  created: boolean;
  appCreated: boolean;
  downloadUrl: string;
}

export interface StoreLimits {
  maxPackageBytes: number;
  maxIconBytes: number;
}

/** The publisher API of one store, authenticated with one token. */
export class StoreClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchFn = storeFetch,
  ) {}

  private async request<T>(
    method: string,
    apiPath: string,
    opts: { body?: FormData | string; json?: boolean; timeoutMs?: number; auth?: boolean } = {},
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT };
    if (opts.auth !== false) headers.authorization = `Bearer ${this.token}`;
    if (opts.json) headers['content-type'] = 'application/json';
    let res: FetchResponse;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/v1${apiPath}`, {
        method,
        headers,
        body: opts.body,
        signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      });
    } catch (err) {
      throw networkError(`the store at ${this.baseUrl}`, err, { secrets: [this.token], sentWork: method !== 'GET' });
    }
    const body = await readBody(res);
    if (!res.ok) {
      const envelope = body && typeof body === 'object' && 'error' in body ? (body as { error?: unknown }).error : null;
      const error = envelope && typeof envelope === 'object' ? (envelope as { code?: unknown; message?: unknown }) : {};
      const code = typeof error.code === 'string' ? error.code : `HTTP_${res.status}`;
      const message =
        typeof error.message === 'string'
          ? error.message
          : typeof body === 'string' && body
            ? body.slice(0, 300)
            : res.statusText || 'request failed';
      const hint =
        res.status === 401
          ? `The token is invalid, expired or revoked. Create a new one at ${this.baseUrl}/publisher/tokens and run ` +
            '`oniro-app store login --token <token>` (or update ONIRO_STORE_TOKEN).'
          : undefined;
      throw new StoreApiError(res.status, code, message, hint);
    }
    const data = body && typeof body === 'object' && 'data' in body ? (body as { data: T }).data : (body as T);
    return { status: res.status, data };
  }

  async me(): Promise<StoreProfile> {
    return (await this.request<StoreProfile>('GET', '/auth/me', { timeoutMs: METADATA_TIMEOUT_MS })).data;
  }

  async ownApps(): Promise<OwnApp[]> {
    return (await this.request<OwnApp[]>('GET', '/publisher/apps', { timeoutMs: METADATA_TIMEOUT_MS })).data;
  }

  /** The ceilings the store enforces; null when it does not say (an older store). */
  async limits(): Promise<StoreLimits | null> {
    try {
      return (await this.request<StoreLimits>('GET', '/limits', { timeoutMs: METADATA_TIMEOUT_MS, auth: false })).data;
    } catch {
      return null;
    }
  }

  async createApp(form: FormData): Promise<CreatedApp> {
    return (await this.request<CreatedApp>('POST', '/publisher/apps', { body: form })).data;
  }

  async addVersion(packageName: string, form: FormData): Promise<AddedVersion> {
    return (await this.request<AddedVersion>('POST', `/publisher/apps/${encodeURIComponent(packageName)}/versions`, { body: form })).data;
  }

  async registerRelease(body: RegisterReleaseBody): Promise<{ status: number; data: RegisteredRelease }> {
    return this.request<RegisteredRelease>('POST', '/publisher/releases', {
      body: JSON.stringify(body),
      json: true,
      timeoutMs: REGISTER_TIMEOUT_MS,
    });
  }
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

export interface PackageIdentity {
  /** Lowercased, as the store keys packages. */
  bundleName: string;
  format: 'hap' | 'app';
}

/**
 * The bundle a package publishes as: `app.bundleName` of a .hap's module.json (or FA
 * config.json), else `summary.app.bundleName` of an .app bundle's pack.info. Checked
 * in that order because a HAP built into an .app also carries a copy of pack.info.
 */
export async function readPackageIdentity(file: string): Promise<PackageIdentity> {
  if (!fs.existsSync(file)) throw new OniroError(`${file} does not exist.`);
  if (!fs.statSync(file).isFile()) throw new OniroError(`${file} is not a file.`);
  try {
    const hapName = await readHapBundleName(file);
    if (hapName) return { bundleName: hapName.toLowerCase(), format: 'hap' };
    const packInfo = await readZipEntry(file, (n) => n === 'pack.info');
    if (packInfo) {
      let parsed: { summary?: { app?: { bundleName?: unknown } } };
      try {
        parsed = JSON.parse(packInfo.toString('utf8').replace(/^﻿/, ''));
      } catch {
        throw new OniroError(`The pack.info in ${file} is not valid JSON.`);
      }
      const name = parsed.summary?.app?.bundleName;
      if (typeof name !== 'string' || !name) throw new OniroError(`The pack.info in ${file} names no summary.app.bundleName.`);
      return { bundleName: name.toLowerCase(), format: 'app' };
    }
  } catch (err) {
    if (err instanceof OniroError) throw err;
    throw new OniroError(`${file} is not a .hap or .app package: ${(err as Error).message}`, err);
  }
  throw new OniroError(`${file} has no module.json, config.json or pack.info: it is not a .hap or .app package.`);
}

export interface PublishFields {
  name?: string;
  description?: string;
  category?: 'app' | 'game';
  tags?: string[];
  vendor?: string;
  sourceUrl?: string;
  /** PNG; only used when the app is created. */
  icon?: string;
}

export type PublishResult =
  | ({ action: 'created'; url: string } & CreatedApp)
  | ({ action: 'version'; url: string; packageName: string } & AddedVersion);

/** Flags that only describe a new listing, by the name the user typed them. */
const LISTING_FLAGS: Array<[keyof PublishFields, string]> = [
  ['name', '--name'],
  ['description', '--description'],
  ['category', '--category'],
  ['tags', '--tags'],
  ['vendor', '--vendor'],
  ['sourceUrl', '--source-url'],
  ['icon', '--icon'],
];

async function fileBlob(file: string, type: string): Promise<Blob> {
  return fs.openAsBlob(file, { type });
}

/**
 * Publish a package: create the app when the store does not list it among the
 * publisher's own apps yet, else add the package as a new version of it.
 */
export async function publishPackage(
  client: StoreClient,
  file: string,
  fields: PublishFields,
  logger: Logger,
): Promise<PublishResult> {
  const { bundleName, format } = await readPackageIdentity(file);
  const size = fs.statSync(file).size;
  if (fields.icon && !fs.existsSync(fields.icon)) throw new OniroError(`${fields.icon} does not exist.`);

  const limits = await client.limits();
  if (limits && size > limits.maxPackageBytes) {
    throw new OniroError(
      `${file} is ${formatMb(size)}, over the store's ${formatMb(limits.maxPackageBytes)} limit for a package.`,
    );
  }

  const own = await client.ownApps();
  const exists = own.some((a) => a.packageName === bundleName);
  const url = `${client.baseUrl}/apps/${bundleName}`;
  const form = new FormData();

  if (exists) {
    const ignored = LISTING_FLAGS.filter(([key]) => fields[key] !== undefined).map(([, flag]) => flag);
    if (ignored.length > 0) {
      logger.warn(
        `${bundleName} is already in the store, so ${ignored.join(', ')} ${ignored.length > 1 ? 'were' : 'was'} not applied: ` +
          `they describe a new listing. Edit the listing on ${client.baseUrl}/publisher/${bundleName}.`,
      );
    }
    form.append('hap', await fileBlob(file, 'application/octet-stream'), path.basename(file));
    logger.info(`Uploading ${path.basename(file)} (${formatMb(size)}) as a new version of ${bundleName}...`);
    const added = await client.addVersion(bundleName, form);
    return { action: 'version', url, packageName: bundleName, ...added };
  }

  if (!fields.name) {
    throw new OniroError(
      `${bundleName} is not in the store yet, so this publish creates its listing: pass --name <display name> ` +
        '(and ideally --description, --category and --tags).',
    );
  }
  form.append('name', fields.name);
  if (fields.description !== undefined) form.append('description', fields.description);
  if (fields.category) form.append('category', fields.category);
  if (fields.tags && fields.tags.length > 0) form.append('tags', fields.tags.join(','));
  if (fields.vendor) form.append('vendor', fields.vendor);
  if (fields.sourceUrl) form.append('sourceUrl', fields.sourceUrl);
  form.append('hap', await fileBlob(file, 'application/octet-stream'), path.basename(file));
  if (fields.icon) form.append('icon', await fileBlob(fields.icon, 'image/png'), path.basename(fields.icon));

  logger.info(`Uploading ${path.basename(file)} (${formatMb(size)}, .${format}) as the new app ${bundleName}...`);
  try {
    const created = await client.createApp(form);
    return { action: 'created', url, ...created };
  } catch (err) {
    if (err instanceof StoreApiError && err.code === 'PACKAGE_NAME_TAKEN') {
      // It was not among this publisher's apps a moment ago: either another publisher has it,
      // or a concurrent publish of this publisher's (two CI jobs) created it in between.
      const ownNow = await client.ownApps().catch((): OwnApp[] => []);
      const detail = ownNow.some((a) => a.packageName === bundleName)
        ? `${bundleName} was just created by another publish of yours. Publish again to add this package as a new version.`
        : `${bundleName} is already published by another publisher.`;
      throw new StoreApiError(err.status, err.code, detail);
    }
    throw err;
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// GitHub releases
// ---------------------------------------------------------------------------

export interface GithubAsset {
  id: number;
  name: string;
  size: number;
  state?: string;
  /** `sha256:<hex>`, set by GitHub on assets uploaded since mid-2025. */
  digest?: string | null;
  browser_download_url: string;
}

export interface GithubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  html_url?: string;
  assets: GithubAsset[];
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function githubHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubGet<T>(apiPath: string, token: string | undefined, fetchImpl: FetchFn, notFound: string): Promise<T> {
  let res: FetchResponse;
  try {
    res = await fetchImpl(`${GITHUB_API}${apiPath}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  } catch (err) {
    throw networkError('the GitHub API', err, { secrets: [token] });
  }
  if (res.status === 404) throw new OniroError(notFound);
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new OniroError('GitHub API rate limit reached. Set GITHUB_TOKEN (or GH_TOKEN) to raise it, then retry.');
  }
  if (!res.ok) {
    const body = await readBody(res);
    const message = body && typeof body === 'object' && 'message' in body ? String((body as { message: unknown }).message) : res.statusText;
    throw new OniroError(`GitHub API ${apiPath} answered ${res.status}: ${message}`);
  }
  return (await res.json()) as T;
}

/** Find a release asset by file name or numeric id. Drafts and unfinished uploads are rejected. */
export async function resolveReleaseAsset(opts: {
  repo: string;
  tag: string;
  asset: string;
  githubToken?: string;
  fetchImpl?: FetchFn;
}): Promise<{ release: GithubRelease; asset: GithubAsset }> {
  const fetchImpl = opts.fetchImpl ?? storeFetch;
  if (!REPO_RE.test(opts.repo)) throw new OniroError(`--repo must be owner/name, got "${opts.repo}".`);
  const release = await githubGet<GithubRelease>(
    `/repos/${opts.repo}/releases/tags/${encodeURIComponent(opts.tag)}`,
    opts.githubToken,
    fetchImpl,
    `No release tagged ${opts.tag} in ${opts.repo}. (A private repository needs GITHUB_TOKEN, but devices can only ` +
      'download assets of a public one.)',
  );
  if (release.draft) {
    throw new OniroError(`The release ${opts.tag} of ${opts.repo} is a draft, whose assets devices cannot download. Publish it first.`);
  }
  const byId = /^\d+$/.test(opts.asset) ? Number(opts.asset) : null;
  const matches = (a: GithubAsset) => (byId !== null ? a.id === byId : a.name === opts.asset);
  let asset = (release.assets ?? []).find(matches);
  // The embedded list may be truncated on releases with many assets; page through the full one.
  for (let page = 1; !asset && page <= 10; page++) {
    const batch = await githubGet<GithubAsset[]>(
      `/repos/${opts.repo}/releases/${release.id}/assets?per_page=100&page=${page}`,
      opts.githubToken,
      fetchImpl,
      `The release ${opts.tag} of ${opts.repo} has no asset list.`,
    );
    asset = batch.find(matches);
    if (batch.length < 100) break;
  }
  if (!asset) {
    const names = (release.assets ?? []).map((a) => `${a.name} (${a.id})`).join(', ') || 'none';
    throw new OniroError(`The release ${opts.tag} of ${opts.repo} has no asset ${opts.asset}. Its assets: ${names}.`);
  }
  if (asset.state && asset.state !== 'uploaded') {
    throw new OniroError(`The asset ${asset.name} is still being uploaded (state ${asset.state}); retry once it finishes.`);
  }
  return { release, asset };
}

const DIGEST_RE = /^sha256:([0-9a-f]{64})$/i;

/** The sha256 GitHub recorded for an asset, or null when it recorded none. */
export function digestSha256(asset: GithubAsset): string | null {
  const m = asset.digest ? DIGEST_RE.exec(asset.digest) : null;
  return m ? m[1]!.toLowerCase() : null;
}

async function hashStream(stream: Readable): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    size += chunk.length;
  });
  await pipeline(stream, hash);
  return { sha256: hash.digest('hex'), size };
}

/**
 * The sha256 of a release asset: of `localFile` when given (a copy of the asset, checked
 * against GitHub's digest when there is one), else GitHub's own digest, else of the
 * asset downloaded from its public URL.
 */
export async function assetSha256(
  asset: GithubAsset,
  opts: { localFile?: string; fetchImpl?: FetchFn; logger?: Logger } = {},
): Promise<string> {
  const digest = digestSha256(asset);
  if (opts.localFile) {
    if (!fs.existsSync(opts.localFile)) throw new OniroError(`${opts.localFile} does not exist.`);
    const { sha256, size } = await hashStream(fs.createReadStream(opts.localFile));
    if (size !== asset.size) {
      throw new OniroError(`${opts.localFile} is ${size} bytes but the asset ${asset.name} is ${asset.size}: not the same file.`);
    }
    if (digest && digest !== sha256) {
      throw new OniroError(`${opts.localFile} does not match the asset ${asset.name} (GitHub's sha256 is ${digest}).`);
    }
    return sha256;
  }
  if (digest) return digest;

  opts.logger?.info(`GitHub records no digest for ${asset.name}; downloading it (${formatMb(asset.size)}) to hash it...`);
  const fetchImpl = opts.fetchImpl ?? storeFetch;
  let res: FetchResponse;
  try {
    // fetch follows the redirect to GitHub's asset host by default.
    res = await fetchImpl(asset.browser_download_url, { headers: { 'user-agent': USER_AGENT } });
  } catch (err) {
    throw networkError(asset.browser_download_url, err);
  }
  if (!res.ok || !res.body) {
    throw new OniroError(`Downloading ${asset.browser_download_url} failed with ${res.status}.`);
  }
  const { sha256, size } = await hashStream(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>));
  if (size !== asset.size) {
    throw new OniroError(`Downloaded ${size} bytes of ${asset.name}, but GitHub lists it as ${asset.size}.`);
  }
  return sha256;
}

export interface ListingFlags {
  name?: string;
  description?: string;
  category?: 'app' | 'game';
  tags?: string[];
}

export function buildRegisterBody(
  repo: string,
  tag: string,
  asset: GithubAsset,
  sha256: string,
  listing: ListingFlags = {},
): RegisterReleaseBody {
  const body: RegisterReleaseBody = { repository: repo, tag, assetId: asset.id, sha256, size: asset.size };
  const app: NonNullable<RegisterReleaseBody['app']> = {};
  if (listing.name !== undefined) app.name = listing.name;
  if (listing.description !== undefined) app.description = listing.description;
  if (listing.category !== undefined) app.category = listing.category;
  if (listing.tags !== undefined) app.tags = listing.tags;
  if (Object.keys(app).length > 0) body.app = app;
  return body;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseRepo(value: string): string {
  if (!REPO_RE.test(value)) throw new InvalidArgumentError('expected owner/name.');
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

const urlOption = () =>
  new Option('--url <url>', `Store base URL (default: ONIRO_STORE_URL, else ${DEFAULT_STORE_URL}).`);
const categoryOption = () =>
  new Option('--category <category>', 'Catalog category of a new listing.').choices(['app', 'game']);

function client(urlFlag: string | undefined): { client: StoreClient; source: ResolvedToken['source'] } {
  const storeUrl = resolveStoreUrl(urlFlag);
  const { token, source } = resolveStoreToken(storeUrl);
  return { client: new StoreClient(storeUrl, token), source };
}

function describeProfile(p: StoreProfile): string {
  return p.githubLogin ? `${p.displayName} (@${p.githubLogin})` : p.displayName;
}

export function registerStoreCommand(program: Command): void {
  const store = program
    .command('store')
    .description(
      'Publish apps to the Oniro App Store from a terminal or CI job. Authenticates with an API token created on ' +
        'the store website: ONIRO_STORE_TOKEN, else the one `store login` saved. The store is ONIRO_STORE_URL ' +
        `or --url, default ${DEFAULT_STORE_URL}.`,
    );

  store
    .command('login')
    .description(
      'Check an API token against the store and save it for later commands, in ONIRO_STORE_AUTH_DIR ' +
        '(default ~/.oniro/store, file mode 0600). Prints the publisher it belongs to.',
    )
    .requiredOption('--token <token>', 'The API token (oas_...), or - to read it from stdin.')
    .addOption(urlOption())
    .option('--json', 'Print the publisher profile as JSON.')
    .action(async (opts: { token: string; url?: string; json?: boolean }) => {
      const { logger } = getRuntime();
      const storeUrl = resolveStoreUrl(opts.url);
      const token = (opts.token === '-' ? await readStdin() : opts.token).trim();
      if (!token) throw new OniroError('The token is empty.');
      checkToken(token, 'The token');
      if (!token.startsWith('oas_')) {
        logger.warn('This is not an API token (they start with oas_): a browser session token expires within a day.');
      }
      const profile = await new StoreClient(storeUrl, token).me();
      const file = saveStoreToken(storeUrl, token, profile.githubLogin);
      logger.info(`Signed in to ${storeUrl}; the token is stored in ${file}.`);
      if (process.env.ONIRO_STORE_TOKEN?.trim()) {
        logger.warn('ONIRO_STORE_TOKEN is set, so later commands use it instead of the token just saved. Unset it to use this one.');
      }
      process.stdout.write(opts.json ? `${JSON.stringify({ ...profile, url: storeUrl }, null, 2)}\n` : `${describeProfile(profile)}\n`);
    });

  store
    .command('logout')
    .description('Delete the token saved for the store. It keeps working until it expires: revoke it on the store website.')
    .addOption(urlOption())
    .action((opts: { url?: string }) => {
      const { logger } = getRuntime();
      const storeUrl = resolveStoreUrl(opts.url);
      const removed = removeStoreToken(storeUrl);
      logger.info(
        removed
          ? `Signed out of ${storeUrl}. The token still works until it expires or you revoke it at ${storeUrl}/publisher/tokens.`
          : `No token saved for ${storeUrl}; nothing to do.`,
      );
      if (process.env.ONIRO_STORE_TOKEN?.trim()) {
        logger.warn('ONIRO_STORE_TOKEN is still set, so commands keep authenticating with it. Unset it to sign out completely.');
      }
    });

  store
    .command('whoami')
    .description('Print the publisher the token belongs to. Exits non-zero without a valid token.')
    .addOption(urlOption())
    .option('--json', 'Emit the profile as JSON, with the store URL and where the token came from (env or file).')
    .action(async (opts: { url?: string; json?: boolean }) => {
      const { client: c, source } = client(opts.url);
      const profile = await c.me();
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ...profile, url: c.baseUrl, tokenSource: source }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${describeProfile(profile)} [${profile.role}]\n`);
      getRuntime().logger.info(`Store ${c.baseUrl}, token from ${source === 'env' ? 'ONIRO_STORE_TOKEN' : storeCredentialsPath()}.`);
    });

  store
    .command('publish <package>')
    .description(
      'Upload a signed .hap or .app. The first publish of a bundle name creates its listing and needs --name; ' +
        'after that the package is added as a new version (its versionCode must be higher than the last one), and ' +
        'the listing flags are ignored. Prints the store page URL. Unsigned modules are rejected, or signed by the ' +
        'store when it is set up to.',
    )
    .addOption(urlOption())
    .option('--name <name>', 'Display name of a new listing (required on the first publish).')
    .option('--description <text>', 'Description of a new listing.')
    .addOption(categoryOption())
    .option('--tags <list>', 'Comma-separated tags of a new listing, at most 10.', parseList)
    .option('--icon <png>', 'Icon of a new listing (PNG). Default: the icon inside the package.')
    .option('--vendor <vendor>', 'Vendor of a new listing. Default: the package\'s vendor.')
    .option('--source-url <url>', 'Source code URL of a new listing.')
    .option('--json', 'Print the result as JSON: action (created or version), packageName, url, and versionCode/status/format or storeSigned.')
    .action(
      async (
        file: string,
        opts: PublishFields & { url?: string; json?: boolean },
      ) => {
        const { logger } = getRuntime();
        const { client: c } = client(opts.url);
        const result = await publishPackage(
          c,
          path.resolve(file),
          {
            name: opts.name,
            description: opts.description,
            category: opts.category,
            tags: opts.tags,
            vendor: opts.vendor,
            sourceUrl: opts.sourceUrl,
            icon: opts.icon,
          },
          logger,
        );
        if (result.storeSigned.length > 0) {
          logger.warn(`The store signed these unsigned modules with the public OpenHarmony key: ${result.storeSigned.join(', ')}.`);
        }
        if (result.action === 'created') {
          logger.info(
            `Created ${result.packageName}` +
              (!result.status || result.status === 'approved'
                ? '.'
                : `; it is ${result.status}, and not listed until a store admin reviews it.`),
          );
        } else {
          logger.info(
            `Added version code ${result.versionCode} (.${result.format}) to ${result.packageName}` +
              (result.status === 'approved' ? '.' : `; it is ${result.status} until a store admin reviews it.`),
          );
        }
        process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.url}\n`);
      },
    );

  store
    .command('register-release')
    .description(
      'Publish a package that stays hosted on a public GitHub release: the store downloads the asset once to check ' +
        'it (parse, signature, sha256) and then sends devices to GitHub for it. The asset is found by file name or ' +
        'numeric id; its sha256 is GitHub\'s digest, else that of --file, else of a download. A new bundle name ' +
        'creates its listing from the listing flags; registering the same asset again is a no-op.',
    )
    .addOption(urlOption())
    .requiredOption('--repo <owner/name>', 'GitHub repository holding the release.', parseRepo)
    .requiredOption('--tag <tag>', 'Tag of the release.')
    .requiredOption('--asset <name|id>', 'Asset file name, or its numeric id.')
    .option('--file <path>', 'A local copy of the asset to hash instead of downloading it (must be the same bytes).')
    .option('--name <name>', 'Display name of a new listing.')
    .option('--description <text>', 'Description of a new listing.')
    .addOption(categoryOption())
    .option('--tags <list>', 'Comma-separated tags of a new listing.', parseList)
    .option('--json', 'Print the store\'s answer as JSON, with the store page url.')
    .action(
      async (opts: {
        url?: string;
        repo: string;
        tag: string;
        asset: string;
        file?: string;
        name?: string;
        description?: string;
        category?: 'app' | 'game';
        tags?: string[];
        json?: boolean;
      }) => {
        const { logger } = getRuntime();
        const { client: c } = client(opts.url);
        const githubVar = process.env.GITHUB_TOKEN?.trim() ? 'GITHUB_TOKEN' : process.env.GH_TOKEN?.trim() ? 'GH_TOKEN' : null;
        const githubToken = githubVar ? checkToken(process.env[githubVar]!.trim(), githubVar) : undefined;
        const { asset } = await resolveReleaseAsset({ repo: opts.repo, tag: opts.tag, asset: opts.asset, githubToken });
        const sha256 = await assetSha256(asset, { localFile: opts.file, logger });
        const body = buildRegisterBody(opts.repo, opts.tag, asset, sha256, {
          name: opts.name,
          description: opts.description,
          category: opts.category,
          tags: opts.tags,
        });
        logger.info(`Registering ${asset.name} (${formatMb(asset.size)}, sha256 ${sha256.slice(0, 12)}…) from ${opts.repo}@${opts.tag}...`);
        const { data } = await c.registerRelease(body);
        const url = `${c.baseUrl}/apps/${data.packageName}`;
        logger.info(
          data.created
            ? `Registered ${data.packageName} ${data.versionName} (${data.versionCode})` +
                `${data.appCreated ? ' as a new app' : ''}: ${data.status}.`
            : `${asset.name} was already registered as ${data.packageName} ${data.versionName} (${data.versionCode}).`,
        );
        process.stdout.write(opts.json ? `${JSON.stringify({ ...data, url }, null, 2)}\n` : `${url}\n`);
      },
    );
}
