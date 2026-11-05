import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSON5 from 'json5';
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { noopLogger } from '../ports/logger.js';
import type { ProgressReporter } from '../ports/progress.js';
import { SdkNotInstalledError } from '../ports/errors.js';
import { runProcess } from '../hdc/exec.js';
import { isUsableDevice, listDevices } from '../hdc/devices.js';
import { getDeviceInfo } from '../device/info.js';
import { getCmdToolsStatus } from '../cmdTools/install.js';
import { getCmdToolsPath, getHdcPath, getOhosBaseSdkHome, getSdkRootDir } from '../sdk/paths.js';
import { getInstalledSdks } from '../sdk/list.js';
import { downloadAndInstallSdk, type InstallSdkOptions } from '../sdk/install.js';
import { findMissingProjectSdk, resolveProjectSdkDir } from '../sdk/detectProjectSdk.js';
import { ALL_SDKS } from '../sdk/constants.js';
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
  /** Stable key: `node`, `java`, `sdk`, `cmdtools`, `cmdtools-flavour`, `arkts-check`, `hdc`, `device`, `signing`, `disk`. */
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
  /** A project to check the SDK, flavour, device API and signing for. */
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

/** The command-line tools are installed, complete, and of a recorded version. */
export function checkCmdTools(config: ConfigProvider, versions: DoctorVersions): DoctorCheck {
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
  return { id: 'cmdtools', status: 'ok', detail: `${status.flavour ?? ''} ${version ?? 'version unknown'} at ${dir}`.trim() };
}

/** codelinter only fully checks projects of its own flavour (#21). */
export function checkCmdToolsFlavour(
  versions: DoctorVersions,
  project: DoctorProject | undefined,
  toolsOk = true,
): DoctorCheck {
  if (!project) return { id: 'cmdtools-flavour', status: 'skip', detail: 'no project given' };
  // A partial install may lack sdk/default/hms, which is what tells the flavours apart.
  if (!versions.cmdToolsFlavour || !toolsOk) {
    return { id: 'cmdtools-flavour', status: 'skip', detail: 'command-line tools missing or incomplete' };
  }
  if (versions.cmdToolsFlavour === project.runtimeOS) {
    return { id: 'cmdtools-flavour', status: 'ok', detail: `${versions.cmdToolsFlavour} tools, ${project.runtimeOS} project` };
  }
  return {
    id: 'cmdtools-flavour',
    status: 'fail',
    detail:
      `the command-line tools are the ${versions.cmdToolsFlavour} flavour and the project targets ${project.runtimeOS}, ` +
      'so codelinter skips its checks (`lint` exits 2)',
    fix:
      `Point ONIRO_CMD_TOOLS_PATH at ${project.runtimeOS} command-line tools for \`lint\`, or gate on ` +
      '`oniro-app check arkts`, which does not use them.',
  };
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
    return { id: 'sdk', status: 'fail', detail: 'build-profile.json5 declares no numeric compileSdkVersion', fix: 'Set compileSdkVersion in build-profile.json5.' };
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
  versions.sdk = resolveProjectSdkDir(opts.config, project.dir) ?? path.join(getOhosBaseSdkHome(opts.config), String(api));
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
    // getInstalledSdks lists release versions; the directories are named by API level.
    const installed = getInstalledSdks(opts.config)
      .map((version) => Number(ALL_SDKS.find((s) => s.version === version)?.api))
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
    if (installed[0] === undefined) {
      return { id: 'arkts-check', status: 'skip', detail: 'no OpenHarmony SDK installed' };
    }
    api = installed[0];
    sdkDir = path.join(getOhosBaseSdkHome(opts.config), String(api));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-doctor-'));
  try {
    const level = api ?? 12;
    const main = path.join(tmp, 'entry', 'src', 'main');
    fs.mkdirSync(path.join(main, 'ets', 'pages'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'build-profile.json5'),
      JSON.stringify({
        app: { products: [{ name: 'default', compileSdkVersion: level, compatibleSdkVersion: level, runtimeOS: project?.runtimeOS ?? 'OpenHarmony' }] },
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
  const tools = checkCmdTools(opts.config, versions);
  checks.push(tools);
  checks.push(checkCmdToolsFlavour(versions, project, tools.status === 'ok'));
  checks.push(
    opts.arktsSelfTest === false
      ? { id: 'arkts-check', status: 'skip', detail: 'self-test not requested' }
      : await checkArktsSelfTest(opts, project, logger),
  );
  const hdc = await checkHdc(opts.config, versions);
  checks.push(hdc);
  if (opts.device === false) {
    checks.push({ id: 'device', status: 'skip', detail: 'device check not requested' });
  } else if (hdc.status !== 'ok') {
    checks.push({ id: 'device', status: 'fail', detail: 'hdc is not usable', fix: hdc.fix });
  } else {
    checks.push(await checkDevice(opts, project, versions, logger));
  }
  checks.push(project ? checkSigning(project) : { id: 'signing', status: 'skip', detail: 'no project given' });
  checks.push(checkDisk([getSdkRootDir(opts.config), ...(project ? [project.dir] : [])]));

  return { ok: checks.every((c) => c.status !== 'fail'), checks, ...(project ? { project } : {}), versions };
}
