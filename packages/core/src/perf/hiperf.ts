/** One row of `hiperf report --sort dso,func`. */
export interface HiperfFunction {
  /** Share of the samples' event count, %. */
  percent: number;
  dso: string;
  func: string;
}

export interface HiperfReport {
  /** The sampled event, e.g. `hw-cpu-cycles`. */
  event?: string;
  samples: number;
  top: HiperfFunction[];
}

/**
 * Parse `hiperf report -i <data> --sort dso,func` text:
 *
 * ```
 * Event: hw-cpu-cycles (type 0 id 0)
 * Samples Count: 25
 * Event Count: 20091
 * Heating count dso                              func
 * 39.16%   7868 [kernel.kallsyms]                _raw_spin_unlock_irqrestore
 * 32.58%   6546 /system/lib/ld-musl-aarch64.so.1 /system/lib/ld-musl-aarch64.so.1+0x13fd6c
 * ```
 *
 * Several events (several `Event:` sections) add up their samples; rows keep
 * the first section's order. Pure.
 */
export function parseHiperfReport(text: string, limit = 15): HiperfReport {
  const report: HiperfReport = { samples: 0, top: [] };
  for (const line of text.split(/\r?\n/)) {
    const ev = /^Event:\s*(\S+)/.exec(line);
    if (ev) {
      report.event ??= ev[1];
      continue;
    }
    const s = /^Samples Count:\s*(\d+)/.exec(line);
    if (s) {
      report.samples += Number(s[1]);
      continue;
    }
    const row = /^\s*([\d.]+)%\s+\d+\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (row && report.top.length < limit) report.top.push({ percent: Number(row[1]), dso: row[2]!, func: row[3]! });
  }
  return report;
}
