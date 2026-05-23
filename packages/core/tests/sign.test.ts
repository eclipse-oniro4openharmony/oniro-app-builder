import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  modifyProfileTemplate,
  resolveAppFeature,
} from '../src/sign/generateSigningConfigs.js';
import { generateSigningConfigs } from '../src/sign/index.js';
import { OniroError } from '../src/ports/errors.js';
import { noopLogger } from '../src/ports/logger.js';

interface BundleInfo {
  apl?: string;
  'app-feature'?: string;
  'bundle-name'?: string;
  'distribution-certificate'?: string;
}

function writeProjectSignaturesFixture(projectDir: string): void {
  fs.mkdirSync(path.join(projectDir, 'AppScope'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'AppScope', 'app.json5'),
    JSON.stringify({ app: { bundleName: 'com.example.signtest' } }),
  );

  fs.mkdirSync(path.join(projectDir, 'signatures'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'signatures', 'UnsgnedReleasedProfileTemplate.json'),
    JSON.stringify({
      'bundle-info': {
        'bundle-name': 'com.OpenHarmony.app.test',
        apl: 'normal',
        'app-feature': 'hos_normal_app',
      },
    }),
  );

  // OpenHarmonyProfileRelease.pem is a chain — the production code extracts
  // the third certificate, so we need at least three END markers.
  const cert = '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----';
  fs.writeFileSync(
    path.join(projectDir, 'signatures', 'OpenHarmonyProfileRelease.pem'),
    `${cert}\n${cert}\n${cert}\n`,
  );
}

function readBundleInfo(projectDir: string): BundleInfo {
  const profile = JSON.parse(
    fs.readFileSync(
      path.join(projectDir, 'signatures', 'UnsgnedReleasedProfileTemplate.json'),
      'utf-8',
    ),
  ) as { 'bundle-info': BundleInfo };
  return profile['bundle-info'];
}

describe('resolveAppFeature', () => {
  it('returns hos_normal_app for apl=normal by default', () => {
    expect(resolveAppFeature('normal')).toBe('hos_normal_app');
  });

  it('returns hos_system_app for apl=system_basic by default', () => {
    expect(resolveAppFeature('system_basic')).toBe('hos_system_app');
  });

  it('returns hos_system_app for apl=system_core by default', () => {
    expect(resolveAppFeature('system_core')).toBe('hos_system_app');
  });

  it('respects an explicit override even when it disagrees with the default', () => {
    expect(resolveAppFeature('system_basic', 'hos_normal_app')).toBe('hos_normal_app');
    expect(resolveAppFeature('normal', 'hos_system_app')).toBe('hos_system_app');
  });
});

describe('modifyProfileTemplate', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sign-test-'));
    writeProjectSignaturesFixture(projectDir);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('writes apl=normal and app-feature=hos_normal_app for the default case', () => {
    modifyProfileTemplate(projectDir, 'normal', 'hos_normal_app', noopLogger);
    const info = readBundleInfo(projectDir);
    expect(info.apl).toBe('normal');
    expect(info['app-feature']).toBe('hos_normal_app');
    expect(info['bundle-name']).toBe('com.example.signtest');
  });

  it('writes apl=system_basic and app-feature=hos_system_app for system_basic', () => {
    modifyProfileTemplate(projectDir, 'system_basic', 'hos_system_app', noopLogger);
    const info = readBundleInfo(projectDir);
    expect(info.apl).toBe('system_basic');
    expect(info['app-feature']).toBe('hos_system_app');
  });

  it('writes apl=system_core and app-feature=hos_system_app for system_core', () => {
    modifyProfileTemplate(projectDir, 'system_core', 'hos_system_app', noopLogger);
    const info = readBundleInfo(projectDir);
    expect(info.apl).toBe('system_core');
    expect(info['app-feature']).toBe('hos_system_app');
  });

  it('overwrites the template default apl/app-feature when invoked', () => {
    // Sanity: the fixture starts with apl=normal/hos_normal_app — make sure a
    // system_basic call really replaces both fields and does not just append.
    modifyProfileTemplate(projectDir, 'system_basic', 'hos_system_app', noopLogger);
    const info = readBundleInfo(projectDir);
    expect(info.apl).not.toBe('normal');
    expect(info['app-feature']).not.toBe('hos_normal_app');
  });
});

describe('generateSigningConfigs option validation', () => {
  let projectDir: string;
  let sdkHome: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sign-validate-'));
    sdkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-sdk-validate-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(sdkHome, { recursive: true, force: true });
  });

  it('rejects an unknown apl before touching the filesystem', () => {
    expect(() =>
      generateSigningConfigs({
        projectDir,
        sdkHome,
        // @ts-expect-error — deliberately invalid to test the runtime guard.
        apl: 'bogus',
      }),
    ).toThrow(OniroError);
  });

  it('rejects an unknown appFeature before touching the filesystem', () => {
    expect(() =>
      generateSigningConfigs({
        projectDir,
        sdkHome,
        apl: 'normal',
        // @ts-expect-error — deliberately invalid to test the runtime guard.
        appFeature: 'hos_made_up_app',
      }),
    ).toThrow(OniroError);
  });
});
