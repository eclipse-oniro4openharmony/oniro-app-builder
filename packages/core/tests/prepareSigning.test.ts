import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticConfig } from '../src/ports/config.js';
import { prepareSigning } from '../src/project/prepareSigning.js';

describe('prepareSigning', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oniro-presign-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const config = () => staticConfig({});

  it('is a no-op ("present") when signatures/ and signingConfigs already exist', () => {
    fs.mkdirSync(path.join(projectDir, 'signatures'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'build-profile.json5'),
      JSON.stringify({ app: { signingConfigs: [{ name: 'default' }] } }),
    );
    expect(prepareSigning({ config: config(), projectDir })).toEqual({ source: 'present' });
  });

  it('attempts a fresh generate when no signing material is present', () => {
    // Empty project → falls through to generateSigningConfigs, which throws here
    // (no SDK version is detectable), proving the present-vs-fresh decision.
    expect(() => prepareSigning({ config: config(), projectDir })).toThrow();
  });

  it('treats signatures/ without signingConfigs as not-present (→ fresh)', () => {
    fs.mkdirSync(path.join(projectDir, 'signatures'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'build-profile.json5'), JSON.stringify({ app: { products: [] } }));
    expect(() => prepareSigning({ config: config(), projectDir })).toThrow();
  });
});
