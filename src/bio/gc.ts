/** gc.ts — GC% metrics + sliding-window profile. */

export interface GcMetrics {
  length: number;
  gcCount: number;
  atCount: number;
  nCount: number;
  gcPct: number;
  atPct: number;
}

export function gcContent(seq: string): GcMetrics {
  const s = seq.toUpperCase().replace(/U/g, 'T');
  let gc = 0, at = 0, n = 0;
  for (const ch of s) {
    if (ch === 'G' || ch === 'C') { gc++; }
    else if (ch === 'A' || ch === 'T') { at++; }
    else { n++; }
  }
  const length = s.length || 1;
  return {
    length: s.length,
    gcCount: gc,
    atCount: at,
    nCount: n,
    gcPct: (gc / length) * 100,
    atPct: (at / length) * 100,
  };
}

/** Sliding GC% window (window nt, step nt). Returns per-window percentages. */
export function gcProfile(seq: string, window = 20, step = 5): number[] {
  const s = seq.toUpperCase();
  if (s.length < window) { return [gcContent(s).gcPct]; }
  const out: number[] = [];
  for (let i = 0; i + window <= s.length; i += step) {
    out.push(gcContent(s.slice(i, i + window)).gcPct);
  }
  return out;
}

export type GcFlag = 'low' | 'normal' | 'high';

export function classifyGC(gcPct: number, warnLow = 35, warnHigh = 65): GcFlag {
  if (gcPct < warnLow) { return 'low'; }
  if (gcPct > warnHigh) { return 'high'; }
  return 'normal';
}

/** ASCII sparkline for hover/webview, e.g. ▁▂▅▇ */
export function gcSparkline(profile: number[]): string {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  if (profile.length === 0) { return '—'; }
  return profile.map(p => blocks[Math.min(7, Math.max(0, Math.floor(p / 12.5)))]).join('');
}
