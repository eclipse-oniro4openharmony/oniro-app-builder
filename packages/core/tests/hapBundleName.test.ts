import { describe, expect, it } from 'vitest';
import { bundleNameFromHapConfig } from '../src/install/hapBundleName.js';

describe('bundleNameFromHapConfig', () => {
  it('reads app.bundleName from module.json or config.json', () => {
    expect(bundleNameFromHapConfig('{"app":{"bundleName":"com.example.app"},"module":{"name":"entry"}}')).toBe(
      'com.example.app',
    );
    expect(bundleNameFromHapConfig('﻿{"app":{"bundleName":"com.example.fa"}}')).toBe('com.example.fa');
  });

  it('returns null when there is no bundle name or the text is not JSON', () => {
    expect(bundleNameFromHapConfig('{"module":{"name":"entry"}}')).toBeNull();
    expect(bundleNameFromHapConfig('{"app":{"bundleName":""}}')).toBeNull();
    expect(bundleNameFromHapConfig('not json')).toBeNull();
  });
});
