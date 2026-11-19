import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { localPropertiesSdkDir, withLocalPropertiesSdkDir, withSdkDirLine } from '../src/sdk/localProperties.js';

describe('withSdkDirLine', () => {
  it('replaces sdk.dir and keeps the other keys', () => {
    expect(withSdkDirLine('hwsdk.dir=/hos\nsdk.dir = /old\nnodejs.dir=/node\n', '/new')).toBe(
      'hwsdk.dir=/hos\nsdk.dir=/new\nnodejs.dir=/node\n',
    );
  });

  it('appends sdk.dir when there is none, on a line of its own', () => {
    expect(withSdkDirLine('', '/new')).toBe('sdk.dir=/new\n');
    expect(withSdkDirLine('# comment', '/new')).toBe('# comment\nsdk.dir=/new\n');
  });

  it('writes the path literally', () => {
    expect(withSdkDirLine('sdk.dir=/old\n', '/a/$&/b')).toBe('sdk.dir=/a/$&/b\n');
  });
});

describe('withLocalPropertiesSdkDir', () => {
  let dir: string;
  const file = () => path.join(dir, 'local.properties');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-localprops-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('sets sdk.dir for the run, then restores the original bytes', async () => {
    const original = 'sdk.dir=/old\r\nhwsdk.dir=/hos\r\n';
    fs.writeFileSync(file(), original);
    const seen = await withLocalPropertiesSdkDir(dir, '/new', async () => localPropertiesSdkDir(dir));
    expect(seen).toBe('/new');
    expect(fs.readFileSync(file(), 'utf8')).toBe(original);
  });

  it('names the file and the line to add when it cannot write it', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    fs.chmodSync(dir, 0o555);
    try {
      await expect(withLocalPropertiesSdkDir(dir, '/new', async () => 'ran')).rejects.toThrow(
        /Cannot write .*local\.properties.*add sdk\.dir=\/new yourself/,
      );
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('removes the file it created, also when the run throws', async () => {
    await expect(
      withLocalPropertiesSdkDir(dir, '/new', async () => {
        expect(fs.readFileSync(file(), 'utf8')).toBe('sdk.dir=/new\n');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(file())).toBe(false);
  });
});
