import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  modifyProfileTemplate,
  resolveAppFeature,
  pickSigningKind,
  detectSigningConfigNames,
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

const FAKE_CERT_PROFILE_LEAF = 'FAKECERT-PROFILE-LEAF';
const FAKE_CERT_APPLICATION_LEAF = 'FAKECERT-APPLICATION-LEAF';

function wrap(body: string): string {
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
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
      acls: {
        'allowed-acls': [''],
      },
    }),
  );

  // OpenHarmonyProfileRelease.pem is a 3-cert chain; the third cert is the
  // Profile Release leaf (what gets written as distribution-certificate for
  // apl=normal). We use distinct sentinel bodies so tests can assert which
  // chain the third-cert was pulled from.
  fs.writeFileSync(
    path.join(projectDir, 'signatures', 'OpenHarmonyProfileRelease.pem'),
    `${wrap('ROOT')}\n${wrap('CA')}\n${wrap(FAKE_CERT_PROFILE_LEAF)}\n`,
  );

  // OpenHarmonyApplication.cer mirrors the same shape but with the Application
  // Release leaf as the third cert. Production copies this from the embedded
  // resource via copyFilesToProject; here we fake it directly.
  fs.writeFileSync(
    path.join(projectDir, 'signatures', 'OpenHarmonyApplication.cer'),
    `${wrap('ROOT')}\n${wrap('CA')}\n${wrap(FAKE_CERT_APPLICATION_LEAF)}\n`,
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

function readProfile(projectDir: string): {
  'bundle-info': BundleInfo;
  acls?: { 'allowed-acls'?: string[] };
} {
  return JSON.parse(
    fs.readFileSync(
      path.join(projectDir, 'signatures', 'UnsgnedReleasedProfileTemplate.json'),
      'utf-8',
    ),
  );
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

describe('pickSigningKind', () => {
  it('uses profile-release for apl=normal', () => {
    expect(pickSigningKind('normal')).toBe('profile-release');
  });

  it('uses application-release for apl=system_basic', () => {
    expect(pickSigningKind('system_basic')).toBe('application-release');
  });

  it('uses application-release for apl=system_core', () => {
    expect(pickSigningKind('system_core')).toBe('application-release');
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

  it('pulls distribution-certificate from OpenHarmonyProfileRelease.pem for apl=normal', () => {
    modifyProfileTemplate(projectDir, 'normal', 'hos_normal_app', noopLogger);
    const info = readBundleInfo(projectDir);
    expect(info['distribution-certificate']).toContain(FAKE_CERT_PROFILE_LEAF);
    expect(info['distribution-certificate']).not.toContain(FAKE_CERT_APPLICATION_LEAF);
  });

  it('pulls distribution-certificate from OpenHarmonyApplication.cer for system_basic', () => {
    modifyProfileTemplate(projectDir, 'system_basic', 'hos_system_app', noopLogger);
    const info = readBundleInfo(projectDir);
    expect(info['distribution-certificate']).toContain(FAKE_CERT_APPLICATION_LEAF);
    expect(info['distribution-certificate']).not.toContain(FAKE_CERT_PROFILE_LEAF);
  });

  it('pulls distribution-certificate from OpenHarmonyApplication.cer for system_core', () => {
    modifyProfileTemplate(projectDir, 'system_core', 'hos_system_app', noopLogger);
    const info = readBundleInfo(projectDir);
    expect(info['distribution-certificate']).toContain(FAKE_CERT_APPLICATION_LEAF);
  });

  it('writes allowed-acls when acls option is provided', () => {
    modifyProfileTemplate(projectDir, 'system_basic', 'hos_system_app', noopLogger, {
      acls: ['ohos.permission.REBOOT', 'ohos.permission.INJECT_INPUT_EVENT'],
    });
    const profile = readProfile(projectDir);
    expect(profile.acls?.['allowed-acls']).toEqual([
      'ohos.permission.REBOOT',
      'ohos.permission.INJECT_INPUT_EVENT',
    ]);
  });

  it('leaves allowed-acls untouched when acls option is omitted', () => {
    modifyProfileTemplate(projectDir, 'normal', 'hos_normal_app', noopLogger);
    const profile = readProfile(projectDir);
    // Fixture's initial value, preserved.
    expect(profile.acls?.['allowed-acls']).toEqual(['']);
  });

  it('writes an empty allowed-acls when acls option is an empty array', () => {
    modifyProfileTemplate(projectDir, 'system_basic', 'hos_system_app', noopLogger, {
      acls: [],
    });
    const profile = readProfile(projectDir);
    expect(profile.acls?.['allowed-acls']).toEqual([]);
  });
});

describe('detectSigningConfigNames', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-detect-names-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns ["default"] when build-profile.json5 does not exist', () => {
    expect(detectSigningConfigNames(projectDir)).toEqual(['default']);
  });

  it('returns ["default"] when products section is missing', () => {
    fs.writeFileSync(path.join(projectDir, 'build-profile.json5'), JSON.stringify({ app: {} }));
    expect(detectSigningConfigNames(projectDir)).toEqual(['default']);
  });

  it('returns the single product signingConfig name when present', () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { products: [{ name: 'default', signingConfig: 'release' }] } }),
    );
    expect(detectSigningConfigNames(projectDir)).toEqual(['release']);
  });

  it('returns the union of distinct signingConfig names in declaration order', () => {
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({
        app: {
          products: [
            { name: 'p1', signingConfig: 'release' },
            { name: 'p2', signingConfig: 'default' },
            { name: 'p3', signingConfig: 'release' }, // dedup
          ],
        },
      }),
    );
    expect(detectSigningConfigNames(projectDir)).toEqual(['release', 'default']);
  });

  it('falls back to ["default"] on malformed JSON5', () => {
    fs.writeFileSync(path.join(projectDir, 'build-profile.json5'), '{ not valid');
    expect(detectSigningConfigNames(projectDir)).toEqual(['default']);
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
