import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { staticConfig, type HdcExecResult } from '@oniroproject/core';
import { collectLogBundle, filterHilog, redactLogText } from '../src/lib/logBundle.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oniro-logs-test-'));
  roots.push(directory);
  return directory;
}

function result(stdout = '', code = 0, stderr = ''): HdcExecResult {
  return { stdout, code, stderr };
}

const targets = 'ABC123 Connected USB\n';
const hilog = [
  '01-02 03:04:05.006 42 42 I D003900/MyTag: user=alice@example.com peer=10.0.0.8:5555',
  '  #00 pc 0000007f12345678 /system/lib64/libsample.so',
  '01-02 03:04:06.007 43 43 E D003900/OtherTag: buildVersion=1.2.3',
].join('\n') + '\n';

function fakeHdc(overrides: Record<string, HdcExecResult> = {}) {
  return vi.fn(async (args: readonly string[]): Promise<HdcExecResult> => {
    const command = args.join(' ');
    if (command === 'list targets -v') return result(targets);
    if (command === 'shell hilog -x') return overrides.hilog ?? result(hilog);
    if (command.startsWith('shell hidumper -e')) return overrides.faultlog ?? result('faultlog entry\n');
    if (command.startsWith('shell param get')) return result('Oniro Test Device\n');
    if (command.startsWith('shell ps')) return result('USER PID NAME\n');
    if (command.startsWith('shell hidumper --mem')) return result('memory snapshot\n');
    if (command.startsWith('shell hidumper -p')) return result('thread snapshot\n');
    return result();
  });
}

function readZipTextFiles(archive: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = archive.toString('utf8', nameStart, nameStart + nameLength);
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    files.set(name, data.toString('utf8'));
    offset = dataStart + compressedSize;
  }
  return files;
}

describe('filterHilog', () => {
  it('matches exact fields and preserves continuation lines', () => {
    const input = `${hilog}`;
    const filtered = filterHilog(input, { pid: '42', tag: 'MyTag', level: 'INFO' });
    expect(filtered?.applied).toEqual(['pid', 'tag', 'level']);
    expect(filtered?.text).toContain('42 42 I D003900/MyTag');
    expect(filtered?.text).toContain('#00 pc 0000007f12345678');
    expect(filtered?.text).not.toContain('OtherTag');
  });

  it('declines to filter an unknown timestamped format', () => {
    expect(filterHilog('2026-01-02 03:04:05 unknown format\n', { tag: 'MyTag' })).toBeNull();
  });
});

describe('redactLogText', () => {
  it('redacts network addresses without damaging crash details or version strings', () => {
    const redacted = redactLogText(
      'peer=10.0.0.8:5555 buildVersion=10.0.0 #00 pc 0000007f12345678 /system/lib64/libsample.so',
    );
    expect(redacted).toContain('peer=[REDACTED_IP]:5555');
    expect(redacted).toContain('buildVersion=10.0.0');
    expect(redacted).toContain('0000007f12345678 /system/lib64/libsample.so');
  });

  it('redacts credentials, user paths, and selected device IDs', () => {
    const redacted = redactLogText(
      'token=abc123 home=C:\\Users\\alice\\logs unix=/home/bob/project auth=Basic YWJjMTIz email=alice@example.com phone=+1 415 555 0132',
      ['USB-DEVICE-7'],
    );
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('bob');
    expect(redacted).not.toContain('YWJjMTIz');
    expect(redacted).not.toContain('USB-DEVICE-7');
    expect(redacted).toContain('[REDACTED_PHONE]');
  });
});

describe('collectLogBundle', () => {
  it('redacts before archiving and preserves crash diagnostics', async () => {
    const outputDirectory = await tempDirectory();
    const execute = fakeHdc();
    const bundle = await collectLogBundle({
      config: staticConfig(), outputDirectory, redact: true, execute,
    });

    expect(bundle.complete).toBe(true);
    expect(bundle.archivePath).toMatch(/incident-.*-redacted\.zip$/);
    expect(await fs.stat(bundle.archivePath!)).toBeTruthy();
    const files = readZipTextFiles(await fs.readFile(bundle.archivePath!));
    const archivedManifest = JSON.parse(files.get('manifest.json')!);
    const archivedHilog = files.get('logs/hilog.txt')!;
    expect(archivedManifest.redactionStatus).toBe('success');
    expect(archivedManifest.archiveStatus.status).toBe('success');
    expect(archivedManifest.target).toBe('[REDACTED_DEVICE]');
    expect(archivedHilog).not.toContain('alice@example.com');
    expect(archivedHilog).toContain('peer=[REDACTED_IP]:5555');
    expect(archivedHilog).toContain('0000007f12345678 /system/lib64/libsample.so');
    expect(archivedHilog).toContain('buildVersion=1.2.3');
    expect([...files.values()].join('\n')).not.toContain('ABC123');
    expect(execute).toHaveBeenCalledWith(['shell', 'hilog', '-x'], 'ABC123');
  });

  it('records requested filters and runs package-specific faultlog collection', async () => {
    const outputDirectory = await tempDirectory();
    const execute = fakeHdc();
    const bundle = await collectLogBundle({
      config: staticConfig(), outputDirectory, redact: false, packageName: 'com.example.app',
      pid: '42', tag: 'MyTag', level: 'I', execute,
    });

    expect(bundle.complete).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      ['shell', 'hidumper', '-e', '--print', 'com.example.app', '-n', '5'], 'ABC123',
    );
    const filtered = await fs.readFile(path.join(bundle.bundleDirectory, 'logs/hilog-filtered.txt'), 'utf8');
    expect(filtered).toContain('MyTag');
    expect(filtered).not.toContain('OtherTag');
    const manifest = JSON.parse(await fs.readFile(path.join(bundle.bundleDirectory, 'manifest.json'), 'utf8'));
    expect(manifest.filterStatus).toMatchObject({ packageName: 'applied', pid: 'applied', tag: 'applied', level: 'applied' });
    expect(manifest.filterStatus.duration).toBe('not-applied');
    expect(manifest.hilogWindowApplied).toBe(false);
  });

  it('treats hdc success with failure text as a failed collector and still packages evidence', async () => {
    const outputDirectory = await tempDirectory();
    const execute = fakeHdc({ hilog: result('[Fail] permission denied\n') });
    const bundle = await collectLogBundle({
      config: staticConfig(), outputDirectory, redact: true, execute,
    });

    expect(bundle.complete).toBe(false);
    expect(bundle.archivePath).not.toBeNull();
    const manifest = JSON.parse(await fs.readFile(path.join(bundle.bundleDirectory, 'manifest.json'), 'utf8'));
    expect(manifest.commands.find((command: { name: string }) => command.name === 'hilog-snapshot')).toMatchObject({
      status: 'failed', exitCode: 0,
    });
    const archived = readZipTextFiles(await fs.readFile(bundle.archivePath!));
    expect(archived.has('logs/faultlog.txt')).toBe(true);
  });

  it('records stderr as failure even when hdc exits zero and continues collecting', async () => {
    const outputDirectory = await tempDirectory();
    const execute = fakeHdc({ faultlog: result('partial fault data\n', 0, 'Permission denied\n') });
    const bundle = await collectLogBundle({
      config: staticConfig(), outputDirectory, redact: true, execute,
    });

    expect(bundle.complete).toBe(false);
    const manifest = JSON.parse(await fs.readFile(path.join(bundle.bundleDirectory, 'manifest.json'), 'utf8'));
    const faultlog = manifest.commands.find((command: { name: string }) => command.name === 'faultlog');
    expect(faultlog).toMatchObject({ status: 'failed', exitCode: 0, stderr: 'logs/faultlog.txt.stderr.txt' });
    expect(manifest.files).toContain('logs/faultlog.txt.stderr.txt');
    expect(bundle.archivePath).not.toBeNull();
  });

  it('refuses to create a redacted archive when output contains unknown binary data', async () => {
    const outputDirectory = await tempDirectory();
    const execute = fakeHdc({ hilog: result('prefix\u0000binary\n') });
    const bundle = await collectLogBundle({
      config: staticConfig(), outputDirectory, redact: true, execute,
    });

    expect(bundle.archivePath).toBeNull();
    expect(bundle.redactedDirectory).toBeNull();
    const manifest = JSON.parse(await fs.readFile(path.join(bundle.bundleDirectory, 'manifest.json'), 'utf8'));
    expect(manifest.redactionStatus).toBe('failed');
    expect(manifest.archiveStatus.status).toBe('failed');
    await expect(fs.stat(`${bundle.bundleDirectory}-redacted.zip`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes a host-only manifest when no device is connected', async () => {
    const outputDirectory = await tempDirectory();
    const execute = vi.fn(async () => result('[Empty]\n'));
    const bundle = await collectLogBundle({
      config: staticConfig(), outputDirectory, redact: true, execute,
    });

    expect(bundle.complete).toBe(false);
    expect(bundle.archivePath).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(await fs.readFile(path.join(bundle.bundleDirectory, 'manifest.json'), 'utf8'));
    expect(manifest.target).toBeNull();
    expect(manifest.commands[0].status).toBe('failed');
  });

  it('rejects unsafe package values before invoking hdc', async () => {
    const execute = vi.fn();
    await expect(collectLogBundle({
      config: staticConfig(), outputDirectory: await tempDirectory(), redact: true,
      packageName: 'com.example; reboot', execute,
    })).rejects.toThrow(/reverse-DNS/);
    expect(execute).not.toHaveBeenCalled();
  });
});
