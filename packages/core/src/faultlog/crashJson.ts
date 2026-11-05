/**
 * The native crash record faultloggerd writes to `/data/log/faultlog/temp/`
 * (`cppcrash-<pid>-<epoch ms>.json`) before hiview turns it into a cppcrash
 * faultlog. When hiview refuses the record (on some builds it does not
 * recognise processdump at `/root/system/bin/processdump` and logs
 * `Fail to add fault log … is not processdump`), this file is the only record
 * of an app's native crash. Written for this package; not part of the deveco-cli port.
 */

interface JsonFrame {
  pc?: string;
  symbol?: string;
  offset?: number;
  file?: string;
  buildId?: string;
  /** JS frames carry these instead of `pc`. */
  packageName?: string;
  line?: number;
  column?: number;
}

interface JsonThread {
  thread_name?: string;
  tid?: number;
  frames?: JsonFrame[];
}

export interface CrashJson {
  JSON_VERSION?: string;
  BUILD_INFO?: string;
  TIMESTAMP?: string;
  PID?: number;
  UID?: number;
  PNAME?: string;
  PROCESS_LIFETIME?: string;
  LOG_SOURCE?: string;
  REASON?: string;
  LAST_FATAL_MESSAGE?: string;
  KEY_THREAD_INFO?: JsonThread;
  OTHER_THREAD_INFO?: JsonThread[];
  KEY_THREAD_REGISTERS?: string;
}

/** Whether text is a faultloggerd crash record rather than a faultlog. */
export function isCrashJson(text: string): boolean {
  const head = text.trimStart().slice(0, 4096);
  return head.startsWith('{') && /"(?:KEY_THREAD_INFO|JSON_VERSION|PNAME)"\s*:/.test(head);
}

function frameLine(frame: JsonFrame, index: number): string {
  const n = `#${String(index).padStart(2, '0')}`;
  if (frame.pc === undefined && frame.line !== undefined) {
    const fn = [frame.symbol || 'anonymous', frame.packageName].filter(Boolean).join(' ');
    return `${n} at ${fn} (${frame.file ?? ''}:${frame.line}:${frame.column ?? 0})`;
  }
  const symbol = frame.symbol ? `(${frame.symbol}${frame.offset ? `+${frame.offset}` : ''})` : '';
  const buildId = frame.buildId ? `(${frame.buildId})` : '';
  return `${n} pc ${frame.pc ?? '0'} ${frame.file ?? '[unknown]'}${symbol}${buildId}`;
}

function threadLines(thread: JsonThread): string[] {
  return [`Tid:${thread.tid ?? ''}, Name:${thread.thread_name ?? ''}`, ...(thread.frames ?? []).map(frameLine)];
}

/**
 * Render a crash record as the cppcrash faultlog hiview would have written, so
 * one parser reads both. Throws on invalid JSON.
 */
export function renderCrashJson(text: string): string {
  const json = JSON.parse(text) as CrashJson;
  const field = (name: string, value: string | number | undefined): string[] =>
    value === undefined || value === '' ? [] : [`${name}:${String(value).trim()}`];
  return [
    'Generated from a faultloggerd crash record',
    ...field('Build info', json.BUILD_INFO),
    ...field('Module name', json.PNAME),
    ...field('Timestamp', json.TIMESTAMP),
    ...field('Pid', json.PID),
    ...field('Uid', json.UID),
    ...field('Process name', json.PNAME),
    ...field('Process life time', json.PROCESS_LIFETIME),
    ...field('Log source', json.LOG_SOURCE),
    ...field('Reason', json.REASON),
    ...field('LastFatalMessage', json.LAST_FATAL_MESSAGE),
    'Fault thread info:',
    ...(json.KEY_THREAD_INFO ? threadLines(json.KEY_THREAD_INFO) : []),
    'Registers:',
    ...(json.KEY_THREAD_REGISTERS ?? '').trimEnd().split('\n'),
    'Other thread info:',
    ...(json.OTHER_THREAD_INFO ?? []).flatMap(threadLines),
    '',
  ].join('\n');
}
