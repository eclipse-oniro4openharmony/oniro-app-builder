import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { VERSION, hdcExec, parseDeviceList, shellChecked, type ConfigProvider, type HdcExecResult } from '@oniroproject/core';

export interface CollectLogBundleOptions {
  config: ConfigProvider;
  outputDirectory: string;
  deviceSerial?: string;
  packageName?: string;
  pid?: string;
  tag?: string;
  level?: string;
  redact: boolean;
  execute?: (args: readonly string[], deviceSerial?: string) => Promise<HdcExecResult>;
}

export interface LogBundleResult {
  bundleDirectory: string;
  archivePath: string | null;
  redactedDirectory: string | null;
  complete: boolean;
  error?: string;
}

interface CommandRecord {
  name: string;
  status: 'success' | 'failed';
  output: string | null;
  stderr: string | null;
  exitCode: number | null;
  error: string | null;
}

const LEVELS: Record<string, string> = {
  V: 'V', VERBOSE: 'V', D: 'D', DEBUG: 'D', I: 'I', INFO: 'I',
  W: 'W', WARN: 'W', WARNING: 'W', E: 'E', ERROR: 'E', F: 'F', FATAL: 'F',
};
const HILOG_RECORD = /^(?<date>\d{2}-\d{2})[ \t]+(?<time>\d{2}:\d{2}:\d{2}\.\d{3})[ \t]+(?<pid>\d+)[ \t]+\d+[ \t]+(?<level>[VDIWEF])[ \t]+(?:[A-Za-z][0-9A-Fa-f]{5,8}|[0-9A-Fa-f]{1,8})\/(?:(?:[^\s/]+)\/)*(?<tag>[^\s/]*):(?:[ \t].*|)$/;
const FAILURE_TEXT = /^(?:\s*(?:\[(?:fail|error)\]|(?:error|failed|failure):|permission denied\b|no devices? connected\b|too many arguments\b|unknown option\b|invalid option\b|command not found\b)|\s*(?:hdc|device)\b.*\b(?:error|failed|no device|not connected|offline)\b)/im;

function validateDate(date: string, time: string): boolean {
  const [, monthText, dayText] = /^(\d{2})-(\d{2})$/.exec(date) ?? [];
  const [, hourText, minuteText, secondText, millisecondText] = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(time) ?? [];
  if (!monthText || !dayText || !hourText || !minuteText || !secondText || !millisecondText) return false;
  const value = new Date(Date.UTC(2000, Number(monthText) - 1, Number(dayText), Number(hourText), Number(minuteText), Number(secondText), Number(millisecondText)));
  return value.getUTCMonth() === Number(monthText) - 1 && value.getUTCDate() === Number(dayText) &&
    Number(hourText) < 24 && Number(minuteText) < 60 && Number(secondText) < 60;
}

export function filterHilog(
  input: string,
  filters: { pid?: string; tag?: string; level?: string },
): { text: string; applied: string[] } | null {
  const criteria: Record<string, string> = {};
  if (filters.pid) criteria.pid = filters.pid.replace(/^0+(?=\d)/, '');
  if (filters.tag) criteria.tag = filters.tag;
  if (filters.level) criteria.level = LEVELS[filters.level.toUpperCase()] ?? filters.level.toUpperCase();
  if (Object.keys(criteria).length === 0) return null;

  let sawRecord = false;
  let keep = false;
  let output = '';
  for (const line of input.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const content = line.replace(/[\r\n]+$/, '');
    const match = HILOG_RECORD.exec(content);
    if (match?.groups) {
      if (!validateDate(match.groups.date!, match.groups.time!)) return null;
      sawRecord = true;
      keep = Object.entries(criteria).every(([key, value]) => {
        const field = match.groups![key];
        return key === 'pid' ? field?.replace(/^0+(?=\d)/, '') === value : field === value;
      });
    } else if (/^\s*\[?\d{1,4}[-/]/.test(content) || (!sawRecord && content.trim())) {
      return null;
    }
    if (keep) output += line;
  }
  return sawRecord ? { text: output, applied: Object.keys(criteria) } : null;
}

export function redactLogText(value: string, deviceSerials: readonly string[] = []): string {
  let result = value
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(\bBasic\s+)[A-Za-z0-9+/=]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|passwd|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(cookie\s*[=:]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/((?:phone|mobile|telephone|tel)(?:number)?\s*[=:]\s*)\+?[\d ()-]{8,}\d/gi, '$1[REDACTED_PHONE]')
    .replace(/(?<![\w.])(?:\+\d{1,3}[ -]?)?\(?\d{2,4}\)?[ -]\d{3,4}[ -]\d{3,4}(?![\w.])/g, '[REDACTED_PHONE]')
    .replace(/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, '[REDACTED_MAC]')
    .replace(/([A-Z]:\\Users\\)[^\\\r\n "']+/gi, '$1[REDACTED_USER]')
    .replace(/(\/(?:Users|home)\/)[^/\r\n "']+/gi, '$1[REDACTED_USER]')
    .replace(/("(?:target|deviceSerial)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED_DEVICE]$2')
    .replace(/(--device\s+|-t\s+)([A-Za-z0-9._:-]+)/gi, '$1[REDACTED_DEVICE]');

  for (const serial of deviceSerials) {
    if (serial) result = result.split(serial).join('[REDACTED_DEVICE]');
  }

  const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  result = result.replace(ipv4, (address, offset: number, whole: string) => {
    const prefix = whole.slice(Math.max(0, offset - 48), offset);
    const suffix = whole.slice(offset + address.length);
    const contextual = /(?:ip|addr(?:ess)?|host|peer|remote|local|endpoint|server|client|target|device(?:id)?|serial)[^\r\n]{0,24}$/i.test(prefix);
    const hasPort = /^:\d{1,5}(?!\d)/.test(suffix);
    const octets = address.split('.').map(Number);
    return octets.every((part: number) => part <= 255) && (contextual || hasPort) ? '[REDACTED_IP]' : address;
  });
  return result;
}

function decodeText(data: Buffer, relativePath: string): string {
  let text: string;
  if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) text = data.toString('utf16le').slice(1);
  else if (data.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    const swapped = Buffer.from(data.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
    text = swapped.toString('utf16le');
  } else {
    const utf8 = data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? data.subarray(3) : data;
    if (utf8.includes(0)) throw new Error(`Binary data cannot be safely redacted: ${relativePath}`);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(utf8);
    } catch {
      throw new Error(`Non-UTF-8 data cannot be safely redacted: ${relativePath}`);
    }
  }
  if (text.includes('\u0000')) throw new Error(`Binary data cannot be safely redacted: ${relativePath}`);
  if (text.includes('\ufffd')) throw new Error(`Invalid text encoding cannot be safely redacted: ${relativePath}`);
  return text;
}

async function redactTree(source: string, destination: string, serials: readonly string[]): Promise<void> {
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const sourcePath = path.join(directory, entry.name);
        const relative = path.relative(source, sourcePath);
        const destinationPath = path.join(destination, relative);
        if (entry.isDirectory()) {
          await fs.mkdir(destinationPath, { recursive: true, mode: 0o700 });
          await visit(sourcePath);
        } else if (entry.isFile()) {
          const text = decodeText(await fs.readFile(sourcePath), relative);
          await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
          await fs.writeFile(destinationPath, redactLogText(text, serials), { encoding: 'utf8', mode: 0o600 });
        }
      }
    };
    await visit(source);
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC_TABLE.length; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[i] = value >>> 0;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

async function writeZip(source: string, archivePath: string): Promise<void> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile()) files.push(filePath);
    }
  };
  await visit(source);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const stamp = dosDateTime(new Date());

  for (const filePath of files) {
    const name = Buffer.from(path.relative(source, filePath).split(path.sep).join('/'), 'utf8');
    const data = await fs.readFile(filePath);
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  await fs.writeFile(archivePath, Buffer.concat([...localParts, centralDirectory, end]), { flag: 'wx', mode: 0o600 });
}

function commandFailure(result: HdcExecResult): string | null {
  if (result.code !== 0) return `hdc exited with code ${result.code}`;
  if (result.stderr.trim()) return 'hdc wrote to stderr';
  const lines = result.stdout.trim().split(/\r?\n/);
  const content = lines.length === 1 ? lines[0] : lines.find((line) => /^\s*(?:\[(?:fail|error)\]|(?:hdc|device)\b.*\b(?:error|failed|no device|not connected|offline))(?=\s|$)/i.test(line));
  const contentError = content && FAILURE_TEXT.test(content) ? content.trim() : null;
  return contentError ? `command output indicates failure: ${contentError}` : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function uniqueBundleDirectory(outputDirectory: string, stamp: string): Promise<string> {
  await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  for (let suffix = 0; ; suffix++) {
    const name = `incident-${stamp}${suffix ? `-${suffix}` : ''}`;
    const directory = path.join(outputDirectory, name);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export async function collectLogBundle(options: CollectLogBundleOptions): Promise<LogBundleResult> {
  if (options.packageName && !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(options.packageName)) {
    throw new Error('packageName must be a reverse-DNS bundle name.');
  }
  if (options.pid && !/^[1-9]\d*$/.test(options.pid)) throw new Error('pid must be a positive integer.');
  if (options.tag && !/^[^\s/\x00-\x1f\x7f]+$/.test(options.tag)) throw new Error('tag must be a single HiLog tag.');
  if (options.level && !LEVELS[options.level.toUpperCase()]) throw new Error('level is not a recognized HiLog level.');

  const started = new Date();
  const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const bundleDirectory = await uniqueBundleDirectory(path.resolve(options.outputDirectory), stamp);
  const records: CommandRecord[] = [];
  const serials: string[] = [];
  const execute = options.execute ?? ((args, deviceSerial) => args[0] === 'shell'
    ? shellChecked({ config: options.config, command: args.slice(1).join(' '), deviceSerial })
    : hdcExec({ config: options.config, args, deviceSerial }));
  const manifest: Record<string, unknown> = {
    schemaVersion: '1.0',
    collectorVersion: VERSION,
    collectionStartUtc: started.toISOString(),
    collectionEndUtc: null,
    host: { os: process.platform },
    target: null,
    packageName: options.packageName ?? null,
    pid: options.pid ?? null,
    filters: {
      tag: options.tag ?? null,
      level: options.level ?? null,
      pid: options.pid ?? null,
      packageName: options.packageName ?? null,
      durationSeconds: null,
    },
    filterStatus: {
      duration: 'not-applied',
      packageName: options.packageName ? 'failed' : 'not-requested',
      pid: options.pid ? 'not-applied' : 'not-requested',
      tag: options.tag ? 'not-applied' : 'not-requested',
      level: options.level ? 'not-applied' : 'not-requested',
    },
    hilogWindowApplied: false,
    redactionRequested: options.redact,
    redactionStatus: options.redact ? 'pending' : 'not-requested',
    archiveStatus: { status: 'pending', path: null },
    commands: records,
    files: [],
    notes: [
      'Collection is read-only on the target device.',
      'hilog -x captures the current device buffer and does not support a duration filter.',
      'Redaction is heuristic and does not guarantee that a bundle is safe to publish.',
    ],
  };

  const run = async (name: string, relativeOutput: string, args: readonly string[], deviceSerial?: string): Promise<CommandRecord> => {
    const outputPath = path.join(bundleDirectory, relativeOutput);
    await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    let result: HdcExecResult | null = null;
    let failure: string | null = null;
    try {
      result = await execute(args, deviceSerial);
      await fs.writeFile(outputPath, result.stdout, { encoding: 'utf8', mode: 0o600 });
      if (result.stderr) await fs.writeFile(`${outputPath}.stderr.txt`, result.stderr, { encoding: 'utf8', mode: 0o600 });
      failure = commandFailure(result);
    } catch (error) {
      failure = errorMessage(error);
      await fs.writeFile(outputPath, '', { encoding: 'utf8', mode: 0o600 });
    }
    const record: CommandRecord = {
      name,
      status: failure ? 'failed' : 'success',
      output: relativeOutput,
      stderr: result?.stderr ? `${relativeOutput}.stderr.txt` : null,
      exitCode: result?.code ?? null,
      error: failure,
    };
    records.push(record);
    return record;
  };

  const targetRecord = await run('list-targets', 'device/targets.txt', ['list', 'targets', '-v']);
  const targetOutput = await fs.readFile(path.join(bundleDirectory, 'device/targets.txt'), 'utf8').catch(() => '');
  const targets = parseDeviceList(targetOutput).filter((target) => target.status === 'Connected' || target.status === 'Unknown');
  serials.push(...parseDeviceList(targetOutput).map((target) => target.serial));
  const requestedDevice = options.deviceSerial || process.env.ONIRO_DEVICE_SERIAL || process.env.DEVICE_SERIAL;
  let selectedDevice: string | null = null;
  let targetError: string | null = null;
  if (targetRecord.status !== 'success') targetError = targetRecord.error ?? 'hdc target discovery failed';
  else if (requestedDevice) {
    selectedDevice = targets.find((target) => target.serial === requestedDevice)?.serial ?? null;
    if (!selectedDevice) targetError = 'selected device was not discovered as connected';
  } else if (targets.length === 0) targetError = 'hdc did not discover a connected device';
  else if (targets.length > 1) targetError = 'multiple devices are connected; specify --device';
  else selectedDevice = targets[0]!.serial;

  if (targetError) {
    targetRecord.status = 'failed';
    targetRecord.error = targetError;
    (manifest.notes as string[]).push('Device collection stopped because target discovery did not identify exactly one selected connected device.');
  } else {
    manifest.target = selectedDevice;
    const shell = (args: readonly string[]) => run(args[0]!, args[1]!, args.slice(2), selectedDevice!);
    await shell(['device-name', 'device/device-info.txt', 'shell', 'param', 'get', 'const.product.name']);
    await shell(['process-list', 'device/process-list.txt', 'shell', 'ps', '-ef']);
    await shell(['memory', 'device/memory.txt', 'shell', 'hidumper', '--mem']);
    await shell(['threads', 'device/threads.txt', 'shell', 'hidumper', '-p']);

    const hilog = await shell(['hilog-snapshot', 'logs/hilog.txt', 'shell', 'hilog', '-x']);
    const faultArgs = options.packageName
      ? ['faultlog', 'logs/faultlog.txt', 'shell', 'hidumper', '-e', '--print', options.packageName, '-n', '5']
      : ['faultlog', 'logs/faultlog.txt', 'shell', 'hidumper', '-e', '--list', '-n', '20'];
    const faultlog = await shell(faultArgs);
    manifest.filterStatus = {
      duration: 'not-applied',
      packageName: options.packageName ? (faultlog.status === 'success' ? 'applied' : 'failed') : 'not-requested',
      pid: options.pid ? 'not-applied' : 'not-requested',
      tag: options.tag ? 'not-applied' : 'not-requested',
      level: options.level ? 'not-applied' : 'not-requested',
    };
    if (hilog.status === 'success' && (options.pid || options.tag || options.level)) {
      const source = await fs.readFile(path.join(bundleDirectory, 'logs/hilog.txt'), 'utf8');
      const filtered = filterHilog(source, { pid: options.pid, tag: options.tag, level: options.level });
      if (filtered) {
        await fs.writeFile(path.join(bundleDirectory, 'logs/hilog-filtered.txt'), filtered.text, { encoding: 'utf8', mode: 0o600 });
        const status = manifest.filterStatus as Record<string, string>;
        for (const key of filtered.applied) status[key] = 'applied';
      } else {
        (manifest.notes as string[]).push('Requested HiLog filters were not applied because the snapshot format could not be parsed reliably.');
      }
    }
  }

  const ended = new Date();
  manifest.collectionEndUtc = ended.toISOString();
  const files = records.flatMap((record) => [record.output, record.stderr].filter((file): file is string => Boolean(file)));
  files.push('manifest.json', 'notes.txt');
  if (await fs.access(path.join(bundleDirectory, 'logs/hilog-filtered.txt')).then(() => true, () => false)) {
    files.push('logs/hilog-filtered.txt');
  }
  manifest.files = files;
  await fs.writeFile(path.join(bundleDirectory, 'notes.txt'), 'Add reproduction steps and precise event timestamps here.\n', { encoding: 'utf8', mode: 0o600 });

  const criticalFailure = Boolean(targetError) || records.some((record) => record.name === 'hilog-snapshot' && record.status !== 'success');
  const anyCommandFailure = records.some((record) => record.status !== 'success');
  let redactedDirectory: string | null = null;
  let archivePath: string | null = null;
  let bundleError: string | undefined;

  try {
    if (options.redact) {
      redactedDirectory = `${bundleDirectory}-redacted`;
      manifest.redactionStatus = 'success';
      manifest.archiveStatus = { status: 'success', path: `${path.basename(redactedDirectory)}.zip` };
      await fs.writeFile(path.join(bundleDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await redactTree(bundleDirectory, redactedDirectory, serials);
      archivePath = `${redactedDirectory}.zip`;
      await writeZip(redactedDirectory, archivePath);
    } else {
      archivePath = `${bundleDirectory}.zip`;
      manifest.archiveStatus = { status: 'success', path: path.basename(archivePath) };
      await fs.writeFile(path.join(bundleDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await writeZip(bundleDirectory, archivePath);
    }
  } catch (error) {
    bundleError = options.redact ? `redaction or archive creation failed: ${errorMessage(error)}` : `archive creation failed: ${errorMessage(error)}`;
    archivePath = null;
    manifest.redactionStatus = options.redact ? 'failed' : 'not-requested';
    manifest.archiveStatus = { status: 'failed', path: null };
    (manifest.notes as string[]).push(bundleError);
    await fs.rm(`${redactedDirectory ?? bundleDirectory}.zip`, { force: true }).catch(() => undefined);
    if (redactedDirectory) await fs.rm(redactedDirectory, { recursive: true, force: true }).catch(() => undefined);
    await fs.writeFile(path.join(bundleDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    redactedDirectory = null;
  }

  return {
    bundleDirectory,
    archivePath,
    redactedDirectory,
    complete: !criticalFailure && !anyCommandFailure && !bundleError,
    error: bundleError ?? (criticalFailure ? targetError ?? 'HiLog collection failed' : undefined),
  };
}
