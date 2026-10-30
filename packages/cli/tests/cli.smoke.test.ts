import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from './_helpers/runCli.js';

describe('oniro-app --help / --version', () => {
  it('--version exits 0 and prints a version', () => {
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help exits 0 and lists every top-level command', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    for (const cmd of [
      'sdk', 'cmdtools', 'emulator', 'build', 'sign', 'auth', 'app', 'create', 'templates',
      'reboot', 'wait', 'watch', 'logs', 'screenshot', 'dump', 'devices', 'file', 'lint', 'input', 'gesture',
    ]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it('exits non-zero on an unknown command', () => {
    const r = runCli(['no-such-command']);
    expect(r.status).not.toBe(0);
  });
});

describe('oniro-app sdk list', () => {
  it('--json emits a valid JSON array with the expected shape', () => {
    const r = runCli(['sdk', 'list', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ version: string; api: string; installed: boolean }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(typeof entry.version).toBe('string');
      expect(typeof entry.api).toBe('string');
      expect(typeof entry.installed).toBe('boolean');
    }
  });

  it('includes SDK 6.1 (api 23) in the known list', () => {
    const r = runCli(['sdk', 'list', '--json']);
    const parsed = JSON.parse(r.stdout) as Array<{ version: string; api: string }>;
    const found = parsed.find((s) => s.version === '6.1');
    expect(found).toBeDefined();
    expect(found?.api).toBe('23');
  });

  it('includes SDK 7.0 (api 26) in the known list', () => {
    const r = runCli(['sdk', 'list', '--json']);
    const parsed = JSON.parse(r.stdout) as Array<{ version: string; api: string }>;
    const found = parsed.find((s) => s.version === '7.0');
    expect(found).toBeDefined();
    expect(found?.api).toBe('26');
  });

  it('plain output exits 0 and uses an asterisk to mark installs', () => {
    const r = runCli(['sdk', 'list']);
    expect(r.status).toBe(0);
    // Either spaces or '*' at column 0, then space, then version.
    expect(r.stdout).toMatch(/^[* ]  \S+\s+api \d+/m);
  });
});

describe('oniro-app sdk install', () => {
  it('--help documents --from-archive and where to get the full SDK', () => {
    const r = runCli(['sdk', 'install', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--from-archive <path>');
    expect(r.stdout).toContain('https://dcp.openharmony.cn/workbench/cicd/dailybuild/dailylist');
  });

  it('without a version or --from-archive fails, naming both and the full-SDK tip', () => {
    const r = runCli(['sdk', 'install']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Name an SDK version .* or pass --from-archive/);
    expect(r.stderr).toContain('dailybuild');
  });

  it('rejects a version together with --from-archive', () => {
    const r = runCli(['sdk', 'install', '7.0', '--from-archive', 'x.tar.gz']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not both');
  });

  it('reports a missing archive', () => {
    const r = runCli(['sdk', 'install', '--from-archive', path.join(os.tmpdir(), 'oniro-no-such-sdk.tar.gz')]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SDK archive not found');
  });
});

describe('oniro-app templates list', () => {
  it('--json includes EmptyAbility with required fields', () => {
    const r = runCli(['templates', 'list', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ id: string; label: string; defaultModuleName: string }>;
    const empty = parsed.find((t) => t.id === 'EmptyAbility');
    expect(empty).toBeDefined();
    expect(empty?.defaultModuleName).toBe('entry');
  });
});

describe('oniro-app create validation', () => {
  it('errors out when --name is missing', () => {
    const r = runCli(['create', '--bundle', 'com.example.a', '--location', '/tmp', '--sdk', '23']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--name/);
  });

  it('errors out on an invalid project name', () => {
    const r = runCli([
      'create',
      '--name',
      'bad/name',
      '--bundle',
      'com.example.a',
      '--location',
      '/tmp',
      '--sdk',
      '23',
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Invalid --name|Invalid (project )?name/i);
  });

  it('errors out on an invalid bundle name', () => {
    const r = runCli([
      'create',
      '--name',
      'Foo',
      '--bundle',
      'not-reverse-dns',
      '--location',
      '/tmp',
      '--sdk',
      '23',
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Invalid (bundle )?name|Invalid --bundle/i);
  });
});

describe('oniro-app device-loop command validation (no device)', () => {
  it('logs collect rejects an unexpected positional argument', () => {
    const r = runCli(['logs', 'collect', 'redact']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/too many arguments|unknown argument/i);
  });

  it('logs collect help documents its time window', () => {
    const r = runCli(['logs', 'collect', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--duration <seconds>');
  });

  it('wait with no condition flag errors out', () => {
    const r = runCli(['wait']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Specify one of --log|--boot|--bundle/);
  });

  it('wait rejects --since without --log', () => {
    const r = runCli(['wait', '--bundle', 'com.example.a', '--since', '30']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--since applies only to --log');
  });

  it('app apply rejects a .hap given both as the argument and with --hap', () => {
    const r = runCli(['app', 'apply', 'a.hap', '--hap', 'b.hap']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not both');
  });

  it('dump rejects an unknown target', () => {
    const r = runCli(['dump', 'bogus']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Unknown dump target/);
  });

  it('app apply errors when no bundle can be resolved', () => {
    // --bundle is optional; it defaults to the bundleName in the project's
    // AppScope/app.json5. With neither --bundle nor a project, apply must fail loudly.
    const r = runCli(['app', 'apply', '/tmp']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/app\.json5|bundle/);
  });

  it('input requires --type', () => {
    const r = runCli(['input']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/type/);
  });

  it('input --help lists the element, fraction, and keyboard options', () => {
    const r = runCli(['input', '--help']);
    expect(r.status).toBe(0);
    for (const flag of ['--target <text>', '--target-index', '--fx <fraction>', '--fy2 <fraction>', '--clear', '--hide-keyboard', 'clearText', 'hideKeyboard']) {
      expect(r.stdout).toContain(flag);
    }
  });

  it('input rejects an out-of-range fraction before touching a device', () => {
    const r = runCli(['input', '--type', 'click', '--fx', '1.5', '--fy', '0.5']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--fx must be a fraction between 0 and 1/);
  });

  it('input rejects a start point given two ways', () => {
    const r = runCli(['input', '--type', 'click', '--target', 'OK', '--x', '1', '--y', '2']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/start point one way/);
  });

  it('input rejects an unknown key name', () => {
    const r = runCli(['input', '--type', 'keyEvent', '--key', 'Hyper']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Unknown key "Hyper"/);
  });

  it('input rejects a blank --target', () => {
    const r = runCli(['input', '--type', 'click', '--target', ' ']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/must not be blank/);
  });

  it('gesture --fractions rejects waypoints outside 0-1', () => {
    const r = runCli(['gesture', '--fractions', '--waypoints', '[{"x":0.5,"y":0.5,"t":0},{"x":1.2,"y":0.5,"t":100}]']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/must be 0-1; got 1.2,0.5/);
  });

  it('dump rejects --raw with --flat', () => {
    const r = runCli(['dump', 'layout', '--raw', '--flat']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--raw and --flat/);
  });

  it('screenshot rejects a malformed --crop', () => {
    const r = runCli(['screenshot', '--crop', '0.5,0.5,0.2,0.9']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/x1 < x2/);
  });

  it('screenshot rejects --crop with --grid', () => {
    const r = runCli(['screenshot', '--crop', '0,0,1,1', '--grid']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/cannot be combined/);
  });
});

describe('oniro-app sign --bootstrap (no device, no java)', () => {
  it('is a no-op when signing material is already present', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cli-presign-'));
    try {
      fs.mkdirSync(path.join(proj, 'signatures'), { recursive: true });
      fs.writeFileSync(
        path.join(proj, 'build-profile.json5'),
        JSON.stringify({ app: { signingConfigs: [{ name: 'default' }] } }),
      );
      const r = runCli(['sign', '--bootstrap', proj]);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/already present/);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe('oniro-app create + sign end-to-end (no network)', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cli-smoke-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('create produces a project and prints its path on stdout', () => {
    const r = runCli([
      'create',
      '--name',
      'SmokeApp',
      '--bundle',
      'com.example.smoke',
      '--location',
      tmp,
      '--sdk',
      '23',
    ]);
    expect(r.status).toBe(0);
    const projectDir = r.stdout.trim();
    expect(projectDir).toBe(path.join(tmp, 'SmokeApp'));
    expect(fs.existsSync(path.join(projectDir, 'build-profile.json5'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'entry', 'oh-package.json5'))).toBe(true);
  });
});
