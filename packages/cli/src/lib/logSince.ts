/**
 * Parse a `--since` value for `wait --log` and `watch`: how many seconds before
 * the command started a log line may be from and still count, or `all` for
 * everything still in the device buffer. Returns ms; undefined when not given.
 */
export function parseSince(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value === 'all') return Infinity;
  const seconds = Number(value);
  if (value.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`--since takes a number of seconds or "all", not "${value}".`);
  }
  return seconds * 1000;
}
