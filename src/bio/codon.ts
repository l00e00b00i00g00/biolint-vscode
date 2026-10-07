/**
 * codon.ts — codon optimality: CAI, rare-codon detection, host-aware optimization.
 *
 * Reference frequencies are approximate Kazusa-derived genomic averages
 * (per-thousand). Serious production use should mount an exact table via
 * `biolint.codon.customTablePath` (.bioguard/codon_usage.json), which takes
 * precedence over the built-ins.
 */

export type HostId = 'ecoli' | 'yeast' | 'human';

export interface HostTable {
  id: HostId;
  name: string;
  /** Genomic frequency per thousand per codon. */
  freq: Record<string, number>;
}

const ECOLI_FREQ: Record<string, number> = {
  TTT: 22.1, TTC: 16.6, TTA: 13.9, TTG: 13.0, TCT: 8.5, TCC: 8.6, TCA: 7.2, TCG: 8.9,
  TAT: 16.8, TAC: 12.2, TAA: 2.0, TAG: 0.3, TGT: 5.2, TGC: 6.5, TGG: 15.3, TGA: 1.0,
  CTT: 11.1, CTC: 10.7, CTA: 3.9, CTG: 52.6, CCT: 7.1, CCC: 5.5, CCA: 8.7, CCG: 23.4,
  CAT: 12.9, CAC: 9.7, CAA: 15.3, CAG: 29.0, CGT: 20.9, CGC: 22.0, CGA: 3.6, CGG: 5.4,
  ATT: 30.1, ATC: 25.1, ATA: 4.3, ATG: 27.7, ACT: 8.9, ACC: 23.4, ACA: 7.1, ACG: 14.3,
  AAT: 17.7, AAC: 21.6, AAA: 33.6, AAG: 10.2, AGT: 8.8, AGC: 16.0, AGA: 2.1, AGG: 1.7,
  GTT: 18.2, GTC: 15.2, GTA: 10.9, GTG: 26.4, GCT: 15.4, GCC: 25.5, GCA: 20.3, GCG: 33.7,
  GAT: 32.2, GAC: 19.1, GAA: 39.6, GAG: 17.8, GGT: 24.7, GGC: 29.6, GGA: 8.0, GGG: 11.0,
};

const YEAST_FREQ: Record<string, number> = {
  TTT: 26.1, TTC: 16.4, TTA: 26.2, TTG: 27.2, TCT: 23.5, TCC: 14.2, TCA: 18.7, TCG: 8.6,
  TAT: 18.5, TAC: 14.8, TAA: 1.1, TAG: 0.5, TGT: 8.1, TGC: 4.8, TGG: 10.4, TGA: 0.7,
  CTT: 12.3, CTC: 5.4, CTA: 13.4, CTG: 10.5, CCT: 13.6, CCC: 6.8, CCA: 18.8, CCG: 5.3,
  CAT: 13.6, CAC: 7.8, CAA: 27.5, CAG: 12.1, CGT: 6.4, CGC: 2.6, CGA: 3.0, CGG: 1.7,
  ATT: 30.1, ATC: 17.2, ATA: 17.8, ATG: 20.9, ACT: 20.3, ACC: 14.2, ACA: 17.8, ACG: 8.0,
  AAT: 35.7, AAC: 24.8, AAA: 41.9, AAG: 30.8, AGT: 14.2, AGC: 9.4, AGA: 21.3, AGG: 9.2,
  GTT: 22.1, GTC: 11.8, GTA: 11.8, GTG: 10.8, GCT: 21.2, GCC: 12.6, GCA: 16.2, GCG: 6.2,
  GAT: 37.6, GAC: 20.2, GAA: 45.6, GAG: 19.2, GGT: 23.9, GGC: 9.8, GGA: 22.7, GGG: 6.0,
};

const HUMAN_FREQ: Record<string, number> = {
  TTT: 17.6, TTC: 20.3, TTA: 7.7, TTG: 12.9, TCT: 15.2, TCC: 17.7, TCA: 12.2, TCG: 4.4,
  TAT: 12.2, TAC: 15.3, TAA: 0.8, TAG: 0.8, TGT: 10.6, TGC: 12.6, TGG: 13.2, TGA: 1.6,
  CTT: 13.2, CTC: 19.6, CTA: 7.2, CTG: 39.6, CCT: 17.5, CCC: 19.8, CCA: 16.9, CCG: 6.9,
  CAT: 10.9, CAC: 15.1, CAA: 12.3, CAG: 34.2, CGT: 4.5, CGC: 10.4, CGA: 6.2, CGG: 11.4,
  ATT: 16.0, ATC: 20.8, ATA: 7.5, ATG: 22.0, ACT: 13.1, ACC: 18.9, ACA: 15.1, ACG: 6.1,
  AAT: 17.0, AAC: 19.1, AAA: 24.4, AAG: 31.9, AGT: 12.1, AGC: 19.5, AGA: 12.2, AGG: 12.0,
  GTT: 11.0, GTC: 14.5, GTA: 7.1, GTG: 28.1, GCT: 18.4, GCC: 27.7, GCA: 15.8, GCG: 7.4,
  GAT: 21.8, GAC: 25.1, GAA: 29.0, GAG: 39.6, GGT: 10.8, GGC: 22.2, GGA: 16.5, GGG: 16.5,
};

export const HOST_TABLES: Record<HostId, HostTable> = {
  ecoli: { id: 'ecoli', name: 'E. coli K-12 (genomic avg.)', freq: ECOLI_FREQ },
  yeast: { id: 'yeast', name: 'S. cerevisiae (genomic avg.)', freq: YEAST_FREQ },
  human: { id: 'human', name: 'H. sapiens (genomic avg.)', freq: HUMAN_FREQ },
};

export const CODON_TO_AA: Record<string, string> = {
  TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L', CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
  ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M', GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
  TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S', CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
  ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T', GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
  TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*', CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
  AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K', GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
  TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W', CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
  AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R', GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
};

function synonymousCodons(aa: string): string[] {
  return Object.keys(CODON_TO_AA).filter(c => CODON_TO_AA[c] === aa);
}

/** Relative adaptiveness w(codon) = freq / max freq among synonymous codons. */
export function adaptiveness(codon: string, table: HostTable): number {
  const c = codon.toUpperCase();
  const aa = CODON_TO_AA[c];
  if (!aa) { return 0; }
  const syn = synonymousCodons(aa);
  const max = Math.max(...syn.map(s => table.freq[s] ?? 0.01));
  return (table.freq[c] ?? 0.01) / (max || 1);
}

/** Codon Adaptation Index (Sharp & Li): geometric mean of w over codons. */
export function cai(seq: string, table: HostTable): number {
  const s = seq.toUpperCase().replace(/U/g, 'T');
  const ws: number[] = [];
  for (let i = 0; i + 3 <= s.length; i += 3) {
    const codon = s.slice(i, i + 3);
    if (!/^[ACGT]{3}$/.test(codon)) { continue; }
    if (CODON_TO_AA[codon] === '*') { continue; } // stops excluded (standard CAI)
    ws.push(Math.max(0.01, adaptiveness(codon, table)));
  }
  if (ws.length === 0) { return 0; }
  const logSum = ws.reduce((a, w) => a + Math.log(w), 0);
  return Math.exp(logSum / ws.length);
}

export interface RareCodon {
  codon: string;
  position: number; // 0-based nt index in input
  aa: string;
  w: number;
}

/** Codons with w < threshold (default 0.15) — expression bottlenecks. */
export function findRareCodons(seq: string, table: HostTable, threshold = 0.15): RareCodon[] {
  const s = seq.toUpperCase().replace(/U/g, 'T');
  const out: RareCodon[] = [];
  for (let i = 0; i + 3 <= s.length; i += 3) {
    const codon = s.slice(i, i + 3);
    if (!/^[ACGT]{3}$/.test(codon)) { continue; }
    const aa = CODON_TO_AA[codon];
    if (!aa || aa === '*') { continue; }
    const w = adaptiveness(codon, table);
    if (w < threshold) { out.push({ codon, position: i, aa, w: Math.round(w * 100) / 100 }); }
  }
  return out;
}

export interface CodonOptimization {
  optimized: string;
  changes: number;
  caiBefore: number;
  caiAfter: number;
  notes: string[];
}

/** Replace suboptimal codons with the host's most-adaptive synonymous codon. Start/stop preserved. */
export function optimizeCodons(seqRaw: string, table: HostTable): CodonOptimization {
  const s = seqRaw.toUpperCase().replace(/U/g, 'T');
  const notes: string[] = [];
  let changes = 0;
  let out = '';
  const nCodons = Math.floor(s.length / 3);
  for (let k = 0; k < nCodons; k++) {
    const codon = s.slice(k * 3, k * 3 + 3);
    if (!/^[ACGT]{3}$/.test(codon)) { out += codon; continue; }
    const aa = CODON_TO_AA[codon];
    if (!aa) { out += codon; continue; }
    if (k === 0 || aa === '*') { out += codon; continue; } // keep start & stops
    const best = synonymousCodons(aa)
      .filter(c => CODON_TO_AA[c] !== '*')
      .sort((a, b) => (table.freq[b] ?? 0) - (table.freq[a] ?? 0))[0];
    if (best && best !== codon) {
      out += best; changes++;
      if (notes.length < 8) { notes.push(`codon ${k + 1}: ${codon}→${best} (${aa})`); }
    } else {
      out += codon;
    }
  }
  out += s.slice(nCodons * 3); // trailing partial codon untouched
  const caiBefore = cai(s, table);
  const caiAfter = cai(out, table);
  if (changes === 0) { notes.push('Already optimal for ' + table.name + ' — no changes.'); }
  return {
    optimized: out, changes,
    caiBefore: round3(caiBefore),
    caiAfter: round3(caiAfter),
    notes,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Load a custom codon table (JSON {codon: freqPerThousand}) overriding built-ins. */
export function customTable(name: string, freq: Record<string, number>, base: HostId = 'ecoli'): HostTable {
  return { id: base, name: `custom: ${name}`, freq };
}

let tableCache: { key: string; table: HostTable } | null = null;

/**
 * Resolve the active codon table: custom JSON file wins when it parses,
 * otherwise the built-in host table. Cached by path+mtime.
 * Accepts either `{codon: freq}` or `{entries: {...}, name?}` shapes.
 */
export function loadCodonTable(host: HostId, customPath: string): HostTable {
  const path = (customPath || '').trim();
  if (!path) { return HOST_TABLES[host] ?? HOST_TABLES.ecoli; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const stat = fs.statSync(path);
    const key = `${path}:${stat.mtimeMs}:${stat.size}`;
    if (tableCache && tableCache.key === key) { return tableCache.table; }
    const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
    const freqRaw = (raw['entries'] ?? raw) as Record<string, unknown>;
    const freq: Record<string, number> = {};
    for (const [k, v] of Object.entries(freqRaw)) {
      const codon = k.toUpperCase();
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      if (/^[ACGTU]{3}$/.test(codon) && isFinite(n) && n > 0) { freq[codon.replace(/U/g, 'T')] = n; }
    }
    if (Object.keys(freq).length < 20) { return HOST_TABLES[host] ?? HOST_TABLES.ecoli; }
    const table = customTable(path.split(/[\\/]/).pop() || path, freq, host);
    tableCache = { key, table };
    return table;
  } catch {
    return HOST_TABLES[host] ?? HOST_TABLES.ecoli;
  }
}
