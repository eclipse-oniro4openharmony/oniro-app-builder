/**
 * Conservative project-folder-name validator (no path separators, conservative charset).
 */
export function isValidProjectName(name: string): boolean {
  if (!name) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * Bundle-name validator. Allows reverse-DNS style identifiers like `com.example.myapp`.
 */
export function isValidBundleName(bundleName: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(bundleName);
}
