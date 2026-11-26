import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSON5 from 'json5';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import type { ProgressReporter } from '../ports/progress.js';
import { SdkNotInstalledError } from '../ports/errors.js';
import { hdcExec, runProcess, shell } from '../hdc/exec.js';
import { isUsableDevice, listDevices } from '../hdc/devices.js';
import { getDeviceInfo } from '../device/info.js';
import { getCmdToolsStatus } from '../cmdTools/install.js';
import { getCmdToolsPath, getHdcPath, getOhosBaseSdkHome, getSdkRootDir } from '../sdk/paths.js';
import { downloadAndInstallSdk, type InstallSdkOptions } from '../sdk/install.js';
import { findMissingProjectSdk, findProjectSdkDir, migrateProjectSdkDir } from '../sdk/detectProjectSdk.js';
import { expectedSdkApiDir, legacySdkApiDirTarget, listSdkApiDirs } from '../sdk/apiDir.js';
import { apiOfDottedVersion, ohosSdkVersionValue } from '../sdk/apiVersion.js';
import { findHvigorTooOld } from '../cmdTools/compat.js';
import { checkHarmonyOsEmulatorHost, findHarmonyOsEmulator, readHarmonyOsEmulatorLicenses } from '../harmonyos/emulator.js';
import { detectRuntimeOs, type RuntimeOs } from '../harmonyos/target.js';
import { findHarmonyOsSdk } from '../harmonyos/sdk.js';
import { findJava } from '../harmonyos/java.js';
import { checkArkts, resolveArktsCheckSdk } from '../check/arktsCheck.js';

/**
 * `oniro-app doctor`: one verdict on whether this machine can build, check, sign,
 * install and test a project, with the tool versions in use so drift between two
 * runs is visible. Each check is `ok`, `warn`, `fail` or `skip`, with a one-line fix.
 */

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  /** Stable key: `node`, `java`, `sdk`, `cmdtools`, `arkts-check`, `hdc`, `device`, `hdc-speed`, `hos-emulator`, `signing`, `disk`. */
  id: string;
  status: DoctorStatus;
  /** What was found, one line. */
  detail: string;
  /** What to run or change, when the status is not ok. */
  fix?: string;
  /** True when `fix` was applied by `doctor --fix` (the status is then the re-checked one). */
  fixed?: boolean;
}

export interface DoctorProject {
  dir: string;
  runtimeOS: RuntimeOs;
  /** As written in build-profile.json5: an API level, or `6.0.0(20)` for HarmonyOS. */
  compileSdkVersion?: string | number;
  compatibleSdkVersion?: string | number;
  /** The API level a device must run at least: compatibleSdkVersion, else compileSdkVersion. */
  minApi?: number;
}

/** Versions in use, recorded so a change between two runs shows (#25). */
export interface DoctorVersions {
  node: string;
  java?: string;
  cmdTools?: string;
  cmdToolsFlavour?: string;
  /** The SDK directory a build or `check arkts` of the project uses. */
  sdk?: string;
  hdc?: string;
  deviceApi?: string;
  /** The HarmonyOS emulator's version, e.g. `26.0.0.400`. */
  harmonyosEmulator?: string;
}

export interface DoctorReport {
  /** True when no check failed. */
  ok: boolean;
  checks: DoctorCheck[];
  project?: DoctorProject;
  versions: DoctorVersions;
}

export interface DoctorOptions {
  config: ConfigProvider;
  /** A project to check the SDK, device API and signing for. */
  projectDir?: string;
  /** Install the project's missing OpenHarmony SDK. */
  fix?: boolean;
  /** Check a device is reachable (default true). False skips `device`. */
  device?: boolean;
  deviceSerial?: string;
  /** Run `check arkts` on a generated one-file project (default true). */
  arktsSelfTest?: boolean;
  logger?: Logger;
  progress?: ProgressReporter;
  env?: NodeJS.ProcessEnv;
  /** Seams for tests. */
  installSdk?: (opts: InstallSdkOptions) => Promise<void>;
  arktsCheckerScript?: string;
}

const MIN_NODE_MAJOR = 20;
const DISK_WARN_BYTES = 5 * 1024 ** 3;
const DISK_FAIL_BYTES = 1024 ** 3;

/**
 * What a complete command-line tools install holds. `cmdtools install` extracting
 * only part of the archive leaves `bin/ohpm` in place, so "installed" alone does
 * not catch it (#16).
 */
export const CMD_TOOLS_REQUIRED = [
  'bin/ohpm',
  'bin/hvigorw',
  'bin/codelinter',
  'hvigor',
  'ohpm',
  'codelinter',
  'tool/node',
  'sdk/default/openharmony/toolchains',
  'version.txt',
] as const;

/** Parse `20` or `"6.0.0(20)"` to its API level. */
export function apiLevelOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const dotted = apiOfDottedVersion(value);
  if (dotted !== undefined) return dotted;
  const m = /^\s*(?:\d+(?:\.\d+)*\s*\(\s*(\d+)\s*\)|(\d+))\s*$/.exec(value);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

interface ProfileProduct {
  name?: unknown;
  compileSdkVersion?: unknown;
  compatibleSdkVersion?: unknown;
  signingConfig?: unknown;
}

interface Profile {
  app?: { products?: ProfileProduct[]; signingConfigs?: Array<{ name?: unknown; material?: Record<string, unknown> }> };
}

function readProfile(projectDir: string): Profile | undefined {
  try {
    return JSON5.parse(fs.readFileSync(path.join(projectDir, 'build-profile.json5'), 'utf-8')) as Profile;
  } catch {
    return undefined;
  }
}

export function describeProject(projectDir: string): DoctorProject {
  const product = readProfile(projectDir)?.app?.products?.[0];
  const project: DoctorProject = { dir: projectDir, runtimeOS: detectRuntimeOs(projectDir) };
  const compile = product?.compileSdkVersion;
  const compatible = product?.compatibleSdkVersion;
  if (typeof compile === 'string' || typeof compile === 'number') project.compileSdkVersion = compile;
  if (typeof compatible === 'string' || typeof compatible === 'number') project.compatibleSdkVersion = compatible;
  const minApi = apiLevelOf(compatible) ?? apiLevelOf(compile);
  if (minApi !== undefined) project.minApi = minApi;
  return project;
}

export function checkNode(version = process.versions.node): DoctorCheck {
  const major = Number(version.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { id: 'node', status: 'ok', detail: `node ${version}` }
    : { id: 'node', status: 'fail', detail: `node ${version} is older than ${MIN_NODE_MAJOR}`, fix: `Install Node.js ${MIN_NODE_MAJOR} or newer.` };
}

async function checkJava(env: NodeJS.ProcessEnv, versions: DoctorVersions): Promise<DoctorCheck> {
  let java: string;
  try {
    java = findJava(undefined, env);
  } catch {
    return {
      id: 'java',
      status: 'fail',
      detail: 'no java on JAVA_HOME or PATH',
      fix: 'Install a JDK (17 or newer) and put it on PATH or set JAVA_HOME; signing and hvigor need it.',
    };
  }
  try {
    const res = await runProcess({ command: java, args: ['-version'], timeoutMs: 15_000 });
    const first = `${res.stderr}\n${res.stdout}`.split('\n').find((l) => /version/i.test(l))?.trim();
    if (first) versions.java = first;
    return { id: 'java', status: res.code === 0 ? 'ok' : 'fail', detail: first ?? java, fix: res.code === 0 ? undefined : `${java} -version exits ${res.code}.` };
  } catch (err) {
    return { id: 'java', status: 'fail', detail: `${java} did not run: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The command-line tools are installed, complete, and of a recorded version; with an
 * OpenHarmony `project`, also new enough to build its API level (hvigor 6.26 from API 26).
 */
export function checkCmdTools(config: ConfigProvider, versions: DoctorVersions, project?: DoctorProject): DoctorCheck {
  const status = getCmdToolsStatus(config);
  const dir = getCmdToolsPath(config);
  if (!status.installed) {
    // A directory with some content but no ohpm is a failed install too (#16).
    const partial = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    return {
      id: 'cmdtools',
      status: 'fail',
      detail: partial ? `${dir} is a partial install: bin/ohpm is missing` : `not installed at ${dir}`,
      fix: partial ? 'oniro-app cmdtools install --force' : 'oniro-app cmdtools install',
    };
  }
  const version = status.version;
  if (version) versions.cmdTools = version;
  if (status.flavour) versions.cmdToolsFlavour = status.flavour;
  const missing = CMD_TOOLS_REQUIRED.filter((rel) => !fs.existsSync(path.join(dir, rel)));
  if (missing.length) {
    return {
      id: 'cmdtools',
      status: 'fail',
      detail: `${dir} is a partial install: missing ${missing.join(', ')}`,
      fix: 'oniro-app cmdtools install --force',
    };
  }
  const api = project?.runtimeOS === 'OpenHarmony' ? apiLevelOf(project.compileSdkVersion) : undefined;
  const tooOld = api === undefined ? null : findHvigorTooOld(config, api, project!.dir);
  if (tooOld) return { id: 'cmdtools', status: 'fail', detail: tooOld.message, fix: tooOld.fix };
  return { id: 'cmdtools', status: 'ok', detail: `${status.flavour ?? ''} ${version ?? 'version unknown'} at ${dir}`.trim() };
}

async function checkProjectSdk(
  opts: DoctorOptions,
  project: DoctorProject,
  versions: DoctorVersions,
  logger: Logger,
): Promise<DoctorCheck> {
  if (project.runtimeOS === 'HarmonyOS') {
    const sdk = findHarmonyOsSdk({ config: opts.config, logger });
    if (!sdk) {
      return {
        id: 'sdk',
        status: 'fail',
        detail: 'the project targets HarmonyOS and no HarmonyOS SDK was found',
        fix: 'Install DevEco Studio or the HarmonyOS command-line tools and set ONIRO_HARMONYOS_SDK_PATH.',
      };
    }
    versions.sdk = sdk.sdkPath;
    const wanted = typeof project.compileSdkVersion === 'string' ? project.compileSdkVersion : undefined;
    if (wanted && sdk.version && wanted !== sdk.version) {
      return {
        id: 'sdk',
        status: 'fail',
        detail: `the project compiles with ${wanted}, the HarmonyOS SDK at ${sdk.sdkPath} is ${sdk.version}`,
        fix: `Set compileSdkVersion to "${sdk.version}", or install the ${wanted} SDK.`,
      };
    }
    return { id: 'sdk', status: 'ok', detail: `${sdk.displayName ?? 'HarmonyOS SDK'} ${sdk.version ?? ''} at ${sdk.sdkPath}`.trim() };
  }

  const api = apiLevelOf(project.compileSdkVersion);
  if (api === undefined) {
    return {
      id: 'sdk',
      status: 'fail',
      detail: 'build-profile.json5 declares no OpenHarmony compileSdkVersion',
      fix: 'Set compileSdkVersion in build-profile.json5: the API level (20), or from API 26 its release ("26.0.0").',
    };
  }
  let missing = findMissingProjectSdk(opts.config, project.dir);
  let fixed = false;
  if (missing && opts.fix && missing.version) {
    logger.info(`Installing OpenHarmony SDK ${missing.version} (API ${api}), which the project compiles with...`);
    await (opts.installSdk ?? downloadAndInstallSdk)({
      config: opts.config,
      version: missing.version,
      api: String(api),
      progress: opts.progress,
      logger,
    });
    fixed = true;
    missing = findMissingProjectSdk(opts.config, project.dir);
  }
  if (missing) {
    return {
      id: 'sdk',
      status: 'fail',
      detail: `API ${api} is not installed at ${missing.expectedPath}`,
      fix: missing.version ? `oniro-app sdk install ${missing.version} (or doctor --fix)` : `No known OpenHarmony release ships API ${api}.`,
      ...(fixed ? { fixed } : {}),
    };
  }
  let found = findProjectSdkDir(opts.config, project.dir);
  if (found?.legacy && opts.fix && migrateProjectSdkDir(opts.config, project.dir, undefined, logger)) {
    fixed = true;
    found = findProjectSdkDir(opts.config, project.dir);
  }
  versions.sdk = found?.dir ?? expectedSdkApiDir(getOhosBaseSdkHome(opts.config), api);
  if (found?.legacy) {
    return {
      id: 'sdk',
      status: 'fail',
      detail: `API ${api} is installed at ${found.dir}, where hvigor 6.26 and later do not look for it`,
      fix: `oniro-app doctor --fix (or the next oniro-app build) moves it to ${legacySdkApiDirTarget(
        path.dirname(found.dir),
        api,
        typeof project.compileSdkVersion === 'string' ? project.compileSdkVersion : undefined,
      )}.`,
      ...(fixed ? { fixed } : {}),
    };
  }
  return { id: 'sdk', status: 'ok', detail: `API ${api} at ${versions.sdk}`, ...(fixed ? { fixed } : {}) };
}

/**
 * Run `check arkts` on a generated one-file project holding a known strict-mode
 * error: ok only when the checker completes and reports it, so a checker that
 * runs but silently checks nothing fails here.
 */
async function checkArktsSelfTest(
  opts: DoctorOptions,
  project: DoctorProject | undefined,
  logger: Logger,
): Promise<DoctorCheck> {
  let sdkDir: string | undefined;
  let hmsEtsDir: string | undefined;
  let api: number | undefined;
  if (project) {
    try {
      const sdk = resolveArktsCheckSdk(opts.config, project.dir, logger);
      sdkDir = sdk.dir;
      hmsEtsDir = sdk.hmsEtsDir;
      api = sdk.api;
    } catch (err) {
      return { id: 'arkts-check', status: 'skip', detail: `no SDK to check against: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else {
    const newest = listSdkApiDirs(getOhosBaseSdkHome(opts.config)).find((d) => fs.existsSync(path.join(d.dir, 'ets', 'api')));
    if (newest === undefined) {
      return { id: 'arkts-check', status: 'skip', detail: 'no OpenHarmony SDK installed' };
    }
    api = newest.api;
    sdkDir = newest.dir;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-doctor-'));
  try {
    const level = api ?? 12;
    const sdkVersion = ohosSdkVersionValue(level, sdkDir ? path.basename(sdkDir) : undefined);
    const main = path.join(tmp, 'entry', 'src', 'main');
    fs.mkdirSync(path.join(main, 'ets', 'pages'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'build-profile.json5'),
      JSON.stringify({
        app: { products: [{ name: 'default', compileSdkVersion: sdkVersion, compatibleSdkVersion: sdkVersion, runtimeOS: project?.runtimeOS ?? 'OpenHarmony' }] },
        modules: [{ name: 'entry', srcPath: './entry' }],
      }),
    );
    fs.writeFileSync(
      path.join(main, 'module.json5'),
      JSON.stringify({ module: { name: 'entry', type: 'entry', deviceTypes: ['default'], pages: '$profile:main_pages' } }),
    );
    fs.writeFileSync(
      path.join(main, 'ets', 'pages', 'Index.ets'),
      "@Entry\n@Component\nstruct Index {\n  build() {\n    Column() {\n      Text('doctor')\n    }\n  }\n}\n\nlet probe: any = 1;\n",
    );
    const report = await checkArkts({
      config: opts.config,
      projectDir: tmp,
      files: ['entry/src/main/ets/pages/Index.ets'],
      sdkDir,
      hmsEtsDir,
      timeoutMs: 120_000,
      logger,
      scriptPath: opts.arktsCheckerScript,
    });
    if (!report.completed) {
      return { id: 'arkts-check', status: 'fail', detail: `the checker did not run: ${report.error?.split('\n')[0]}`, fix: 'Run `oniro-app check arkts --json` on the project for the full error.' };
    }
    const caught = report.diagnostics.some((d) => d.severity === 'error' && d.line === 11);
    return caught
      ? { id: 'arkts-check', status: 'ok', detail: `caught the planted error against ${sdkDir} in ${(report.durationMs / 1000).toFixed(1)} s` }
      : {
          id: 'arkts-check',
          status: 'fail',
          detail: `the checker ran against ${sdkDir} but missed a planted \`any\` error, so its clean results cannot be trusted`,
          fix: 'Check that the SDK directory holds ets/build-tools/ets-loader.',
        };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function checkHdc(config: ConfigProvider, versions: DoctorVersions): Promise<DoctorCheck> {
  const hdc = getHdcPath(config);
  if (!fs.existsSync(hdc)) {
    return { id: 'hdc', status: 'fail', detail: `no hdc at ${hdc}`, fix: 'oniro-app cmdtools install (it ships hdc)' };
  }
  try {
    const res = await runProcess({ command: hdc, args: ['version'], timeoutMs: 15_000 });
    const version = `${res.stdout}`.trim().split('\n')[0]?.trim();
    if (version) versions.hdc = version;
    return res.code === 0
      ? { id: 'hdc', status: 'ok', detail: `${version ?? 'hdc'} at ${hdc}` }
      : { id: 'hdc', status: 'fail', detail: `${hdc} version exits ${res.code}` };
  } catch (err) {
    return { id: 'hdc', status: 'fail', detail: `${hdc} did not run: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkDevice(
  opts: DoctorOptions,
  project: DoctorProject | undefined,
  versions: DoctorVersions,
  logger: Logger,
  /** Told the serial of the device that was looked at, when there is one. */
  found?: (serial: string) => void,
): Promise<DoctorCheck> {
  let devices;
  try {
    devices = (await listDevices(opts.config, { logger })).filter(isUsableDevice);
  } catch (err) {
    return { id: 'device', status: 'fail', detail: `hdc list targets failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const serial = opts.deviceSerial ?? devices[0]?.serial;
  if (!serial || (opts.deviceSerial && !devices.some((d) => d.serial === opts.deviceSerial))) {
    return {
      id: 'device',
      status: 'fail',
      detail: opts.deviceSerial ? `device ${opts.deviceSerial} is not connected` : 'no device or emulator reachable',
      fix: 'oniro-app emulator start --headless --wait-for-hdc 120, or connect a device (or pass --no-device)',
    };
  }
  found?.(serial);
  const info = await getDeviceInfo({ config: opts.config, deviceSerial: serial, logger });
  if (info.sdkApiVersion) versions.deviceApi = info.sdkApiVersion;
  const deviceApi = Number(info.sdkApiVersion);
  const label = `${serial} (${info.osFamily ?? 'unknown OS'}, API ${info.sdkApiVersion ?? '?'}, ${info.abi ?? '?'})`;
  if (project?.minApi !== undefined && Number.isFinite(deviceApi) && deviceApi < project.minApi) {
    return {
      id: 'device',
      status: 'fail',
      detail: `${label} is older than the project's API ${project.minApi}: the app will not install`,
      fix: `Use a device or emulator at API ${project.minApi} or newer, or lower compatibleSdkVersion.`,
    };
  }
  if (project && info.osFamily && info.osFamily !== project.runtimeOS) {
    return { id: 'device', status: 'warn', detail: `${label} runs ${info.osFamily}, the project targets ${project.runtimeOS}` };
  }
  return { id: 'device', status: 'ok', detail: devices.length > 1 ? `${label}, ${devices.length - 1} more` : label };
}

/** One hdc call that takes longer than this is worth a warning. */
export const SLOW_HDC_CALL_MS = 700;

/** How long one hdc call takes, ms: the median of three runs. */
export interface HdcSpeed {
  /** `hdc list targets`: the client and its server, without a device. */
  clientMs: number;
  /** `hdc shell echo` on the device: the client, the server and the way to the device. */
  deviceMs?: number;
  /** The device that was called. */
  serial?: string;
}

/**
 * Grade what one hdc call costs. Every device command is at least one call and a
 * layout dump, a screenshot or a replay step are several, so a client or a link
 * that adds a second to each makes `replay`, `record`, `perf` and `test` several
 * times slower with nothing else to show for it: a 58-flow replay run measured
 * 131 minutes at 1.5 s a call and 42 at 0.2 s. Two causes are told apart: the
 * client is slow before it reaches any device (`list targets` is slow too), or
 * only the calls to the device are (a slow server reached with `-s` looks like the
 * first, which the fix says). The first was seen with a device on another
 * machine's server, reached through a wrapper that adds `-s <host:port>`: hdc
 * (3.2.0c and 3.2.0d alike) then finds no server on this machine, forks one and
 * sleeps before every call, unless it is given `-p`. Pure.
 */
export function checkHdcSpeed(speed: HdcSpeed): DoctorCheck {
  const id = 'hdc-speed';
  if (speed.clientMs > SLOW_HDC_CALL_MS) {
    return {
      id,
      status: 'warn',
      detail: `every hdc call takes ${speed.clientMs} ms before it reaches a device (\`hdc list targets\`, median of 3)`,
      fix:
        'If hdc reaches its server through a wrapper or `-s <host:port>`: an hdc client that finds no hdc server running on this machine starts one and sleeps 1.3 s before every call, also then. ' +
        'Keep a local server up (`hdc start`), or have the wrapper call hdc with `-p`, which skips that step; `time hdc list targets` then answers in about 0.2 s. ' +
        'If it stays slow, the server or the way to it is.',
    };
  }
  if (speed.deviceMs !== undefined && speed.deviceMs > SLOW_HDC_CALL_MS) {
    return {
      id,
      status: 'warn',
      detail: `one call to ${speed.serial ?? 'the device'} takes ${speed.deviceMs} ms (hdc alone answers in ${speed.clientMs} ms)`,
      fix: 'The way to the device is slow (an hdc server on another machine, a tunnel, a hub). Commands that make many calls (replay, record, perf, test) take that much longer.',
    };
  }
  return {
    id,
    status: 'ok',
    detail:
      speed.deviceMs !== undefined
        ? `one call to ${speed.serial ?? 'the device'} takes ${speed.deviceMs} ms`
        : `one hdc call takes ${speed.clientMs} ms`,
  };
}

/**
 * The median duration of three runs of `call`, ms. A run that fails throws: a device that
 * is offline or refuses the call answers at once, and its time says nothing of a call that works.
 */
async function medianMs(what: string, call: () => Promise<{ code: number; stdout: string; stderr: string }>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const res = await call();
    if (res.code !== 0) throw new Error(`${what} failed: ${`${res.stderr}${res.stdout}`.trim().split('\n')[0] ?? `exit ${res.code}`}`);
    times.push(Date.now() - t);
  }
  return times.sort((a, b) => a - b)[1]!;
}

/** Time hdc with its server up (the device check has just listed the targets), then one call to the device. */
async function measureHdcSpeed(opts: DoctorOptions, serial: string | undefined, logger: Logger): Promise<DoctorCheck> {
  try {
    const clientMs = await medianMs('hdc list targets', () => hdcExec({ config: opts.config, args: ['list', 'targets'], timeoutMs: 15_000, logger }));
    const deviceMs = serial
      ? await medianMs(`a call to ${serial}`, () => shell({ config: opts.config, command: 'echo', deviceSerial: serial, timeoutMs: 15_000, logger }))
      : undefined;
    return checkHdcSpeed({ clientMs, ...(deviceMs !== undefined ? { deviceMs, serial } : {}) });
  } catch (err) {
    return { id: 'hdc-speed', status: 'skip', detail: `not measured: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The signing material the project's signingConfigs name exists. */
export function checkSigning(project: DoctorProject): DoctorCheck {
  const profile = readProfile(project.dir);
  const configs = profile?.app?.signingConfigs ?? [];
  const product = profile?.app?.products?.[0];
  const wanted = typeof product?.signingConfig === 'string' ? product.signingConfig : undefined;
  const config = configs.find((c) => c.name === wanted) ?? configs[0];
  if (!config?.material) {
    return {
      id: 'signing',
      status: 'warn',
      detail: 'no signingConfigs: the build makes an unsigned HAP, which a device will not install',
      fix: project.runtimeOS === 'HarmonyOS' ? 'oniro-app sign --harmonyos' : 'oniro-app sign',
    };
  }
  const missing: string[] = [];
  for (const key of ['storeFile', 'certpath', 'profile']) {
    const value = config.material[key];
    if (typeof value !== 'string' || !value) {
      missing.push(`${key} (not set)`);
      continue;
    }
    const file = path.resolve(project.dir, value);
    if (!fs.existsSync(file)) missing.push(`${key} ${file}`);
  }
  if (missing.length) {
    return {
      id: 'signing',
      status: 'fail',
      detail: `signingConfig ${String(config.name ?? '')} names material that is missing: ${missing.join(', ')}`,
      fix: project.runtimeOS === 'HarmonyOS' ? 'oniro-app sign --harmonyos' : 'oniro-app sign',
    };
  }
  return { id: 'signing', status: 'ok', detail: `signingConfig ${String(config.name ?? '')} with its p12, certificate and profile` };
}

/** The nearest existing directory at or above `dir`. */
function existingAncestor(dir: string): string {
  let current = path.resolve(dir);
  while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}

/** Free space where SDKs install and where the project builds. */
export function checkDisk(dirs: string[], statfs: (dir: string) => { bavail: number; bsize: number } = fs.statfsSync): DoctorCheck {
  let worst: { dir: string; free: number } | undefined;
  for (const dir of new Set(dirs.map(existingAncestor))) {
    try {
      const s = statfs(dir);
      const free = Number(s.bavail) * Number(s.bsize);
      if (!worst || free < worst.free) worst = { dir, free };
    } catch {
      // Unreadable: skipped.
    }
  }
  if (!worst) return { id: 'disk', status: 'skip', detail: 'free space unknown' };
  const gb = (worst.free / 1024 ** 3).toFixed(1);
  if (worst.free < DISK_FAIL_BYTES) {
    return { id: 'disk', status: 'fail', detail: `${gb} GB free at ${worst.dir}`, fix: 'Free space: a build needs about 1 GB, an SDK install about 3 GB.' };
  }
  if (worst.free < DISK_WARN_BYTES) {
    return { id: 'disk', status: 'warn', detail: `${gb} GB free at ${worst.dir}`, fix: 'An SDK install needs about 3 GB.' };
  }
  return { id: 'disk', status: 'ok', detail: `${gb} GB free at ${worst.dir}` };
}

/**
 * The HarmonyOS emulator, when one is found: on Linux KVM and a GPU render node it can
 * use, and Huawei's agreements accepted. Problems are warnings, since neither builds
 * nor real devices need the emulator.
 */
export function checkHarmonyOsEmulator(
  config: ConfigProvider,
  versions: DoctorVersions,
  opts: { devDir?: string; platform?: NodeJS.Platform; home?: string } = {},
): DoctorCheck {
  const id = 'hos-emulator';
  const emulator = findHarmonyOsEmulator(config);
  if (!emulator) {
    return { id, status: 'skip', detail: 'no HarmonyOS emulator (it comes with the HarmonyOS command-line tools 26.0.0 or later)' };
  }
  if (emulator.version) versions.harmonyosEmulator = emulator.version;
  const where = `Emulator ${emulator.version ?? '(version unknown)'} at ${emulator.dir}`;
  const problems: string[] = [];
  const fixes: string[] = [];
  const host = checkHarmonyOsEmulatorHost(opts);
  for (const c of host ? [host.kvm, host.gpu] : []) {
    if (c.ok) continue;
    problems.push(c.detail);
    if (c.fix) fixes.push(c.fix);
  }
  const agreements = readHarmonyOsEmulatorLicenses(emulator, opts).agreements;
  const pending = agreements.filter((a) => a.accepted === false);
  if (pending.length) {
    problems.push(`${pending.map((a) => a.title).join(' and ')} not accepted`);
    fixes.push('Read them (`oniro-app emulator harmonyos license`), then accept with `oniro-app emulator harmonyos license --accept`.');
  }
  if (problems.length) return { id, status: 'warn', detail: `${where}: ${problems.join('; ')}`, fix: fixes.join(' ') };
  const accepted = agreements.length > 0 && agreements.every((a) => a.accepted === true);
  return { id, status: 'ok', detail: `${where}${host ? ', KVM and GPU accessible' : ''}${accepted ? ', agreements accepted' : ''}` };
}

/** Run every check. Never throws for a failed check; `ok` is false when any check failed. */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const logger = opts.logger ?? noopLogger;
  const env = opts.env ?? process.env;
  const versions: DoctorVersions = { node: process.versions.node };
  const project = opts.projectDir ? describeProject(path.resolve(opts.projectDir)) : undefined;
  const checks: DoctorCheck[] = [];

  checks.push(checkNode());
  checks.push(await checkJava(env, versions));
  if (project) {
    try {
      checks.push(await checkProjectSdk(opts, project, versions, logger));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      checks.push({ id: 'sdk', status: 'fail', detail: err instanceof SdkNotInstalledError ? detail : `SDK install failed: ${detail}` });
    }
  } else {
    checks.push({ id: 'sdk', status: 'skip', detail: 'no project given' });
  }
  const tools = checkCmdTools(opts.config, versions, project);
  checks.push(tools);
  checks.push(
    opts.arktsSelfTest === false
      ? { id: 'arkts-check', status: 'skip', detail: 'self-test not requested' }
      : await checkArktsSelfTest(opts, project, logger),
  );
  const hdc = await checkHdc(opts.config, versions);
  checks.push(hdc);
  if (opts.device === false) {
    checks.push({ id: 'device', status: 'skip', detail: 'device check not requested' });
    checks.push({ id: 'hdc-speed', status: 'skip', detail: 'device check not requested' });
  } else if (hdc.status !== 'ok') {
    checks.push({ id: 'device', status: 'fail', detail: 'hdc is not usable', fix: hdc.fix });
    checks.push({ id: 'hdc-speed', status: 'skip', detail: 'hdc is not usable' });
  } else {
    let serial: string | undefined;
    checks.push(await checkDevice(opts, project, versions, logger, (s) => {
      serial = s;
    }));
    checks.push(await measureHdcSpeed(opts, serial, logger));
  }
  checks.push(checkHarmonyOsEmulator(opts.config, versions));
  checks.push(project ? checkSigning(project) : { id: 'signing', status: 'skip', detail: 'no project given' });
  checks.push(checkDisk([getSdkRootDir(opts.config), ...(project ? [project.dir] : [])]));

  return { ok: checks.every((c) => c.status !== 'fail'), checks, ...(project ? { project } : {}), versions };
}
