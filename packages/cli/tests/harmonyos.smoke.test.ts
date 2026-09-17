import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from './_helpers/runCli.js';

// Signed out, with no network: every path here must fail or succeed before any request.
describe('oniro-app auth / sign --harmonyos (signed out, no network)', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  let projectDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-cli-hos-'));
    env = {
      HOME: tmp,
      USERPROFILE: tmp,
      ONIRO_HARMONYOS_AUTH_DIR: path.join(tmp, 'auth'),
      ONIRO_HARMONYOS_SIGNING_DIR: path.join(tmp, 'signing'),
      ONIRO_HARMONYOS_SDK_PATH: path.join(tmp, 'hos-sdk'),
      ONIRO_CMD_TOOLS_PATH: path.join(tmp, 'no-cmdtools'),
    };
    fs.mkdirSync(path.join(tmp, 'hos-sdk', 'default', 'openharmony'), { recursive: true });

    projectDir = path.join(tmp, 'MyApp');
    fs.mkdirSync(path.join(projectDir, 'AppScope'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', runtimeOS: 'HarmonyOS' }] }, modules: [] }),
    );
    fs.writeFileSync(path.join(projectDir, 'AppScope', 'app.json5'), JSON.stringify({ app: { bundleName: 'com.example.myapp' } }));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('auth status exits non-zero when signed out, with or without --json', () => {
    for (const args of [['auth', 'status'], ['auth', 'status', '--json']]) {
      const r = runCli(args, env);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('Not signed in. Run `oniro-app auth login`.');
    }
  });

  it('auth logout is a no-op when signed out', () => {
    const r = runCli(['auth', 'logout'], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Not signed in; nothing to do.');
  });

  it('auth team list asks to sign in first', () => {
    const r = runCli(['auth', 'team', 'list'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not signed in. Run `oniro-app auth login` first.');
  });

  it('auth login documents its timeout', () => {
    const r = runCli(['auth', 'login', '--help'], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--timeout <seconds>');
  });

  it('sign refuses the offline OpenHarmony flow for a HarmonyOS project', () => {
    const r = runCli(['sign', projectDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('targets HarmonyOS');
    expect(r.stderr).toContain('oniro-app sign --harmonyos');
    expect(fs.existsSync(path.join(projectDir, 'signatures'))).toBe(false);
  });

  it('sign --harmonyos asks to sign in first, and names an undeclared product', () => {
    let r = runCli(['sign', '--harmonyos', projectDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not signed in');

    r = runCli(['sign', '--harmonyos', '--product', 'absent', projectDir], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("declares no product named 'absent'");
  });
});
