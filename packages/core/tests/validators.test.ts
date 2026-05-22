import { describe, expect, it } from 'vitest';
import { isValidBundleName, isValidProjectName } from '../src/project/validators.js';

describe('isValidProjectName', () => {
  it('accepts simple alphanumeric names', () => {
    expect(isValidProjectName('MyApp')).toBe(true);
    expect(isValidProjectName('my-app_2')).toBe(true);
  });

  it('rejects path separators', () => {
    expect(isValidProjectName('foo/bar')).toBe(false);
    expect(isValidProjectName('foo\\bar')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isValidProjectName('')).toBe(false);
  });

  it('rejects spaces', () => {
    expect(isValidProjectName('my app')).toBe(false);
  });
});

describe('isValidBundleName', () => {
  it('accepts reverse-DNS identifiers', () => {
    expect(isValidBundleName('com.example.myapp')).toBe(true);
    expect(isValidBundleName('org.eclipse.oniro.demo')).toBe(true);
  });

  it('rejects single-segment names', () => {
    expect(isValidBundleName('myapp')).toBe(false);
  });

  it('rejects segments starting with digits', () => {
    expect(isValidBundleName('com.1example.app')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isValidBundleName('')).toBe(false);
  });
});
