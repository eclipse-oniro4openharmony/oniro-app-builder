import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import type { ProgressReporter } from '../ports/progress.js';
import { noopProgress } from '../ports/progress.js';
import { CancelledError, OniroError } from '../ports/errors.js';
import { runProcess, type HdcExecResult } from '../hdc/exec.js';
import { listDevices } from '../hdc/devices.js';
import { getCmdToolsPath } from '../sdk/paths.js';
import { apiOfDottedVersion } from '../sdk/apiVersion.js';
import { probeEmulatorBoot } from '../emulator/pool.js';
import { findHarmonyOsSdk } from './sdk.js';

/**
 * The HarmonyOS emulator: Huawei's `Emulator` binary, which the HarmonyOS command-line
 * tools ship in `emulator/` from 26.0.0 on Linux. oniro-app drives its command line;
 * the images it downloads and the devices (instances) it creates stay where Huawei
 * keeps them (`Emulator -config`). Verified with Emulator 26.0.0.400 on Linux.
 */

/** Where {@link findHarmonyOsEmulator} found the emulator. */
export type HarmonyOsEmulatorSource = 'configured' | 'cmdtools' | 'harmonyos-sdk';

export interface HarmonyOsEmulator {
  /** The `Emulator` executable. */
  binary: string;
  /** Its directory, holding `agreement/` and `sdk-pkg.json`. */
  dir: string;
  /** From `sdk-pkg.json`, e.g. `26.0.0.400`. */
  version?: string;
  source: HarmonyOsEmulatorSource;
}

/** The hdc port a device listens on when it sets none (`hw.hdc.port=notset`). */
export const HARMONYOS_EMULATOR_DEFAULT_HDC_PORT = 5555;

/** The range `Emulator -start -hdcPort` accepts. */
export const HARMONYOS_EMULATOR_HDC_PORTS = { min: 10000, max: 16555 } as const;

/** `-bootMode` values: cold boot keeping data, cold boot with a data reset, quick boot from a snapshot. */
export const HARMONYOS_EMULATOR_BOOT_MODES = ['coldboot', 'reset', 'snapshot'] as const;
export type HarmonyOsEmulatorBootMode = (typeof HARMONYOS_EMULATOR_BOOT_MODES)[number];

const binaryName = (): string => (process.platform === 'win32' ? 'Emulator.exe' : 'Emulator');

/** The emulator at `p`: the binary itself, its directory, or a tools install holding `emulator/`. */
function emulatorAt(p: string): { binary: string; dir: string } | null {
  for (const candidate of [p, path.join(p, binaryName()), path.join(p, 'emulator', binaryName())]) {
    try {
      if (fs.statSync(candidate).isFile()) return { binary: candidate, dir: path.dirname(candidate) };
    } catch {
      // Not there.
    }
  }
  return null;
}

function readEmulatorVersion(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'sdk-pkg.json'), 'utf8')) as { data?: { version?: unknown } };
    return typeof pkg.data?.version === 'string' ? pkg.data.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate the HarmonyOS emulator, or null. Order: `harmonyosEmulatorPath`
 * (`ONIRO_HARMONYOS_EMULATOR_PATH`: the binary, its directory or a command-line-tools
 * install), then `emulator/` in the command-line tools at `cmdToolsPath`, then next to
 * the HarmonyOS SDK a build would use (`ONIRO_HARMONYOS_SDK_PATH`, say). A configured
 * path that holds no emulator is skipped.
 */
export function findHarmonyOsEmulator(config: ConfigProvider, logger: Logger = noopLogger): HarmonyOsEmulator | null {
  const make = (found: { binary: string; dir: string }, source: HarmonyOsEmulatorSource): HarmonyOsEmulator => {
    const version = readEmulatorVersion(found.dir);
    return { ...found, ...(version ? { version } : {}), source };
  };
  const configured = config.get('harmonyosEmulatorPath', '');
  if (configured) {
    const found = emulatorAt(path.resolve(configured));
    if (found) return make(found, 'configured');
    logger.debug(`No HarmonyOS emulator at the configured ${configured}.`);
  }
  const tools = emulatorAt(path.join(getCmdToolsPath(config), 'emulator'));
  if (tools) return make(tools, 'cmdtools');
  const sdk = findHarmonyOsSdk({ config, logger });
  const nearSdk = sdk ? emulatorAt(path.join(path.dirname(sdk.sdkPath), 'emulator')) : null;
  return nearSdk ? make(nearSdk, 'harmonyos-sdk') : null;
}

/** {@link findHarmonyOsEmulator}, or an error saying where the emulator comes from. */
export function requireHarmonyOsEmulator(config: ConfigProvider, logger: Logger = noopLogger): HarmonyOsEmulator {
  const emulator = findHarmonyOsEmulator(config, logger);
  if (emulator) return emulator;
  throw new OniroError(
    'No HarmonyOS emulator found. It comes with the HarmonyOS command-line tools 26.0.0 or later (in their ' +
      '`emulator/` directory, on Linux). Download them from the Huawei developer portal and install them with ' +
      '`oniro-app cmdtools install --from-zip <zip> --force`, or point ONIRO_CMD_TOOLS_PATH or ' +
      'ONIRO_HARMONYOS_EMULATOR_PATH at an install of them.',
  );
}

/** Options shared by the calls that run the emulator's command line. */
export interface HarmonyOsEmulatorRunOptions {
  /** Environment for the emulator. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  abortSignal?: AbortSignal;
}

async function runEmulator(
  emulator: HarmonyOsEmulator,
  args: readonly string[],
  opts: HarmonyOsEmulatorRunOptions & { timeoutMs?: number; onOutput?: (chunk: string) => void } = {},
): Promise<HdcExecResult> {
  return runProcess({
    command: emulator.binary,
    args,
    cwd: emulator.dir,
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 120_000,
    abortSignal: opts.abortSignal,
    ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
    // The emulator prompts (licences, confirmations) on stdin: give it end-of-input.
    input: '',
    logger: opts.logger,
  });
}

const outputOf = (r: HdcExecResult): string => `${r.stdout}${r.stderr}`.replace(/\r/g, '\n');

function tail(text: string, lines = 15): string {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}

/** A release name: `HarmonyOS 7.0.0(26.0.0)` → `{ release: '7.0.0', api: 26 }`; `… (21) Beta1` adds `stage`. */
export function parseHarmonyOsVersion(osVersion: string): { release?: string; api?: number; stage?: string } {
  const m = /^\s*HarmonyOS\s+(\S+?)\s*\(\s*(\d+)(?:\.\d+)*\s*\)\s*(\S.*)?$/i.exec(osVersion);
  if (!m) return {};
  return { release: m[1]!, api: Number(m[2]), ...(m[3] ? { stage: m[3].trim() } : {}) };
}

/** The JSON array the emulator prints for `-list -details` and `-imageList`; `[]` for its "nothing" messages. */
/** Where the JSON array opening at `text[start]` ends (exclusive), or -1 when it does not. */
function jsonArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if ((c === ']' || c === '}') && --depth === 0) {
      return i + 1;
    }
  }
  return -1;
}

function parseJsonRecords(stdout: string, what: string): Record<string, unknown>[] {
  const text = stdout.replace(/\r/g, '');
  const start = text.search(/^\[\s*(?:\{|\])/m);
  if (start < 0) {
    if (/^\s*\[Empty\]\s*$/m.test(text) || /No images matching/i.test(text)) return [];
    throw new OniroError(`Could not read the HarmonyOS emulator's ${what}:\n${tail(text)}`);
  }
  try {
    const end = jsonArrayEnd(text, start);
    const parsed = JSON.parse(end < 0 ? text.slice(start) : text.slice(start, end)) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
  } catch (err) {
    throw new OniroError(`Could not read the HarmonyOS emulator's ${what}: ${(err as Error).message}`);
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined);
const int = (v: unknown): number | undefined => {
  const s = str(v);
  return s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined;
};

/** A device (instance) of the HarmonyOS emulator, from `Emulator -list -details`. */
export interface HarmonyOsEmulatorDevice {
  name: string;
  /** e.g. `phone`, `foldable`, `2in1`. */
  deviceType?: string;
  /** The image it runs, e.g. `HarmonyOS 7.0.0(26.0.0)`. */
  osVersion?: string;
  /** e.g. `7.0.0`. */
  release?: string;
  api?: number;
  /** The image build, e.g. `7.0.0.107`. */
  softwareVersion?: string;
  running: boolean;
  instancePath?: string;
  imageRoot?: string;
  imageSubPath?: string;
  memoryMb?: number;
  cpus?: number;
  /** Display size in pixels and density. */
  screen?: { width?: number; height?: number; density?: number };
  /** Set only when the device names its own hdc port; else it listens on {@link HARMONYOS_EMULATOR_DEFAULT_HDC_PORT}. */
  hdcPort?: number;
  productModel?: string;
}

/** Read `Emulator -list -details`. Exported for tests. */
export function parseHarmonyOsEmulatorDevices(stdout: string): HarmonyOsEmulatorDevice[] {
  return parseJsonRecords(stdout, 'device list').flatMap((r) => {
    const name = str(r.name);
    if (!name) return [];
    const osVersion = str(r['os.osVersion']);
    const parsed = osVersion ? parseHarmonyOsVersion(osVersion) : {};
    const api = int(r['os.apiVersion']) ?? parsed.api;
    const screen = { width: int(r['hw.lcd.single.width']), height: int(r['hw.lcd.single.height']), density: int(r['hw.lcd.density']) };
    const device: HarmonyOsEmulatorDevice = { name, running: str(r.isRunning) === 'true' };
    const set = <K extends keyof HarmonyOsEmulatorDevice>(k: K, v: HarmonyOsEmulatorDevice[K] | undefined): void => {
      if (v !== undefined) device[k] = v;
    };
    set('deviceType', str(r.deviceType));
    set('osVersion', osVersion);
    set('release', parsed.release);
    set('api', api);
    set('softwareVersion', str(r['os.softwareVersion']));
    set('instancePath', str(r.instancePath));
    set('imageRoot', str(r.imageRoot));
    set('imageSubPath', str(r.imageSubPath));
    set('memoryMb', int(r['hw.ramSize']));
    set('cpus', int(r['hw.cpu.ncore']));
    if (Object.values(screen).some((v) => v !== undefined)) {
      device.screen = Object.fromEntries(Object.entries(screen).filter(([, v]) => v !== undefined));
    }
    set('hdcPort', int(r['hw.hdc.port']));
    set('productModel', str(r.productModel));
    return [device];
  });
}

/** The emulator's devices, as `Emulator -list -details` reports them. */
export async function listHarmonyOsEmulatorDevices(
  emulator: HarmonyOsEmulator,
  opts: HarmonyOsEmulatorRunOptions = {},
): Promise<HarmonyOsEmulatorDevice[]> {
  const res = await runEmulator(emulator, ['-list', '-details'], opts);
  if (res.code !== 0) throw new OniroError(`Emulator -list failed (exit ${res.code}):\n${tail(outputOf(res))}`);
  return parseHarmonyOsEmulatorDevices(res.stdout);
}

/** The hdc address of `device`: `127.0.0.1:<port>`, with `hdcPort` overriding its own. */
export function harmonyOsEmulatorAddress(device: Pick<HarmonyOsEmulatorDevice, 'hdcPort'>, hdcPort?: number): string {
  return `127.0.0.1:${hdcPort ?? device.hdcPort ?? HARMONYOS_EMULATOR_DEFAULT_HDC_PORT}`;
}

async function requireDevice(emulator: HarmonyOsEmulator, name: string, opts: HarmonyOsEmulatorRunOptions): Promise<HarmonyOsEmulatorDevice> {
  const devices = await listHarmonyOsEmulatorDevices(emulator, opts);
  const device = devices.find((d) => d.name === name);
  if (device) return device;
  throw new OniroError(
    `No HarmonyOS emulator device named "${name}". ` +
      (devices.length ? `Devices: ${devices.map((d) => `"${d.name}"`).join(', ')}.` : 'There are none; create one with `oniro-app emulator harmonyos create`.'),
  );
}

/** An image in the emulator's catalogue, from `Emulator -imageList`. */
export interface HarmonyOsEmulatorImage {
  /** As the emulator names it, e.g. `HarmonyOS 7.0.0(26.0.0)`. */
  osVersion: string;
  release?: string;
  api?: number;
  /** e.g. `Beta1`. */
  stage?: string;
  deviceType: string;
  /** The image build, e.g. `7.0.0.107`. */
  softwareVersion?: string;
  releaseType?: string;
  downloaded: boolean;
  /** A newer build of a downloaded image is available. */
  upgradable: boolean;
}

/** Read `Emulator -imageList`. Exported for tests. */
export function parseHarmonyOsEmulatorImages(stdout: string): HarmonyOsEmulatorImage[] {
  return parseJsonRecords(stdout, 'image list').flatMap((r) => {
    const osVersion = str(r.osVersion);
    const deviceType = str(r.deviceType);
    if (!osVersion || !deviceType) return [];
    const parsed = parseHarmonyOsVersion(osVersion);
    const image: HarmonyOsEmulatorImage = {
      osVersion,
      deviceType,
      downloaded: str(r.downloaded) === 'true',
      upgradable: str(r.upgradable) === 'true',
    };
    if (parsed.release) image.release = parsed.release;
    if (parsed.api !== undefined) image.api = parsed.api;
    if (parsed.stage) image.stage = parsed.stage;
    const build = str(r.SoftWareVersion) ?? str(r.softwareVersion);
    if (build) image.softwareVersion = build;
    const releaseType = str(r.releaseType);
    if (releaseType) image.releaseType = releaseType;
    return [image];
  });
}

export interface ListHarmonyOsEmulatorImagesOptions extends HarmonyOsEmulatorRunOptions {
  deviceType?: string;
  /** Only the downloaded images (needs no network). */
  downloaded?: boolean;
  httpProxy?: string;
}

/** The emulator's image catalogue (Huawei's, fetched over the network unless `downloaded`). */
export async function listHarmonyOsEmulatorImages(
  emulator: HarmonyOsEmulator,
  opts: ListHarmonyOsEmulatorImagesOptions = {},
): Promise<HarmonyOsEmulatorImage[]> {
  const args = ['-imageList'];
  if (opts.deviceType) args.push('-deviceType', opts.deviceType);
  if (opts.downloaded) args.push('-downloaded', 'true');
  if (opts.httpProxy) args.push('-http_proxy', opts.httpProxy);
  const res = await runEmulator(emulator, args, opts);
  if (res.code !== 0) throw new OniroError(`Emulator -imageList failed (exit ${res.code}):\n${tail(outputOf(res))}`);
  return parseHarmonyOsEmulatorImages(res.stdout);
}

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The image of `deviceType` that `query` names: the emulator's own name (`HarmonyOS
 * 7.0.0(26.0.0)`), the release (`7.0.0`) or the API level (`26`, also `26.0.0`). Of
 * several (betas), the release one, then the newest build. Throws listing the
 * choices when none matches.
 */
export function resolveHarmonyOsEmulatorImage(
  images: readonly HarmonyOsEmulatorImage[],
  query: string,
  deviceType: string,
): HarmonyOsEmulatorImage {
  const ofType = images.filter((i) => normalize(i.deviceType) === normalize(deviceType));
  if (ofType.length === 0) {
    const types = [...new Set(images.map((i) => i.deviceType))];
    throw new OniroError(
      `No HarmonyOS emulator image for device type "${deviceType}".` + (types.length ? ` Device types: ${types.join(', ')}.` : ''),
    );
  }
  const q = query.trim();
  const api = /^\d+$/.test(q) ? Number(q) : apiOfDottedVersion(q);
  let matches = ofType.filter((i) => normalize(i.osVersion) === normalize(q));
  if (matches.length === 0) matches = ofType.filter((i) => i.release === q);
  if (matches.length === 0 && api !== undefined) matches = ofType.filter((i) => i.api === api);
  if (matches.length === 0) {
    throw new OniroError(
      `No HarmonyOS ${deviceType} image matches "${query}". Available: ${[...new Set(ofType.map((i) => i.osVersion))].join(', ')}.`,
    );
  }
  const build = (i: HarmonyOsEmulatorImage) => (i.softwareVersion ?? '').split('.').map((p) => Number(p) || 0);
  return [...matches].sort((a, b) => {
    if (!a.stage !== !b.stage) return a.stage ? 1 : -1;
    const [pa, pb] = [build(a), build(b)];
    for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
      const d = (pb[k] ?? 0) - (pa[k] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  })[0]!;
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/** One of the agreements the emulator ships in `agreement/` and asks the user to accept. */
export interface HarmonyOsEmulatorAgreement {
  /** e.g. `HarmonyOS_SDK_Agreement`: the file name, and the key the emulator records. */
  name: string;
  /** e.g. `HarmonyOS SDK License Agreement`. */
  title: string;
  /** The agreement's text. */
  file: string;
  /** Undefined when where the emulator records acceptance is not known (not Linux or macOS). */
  accepted?: boolean;
}

export interface HarmonyOsEmulatorLicenses {
  agreements: HarmonyOsEmulatorAgreement[];
  /** The file the emulator records acceptance in, when known. */
  stateFile?: string;
}

/**
 * Where the emulator records its settings and which agreements were accepted:
 * `~/Library/Caches/Huawei/Emulator<major>.<minor>/.emu_config`, on Linux as on macOS.
 * Undefined on Windows and for an emulator of unknown version.
 */
export function harmonyOsEmulatorStateFile(
  emulator: Pick<HarmonyOsEmulator, 'version'>,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const m = /^(\d+)\.(\d+)/.exec(emulator.version ?? '');
  if (!m || platform === 'win32') return undefined;
  return path.join(home, 'Library', 'Caches', 'Huawei', `Emulator${m[1]}.${m[2]}`, '.emu_config');
}

function agreementTitle(file: string, fallback: string): string {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000).split(/\r?\n/);
    const title = head.map((l) => l.trim()).find((l) => l && !/^\d+\/\d+:?$/.test(l) && !/^-+$/.test(l));
    if (title) return title;
  } catch {
    // Fall back to the name.
  }
  return fallback.replace(/_/g, ' ');
}

/** The emulator's agreements and whether each was accepted. */
export function readHarmonyOsEmulatorLicenses(
  emulator: HarmonyOsEmulator,
  opts: { home?: string; platform?: NodeJS.Platform } = {},
): HarmonyOsEmulatorLicenses {
  const dir = path.join(emulator.dir, 'agreement');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.txt')).sort();
  } catch {
    // No agreements shipped.
  }
  const stateFile = harmonyOsEmulatorStateFile(emulator, opts.home, opts.platform);
  let state: Map<string, string> | undefined;
  if (stateFile) {
    state = new Map();
    try {
      for (const line of fs.readFileSync(stateFile, 'utf8').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) state.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
      }
    } catch {
      // Nothing recorded yet: nothing accepted.
    }
  }
  const agreements = names.map((n): HarmonyOsEmulatorAgreement => {
    const name = n.slice(0, -'.txt'.length);
    const file = path.join(dir, n);
    const a: HarmonyOsEmulatorAgreement = { name, title: agreementTitle(file, name), file };
    if (state) a.accepted = state.get(name) === 'agree';
    return a;
  });
  return { agreements, ...(stateFile ? { stateFile } : {}) };
}

/** The agreement each operation needs: installing an image, the SDK licence; starting a device, the service agreement. */
const AGREEMENT_FOR: Record<'install' | 'start', string> = {
  install: 'HarmonyOS_SDK_Agreement',
  start: 'HarmonyOS_Software_Service_Agreement',
};

/** Thrown when an agreement the operation needs has not been accepted. */
export class HarmonyOsEmulatorLicenseError extends OniroError {
  constructor(
    message: string,
    readonly agreements: readonly HarmonyOsEmulatorAgreement[],
  ) {
    super(message);
    this.name = 'HarmonyOsEmulatorLicenseError';
  }
}

function licenseError(agreements: readonly HarmonyOsEmulatorAgreement[], doing: string): HarmonyOsEmulatorLicenseError {
  const named = agreements.length
    ? agreements.map((a) => `${a.title} (${a.file})`).join(' and ')
    : "Huawei's agreements";
  return new HarmonyOsEmulatorLicenseError(
    `The HarmonyOS emulator needs ${named} accepted before ${doing}. Read ${agreements.length > 1 ? 'them' : 'it'}, ` +
      'then accept with `oniro-app emulator harmonyos license --accept`, or go through Huawei\'s own prompt with ' +
      '`oniro-app emulator harmonyos license --review`.',
    agreements,
  );
}

/**
 * Throw {@link HarmonyOsEmulatorLicenseError} unless the agreement `operation` needs was
 * accepted. Without the agreement the emulator only prompts, and for an image install
 * then exits 0 having done nothing. When acceptance cannot be read, it passes.
 */
export function requireHarmonyOsEmulatorLicenses(
  emulator: HarmonyOsEmulator,
  operation: 'install' | 'start',
  opts: { home?: string; platform?: NodeJS.Platform } = {},
): void {
  const { agreements } = readHarmonyOsEmulatorLicenses(emulator, opts);
  const known = agreements.filter((a) => a.name === AGREEMENT_FOR[operation]);
  const needed = known.length ? known : agreements;
  const missing = needed.filter((a) => a.accepted === false);
  if (missing.length) throw licenseError(missing, operation === 'install' ? 'it downloads an image' : 'it starts a device');
}

/** Accept every agreement the emulator ships (`Emulator -license accept`). Only on the user's explicit request. */
export async function acceptHarmonyOsEmulatorLicenses(
  emulator: HarmonyOsEmulator,
  opts: HarmonyOsEmulatorRunOptions = {},
): Promise<void> {
  const res = await runEmulator(emulator, ['-license', 'accept'], opts);
  if (res.code !== 0 || !/accepted/i.test(outputOf(res))) {
    throw new OniroError(`Emulator -license accept failed (exit ${res.code}):\n${tail(outputOf(res))}`);
  }
}

/**
 * Go through the emulator's own licence prompt (`Emulator -license`) on this terminal.
 * Resolves with its exit code.
 */
export function reviewHarmonyOsEmulatorLicenses(emulator: HarmonyOsEmulator, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(emulator.binary, ['-license'], { cwd: emulator.dir, env: opts.env, stdio: 'inherit' });
    child.once('error', (err) => reject(new OniroError(`Failed to run ${emulator.binary}: ${err.message}`, err)));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

// ---------------------------------------------------------------------------
// Images and devices
// ---------------------------------------------------------------------------

const PROGRESS_RE = /(\d+(?:\.\d+)?)%\s*\((\d+)\/(\d+) bytes\)/g;

export interface InstallHarmonyOsEmulatorImageOptions extends HarmonyOsEmulatorRunOptions {
  emulator: HarmonyOsEmulator;
  /** From {@link resolveHarmonyOsEmulatorImage}. */
  image: Pick<HarmonyOsEmulatorImage, 'osVersion' | 'deviceType'>;
  /** Where to put it. Default: the emulator's image root (`Emulator -config -imageRoot`). */
  imageRoot?: string;
  httpProxy?: string;
  progress?: ProgressReporter;
  home?: string;
}

/**
 * Download an image with `Emulator -install` from Huawei's servers, reporting progress
 * (0–100). Needs the SDK licence accepted ({@link requireHarmonyOsEmulatorLicenses}).
 * Verifies afterwards that the image is listed as downloaded, since the emulator exits
 * 0 on some failures.
 */
export async function installHarmonyOsEmulatorImage(opts: InstallHarmonyOsEmulatorImageOptions): Promise<void> {
  const { emulator, image } = opts;
  const progress = opts.progress ?? noopProgress;
  requireHarmonyOsEmulatorLicenses(emulator, 'install', { home: opts.home });
  const args = ['-install', '-deviceType', image.deviceType, '-osVersion', image.osVersion];
  if (opts.imageRoot) args.push('-imageRoot', opts.imageRoot);
  if (opts.httpProxy) args.push('-http_proxy', opts.httpProxy);
  let reported = 0;
  let pending = '';
  const res = await runEmulator(emulator, args, {
    ...opts,
    timeoutMs: 6 * 60 * 60 * 1000,
    onOutput: (chunk) => {
      pending += chunk;
      let end = -1;
      for (const m of pending.matchAll(PROGRESS_RE)) {
        end = m.index + m[0].length;
        const percent = Math.min(100, Math.floor(Number(m[1])));
        if (percent <= reported && reported > 0) continue;
        progress.report({
          message: `Downloading ${image.osVersion} (${image.deviceType}): ${percent}% of ${Math.round(Number(m[3]) / 1024 / 1024)} MB`,
          increment: percent - reported,
        });
        reported = percent;
      }
      // Keep a partial progress line for the next chunk.
      pending = end >= 0 ? pending.slice(end) : pending.slice(-200);
    },
  });
  const output = outputOf(res);
  if (/Please agree to the agreement first/i.test(output)) {
    throw licenseError(readHarmonyOsEmulatorLicenses(emulator, { home: opts.home }).agreements.filter((a) => a.name === AGREEMENT_FOR.install), 'it downloads an image');
  }
  if (res.code !== 0) throw new OniroError(`Emulator -install failed (exit ${res.code}):\n${tail(output)}`);
  const downloaded = await listHarmonyOsEmulatorImages(emulator, { ...opts, deviceType: image.deviceType, downloaded: true });
  if (!downloaded.some((i) => normalize(i.osVersion) === normalize(image.osVersion))) {
    throw new OniroError(`Emulator -install did not download ${image.osVersion} (${image.deviceType}):\n${tail(output)}`);
  }
}

/** Names `Emulator -create` accepts. */
const DEVICE_NAME_RE = /^[A-Za-z0-9_ ]+$/;

export interface CreateHarmonyOsEmulatorDeviceOptions extends HarmonyOsEmulatorRunOptions {
  emulator: HarmonyOsEmulator;
  /** Letters, digits, underscores and spaces. */
  name: string;
  /** A downloaded image, from {@link resolveHarmonyOsEmulatorImage}. */
  image: Pick<HarmonyOsEmulatorImage, 'osVersion' | 'deviceType'>;
  /** Guest RAM in GB (2–32; the emulator's default is 4). */
  memoryGb?: number;
  /** Data partition in GB (2–1023; default 6). */
  storageGb?: number;
}

/** Create a device on a downloaded image (`Emulator -create`). Returns it as listed afterwards. */
export async function createHarmonyOsEmulatorDevice(opts: CreateHarmonyOsEmulatorDeviceOptions): Promise<HarmonyOsEmulatorDevice> {
  const { emulator, name, image } = opts;
  if (!DEVICE_NAME_RE.test(name) || name.trim() !== name) {
    throw new OniroError(`Invalid HarmonyOS emulator device name "${name}": use letters, digits, underscores and inner spaces.`);
  }
  const existing = await listHarmonyOsEmulatorDevices(emulator, opts);
  if (existing.some((d) => d.name === name)) throw new OniroError(`A HarmonyOS emulator device named "${name}" already exists.`);
  const args = ['-create', name, '-deviceType', image.deviceType, '-osVersion', image.osVersion];
  if (opts.memoryGb !== undefined) args.push('-memory', String(opts.memoryGb));
  if (opts.storageGb !== undefined) args.push('-storage', String(opts.storageGb));
  const res = await runEmulator(emulator, args, opts);
  const output = outputOf(res);
  if (res.code !== 0 || !/create success/i.test(output)) {
    throw new OniroError(`Emulator -create "${name}" failed (exit ${res.code}):\n${tail(output)}`);
  }
  return requireDevice(emulator, name, opts);
}

/** Delete a stopped device and its data (`Emulator -delete -force`). */
export async function deleteHarmonyOsEmulatorDevice(
  opts: HarmonyOsEmulatorRunOptions & { emulator: HarmonyOsEmulator; name: string },
): Promise<void> {
  const device = await requireDevice(opts.emulator, opts.name, opts);
  if (device.running) {
    throw new OniroError(`"${opts.name}" is running; stop it first with \`oniro-app emulator harmonyos stop "${opts.name}"\`.`);
  }
  const res = await runEmulator(opts.emulator, ['-delete', opts.name, '-force'], opts);
  const output = outputOf(res);
  if (res.code !== 0 || !/delete success/i.test(output)) {
    throw new OniroError(`Emulator -delete "${opts.name}" failed (exit ${res.code}):\n${tail(output)}`);
  }
}

// ---------------------------------------------------------------------------
// Start and stop
// ---------------------------------------------------------------------------

/**
 * The emulator's environment: as given, with `__GL_SYNC_TO_VBLANK=0` unless set. On
 * NVIDIA's driver vsync blocks the emulator's buffer swaps on the monitor's refresh,
 * which halved its frame-time p90 on a 60 Hz display; other drivers ignore it.
 */
export function harmonyOsEmulatorEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return env.__GL_SYNC_TO_VBLANK === undefined ? { ...env, __GL_SYNC_TO_VBLANK: '0' } : { ...env };
}

export interface StartHarmonyOsEmulatorOptions extends HarmonyOsEmulatorRunOptions {
  /** For hdc (the boot wait). */
  config: ConfigProvider;
  emulator: HarmonyOsEmulator;
  name: string;
  /** No window (`-noWindow`). */
  headless?: boolean;
  bootMode?: HarmonyOsEmulatorBootMode;
  /** hdc port for this run (`-hdcPort`, 10000–16555). Default: the device's own, else 5555. */
  hdcPort?: number;
  /** Where the emulator's stdout and stderr go. Default `<instance>/Log/oniro-app-start.log`. */
  logFile?: string;
  /** Wait up to this many seconds for the guest's `bootevent.boot.completed`. */
  waitReadySeconds?: number;
  /** Boot-wait poll interval, ms. Default 3000. */
  pollIntervalMs?: number;
  /** How long a just-spawned emulator must stay up to count as started, ms. Default 3000. */
  settleMs?: number;
  home?: string;
}

export interface StartedHarmonyOsEmulator {
  name: string;
  /** hdc serial, e.g. `127.0.0.1:5555`. */
  address: string;
  /** The `Emulator` process; absent when it was already running. */
  pid?: number;
  logFile?: string;
  alreadyRunning: boolean;
  /** Set when waited for: the guest finished booting. */
  ready?: boolean;
  /** Seconds the boot wait took. */
  bootSeconds?: number;
}

function readFileTail(file: string, bytes = 4000): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, bytes));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      return tail(buf.toString('utf8').replace(/\r/g, '\n'), 20);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * The hdc address of a device that is already running. `-hdcPort` applies only when a
 * device starts, and the emulator records the port nowhere, so this is the port asked
 * for when hdc lists it, else the device's own.
 */
async function runningDeviceAddress(
  opts: StartHarmonyOsEmulatorOptions,
  device: HarmonyOsEmulatorDevice,
  logger: Logger,
): Promise<string> {
  const own = harmonyOsEmulatorAddress(device);
  if (opts.hdcPort === undefined) return own;
  const asked = harmonyOsEmulatorAddress(device, opts.hdcPort);
  if (asked === own) return own;
  let listed: string[] = [];
  try {
    listed = (await listDevices(opts.config, { logger })).map((d) => d.serial);
  } catch {
    // No hdc: assume the device's own port.
  }
  if (listed.includes(asked)) return asked;
  logger.warn(
    `"${device.name}" is already running, and hdc lists nothing at ${asked}: the hdc port applies only when ` +
      `a device starts, so it keeps the one it started with (${own} unless that start set another). Stop it to change it.`,
  );
  return own;
}

/**
 * Start a device in the background (`Emulator -start`, detached), so the caller can
 * exit while it runs; with `waitReadySeconds`, wait until the guest has booted. The
 * emulator registers itself with the hdc server. A device that is already running is
 * left alone (and still waited for).
 */
export async function startHarmonyOsEmulator(opts: StartHarmonyOsEmulatorOptions): Promise<StartedHarmonyOsEmulator> {
  const { emulator, name } = opts;
  const logger = opts.logger ?? noopLogger;
  const device = await requireDevice(emulator, name, opts);
  if (device.running) {
    const address = await runningDeviceAddress(opts, device, logger);
    logger.info(`"${name}" is already running (${address}).`);
    const started: StartedHarmonyOsEmulator = { name, address, alreadyRunning: true };
    return opts.waitReadySeconds ? { ...started, ...(await waitForBoot(opts, address)) } : started;
  }
  requireHarmonyOsEmulatorLicenses(emulator, 'start', { home: opts.home });

  const address = harmonyOsEmulatorAddress(device, opts.hdcPort);
  const logFile = opts.logFile ?? path.join(device.instancePath ?? os.tmpdir(), 'Log', 'oniro-app-start.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const args = ['-start', name];
  if (opts.headless) args.push('-noWindow');
  if (opts.bootMode) args.push('-bootMode', opts.bootMode);
  if (opts.hdcPort !== undefined) args.push('-hdcPort', String(opts.hdcPort));
  const fd = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(emulator.binary, args, {
      cwd: emulator.dir,
      env: harmonyOsEmulatorEnv(opts.env),
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  let exitCode: number | null | undefined;
  child.once('exit', (code) => {
    exitCode = code;
  });
  child.once('error', () => {
    exitCode = -1;
  });
  child.unref();
  if (!child.pid) throw new OniroError(`Failed to start ${emulator.binary}.`);
  logger.info(`Starting "${name}" (pid ${child.pid}); emulator output in ${logFile}.`);

  const exited = (): never => {
    const log = readFileTail(logFile);
    if (/agree to the agreement/i.test(log)) {
      const lic = readHarmonyOsEmulatorLicenses(emulator, { home: opts.home });
      throw licenseError(lic.agreements.filter((a) => a.accepted !== true), 'it starts a device');
    }
    throw new OniroError(`The HarmonyOS emulator exited (code ${exitCode}) while starting "${name}". Tail of ${logFile}:\n${log}`);
  };
  await sleep(opts.settleMs ?? 3000, opts.abortSignal);
  if (exitCode !== undefined) exited();
  const started: StartedHarmonyOsEmulator = { name, address, pid: child.pid, logFile, alreadyRunning: false };
  if (!opts.waitReadySeconds) return started;
  return { ...started, ...(await waitForBoot(opts, address, () => (exitCode !== undefined ? exited() : undefined), logFile)) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError('Cancelled.'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new CancelledError('Cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForBoot(
  opts: StartHarmonyOsEmulatorOptions,
  address: string,
  checkAlive: () => void = () => {},
  logFile?: string,
): Promise<{ ready: true; bootSeconds: number }> {
  const logger = opts.logger ?? noopLogger;
  const started = Date.now();
  const deadline = started + opts.waitReadySeconds! * 1000;
  for (;;) {
    checkAlive();
    const probe = await probeEmulatorBoot(opts.config, address, { logger: noopLogger, timeoutMs: 10_000 });
    if (probe.bootCompleted) {
      const bootSeconds = Math.round((Date.now() - started) / 1000);
      logger.info(`"${opts.name}" is ready at ${address} after ${bootSeconds}s.`);
      return { ready: true, bootSeconds };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(opts.pollIntervalMs ?? 3000, Math.max(0, deadline - Date.now())), opts.abortSignal);
  }
  const log = logFile ? readFileTail(logFile) : '';
  throw new OniroError(
    `"${opts.name}" did not finish booting at ${address} within ${opts.waitReadySeconds}s.${log ? `\nTail of ${logFile}:\n${log}` : ''}`,
  );
}

export interface StopHarmonyOsEmulatorOptions extends HarmonyOsEmulatorRunOptions {
  emulator: HarmonyOsEmulator;
  name: string;
  /** How long to wait for it to shut down. Default 60 s. */
  waitSeconds?: number;
  /** Poll interval, ms. Default 2000. */
  pollIntervalMs?: number;
}

/**
 * Stop a device (`Emulator -stop`) and wait until it no longer runs: the emulator
 * reports success before it has shut down. False when it was not running.
 */
export async function stopHarmonyOsEmulator(opts: StopHarmonyOsEmulatorOptions): Promise<boolean> {
  const { emulator, name } = opts;
  const device = await requireDevice(emulator, name, opts);
  if (!device.running) return false;
  const res = await runEmulator(emulator, ['-stop', name], opts);
  const output = outputOf(res);
  if (res.code !== 0 && !/success/i.test(output)) {
    throw new OniroError(`Emulator -stop "${name}" failed (exit ${res.code}):\n${tail(output)}`);
  }
  const waitSeconds = opts.waitSeconds ?? 60;
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const now = (await listHarmonyOsEmulatorDevices(emulator, opts)).find((d) => d.name === name);
    if (!now?.running) return true;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(opts.pollIntervalMs ?? 2000, Math.max(0, deadline - Date.now())), opts.abortSignal);
  }
  throw new OniroError(`"${name}" was still running ${waitSeconds}s after Emulator -stop.`);
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/** One host requirement of the emulator on Linux. */
export interface HarmonyOsEmulatorHostCheck {
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface HarmonyOsEmulatorHost {
  /** `/dev/kvm`, read-write: the emulator runs its guest with KVM. */
  kvm: HarmonyOsEmulatorHostCheck;
  /** A GPU render node (`/dev/dri/renderD*`), read-write: it renders the guest with the host's GPU. */
  gpu: HarmonyOsEmulatorHostCheck;
}

/** What the emulator needs of a Linux host, or null on other platforms (not checked there). */
export function checkHarmonyOsEmulatorHost(
  opts: { devDir?: string; platform?: NodeJS.Platform } = {},
): HarmonyOsEmulatorHost | null {
  if ((opts.platform ?? process.platform) !== 'linux') return null;
  const dev = opts.devDir ?? '/dev';
  const rw = (p: string): boolean => {
    try {
      fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  const kvmPath = path.join(dev, 'kvm');
  const kvm: HarmonyOsEmulatorHostCheck = !fs.existsSync(kvmPath)
    ? {
        ok: false,
        detail: `${kvmPath} does not exist`,
        fix: 'Enable virtualization (VT-x or AMD-V) in the firmware settings and load the kvm module.',
      }
    : rw(kvmPath)
      ? { ok: true, detail: `${kvmPath} is accessible` }
      : { ok: false, detail: `${kvmPath} is not accessible`, fix: 'sudo usermod -aG kvm $USER, then log in again.' };
  let nodes: string[] = [];
  try {
    nodes = fs.readdirSync(path.join(dev, 'dri')).filter((n) => n.startsWith('renderD')).map((n) => path.join(dev, 'dri', n));
  } catch {
    // No DRI.
  }
  const usable = nodes.find(rw);
  const gpu: HarmonyOsEmulatorHostCheck = usable
    ? { ok: true, detail: `${usable} is accessible` }
    : nodes.length
      ? { ok: false, detail: `${nodes.join(', ')} ${nodes.length > 1 ? 'are' : 'is'} not accessible`, fix: 'sudo usermod -aG render $USER, then log in again.' }
      : { ok: false, detail: `no GPU render node in ${path.join(dev, 'dri')}`, fix: 'Install the GPU driver; the emulator needs OpenGL 4.1.' };
  return { kvm, gpu };
}
