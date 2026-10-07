/**
 * tm.ts — Melting temperature.
 * Primary: SantaLucia (1998) nearest-neighbor thermodynamics.
 * Fallback: Wallace rule for very short oligomers (<14 nt).
 */

interface NNParam { dh: number; ds: number } // dh kcal/mol, ds cal/mol/K

// SantaLucia 1998 unified NN parameters (ΔH, ΔS) for the 10 unique pairs.
// Keys are written 5'->3' / 3'->5' Watson-Crick duplexes.
const NN: Record<string, NNParam> = {
  'AA/TT': { dh: -7.9, ds: -22.2 },
  'AT/TA': { dh: -7.2, ds: -20.4 },
  'TA/AT': { dh: -7.2, ds: -21.3 },
  'CA/GT': { dh: -8.5, ds: -22.7 },
  'GT/CA': { dh: -8.4, ds: -22.4 },
  'CT/GA': { dh: -7.8, ds: -21.0 },
  'GA/CT': { dh: -8.2, ds: -22.2 },
  'CG/GC': { dh: -10.6, ds: -27.2 },
  'GC/CG': { dh: -9.8, ds: -24.4 },
  'GG/CC': { dh: -8.0, ds: -19.9 },
};

const COMP: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };

function pairKey(a: string, b: string): string {
  const top = `${a}${b}`;
  const bot = `${COMP[b] ?? 'N'}${COMP[a] ?? 'N'}`;
  const fwd = `${top}/${bot}`;
  if (NN[fwd]) { return fwd; }
  // symmetry partner (e.g. TG/AC == CA/GT family)
  const rev = `${bot}/${top}`;
  // Map degenerate orientations onto canonical entries:
  const alias: Record<string, string> = {
    'TG/AC': 'CA/GT', 'AC/TG': 'GT/CA',
    'TC/AG': 'CT/GA', 'AG/TC': 'GA/CT',
    'TT/AA': 'AA/TT', 'TA/AT': 'TA/AT',
  };
  if (NN[rev]) { return rev; }
  if (alias[fwd]) { return alias[fwd]; }
  if (alias[rev]) { return alias[rev]; }
  // Non-canonical base (N, gap): neutral average stacking so Tm degrades gracefully.
  return (a === 'G' || a === 'C' || b === 'G' || b === 'C') ? 'GG/CC' : 'AA/TT';
}

export interface TmOptions {
  /** Primer strand concentration in nM (default 250). */
  primerConcNM?: number;
  /** Monovalent salt Na+ in mM (default 50). */
  naConcMM?: number;
  /** Mg++ in mM — applied as equivalent Na+ boost (von Ahsen correction, simplified). */
  mgConcMM?: number;
}

export interface TmResult {
  tmSantaLucia: number;
  tmWallace: number;
  tmUsed: number;
  method: 'santalucia' | 'wallace';
  deltaH: number;
  deltaS: number;
}

const R = 1.987; // cal/mol/K

export function wallaceTm(seq: string): number {
  const s = seq.toUpperCase().replace(/U/g, 'T');
  let a = 0, t = 0, g = 0, c = 0;
  for (const ch of s) {
    if (ch === 'A') { a++; } else if (ch === 'T') { t++; }
    else if (ch === 'G') { g++; } else if (ch === 'C') { c++; }
  }
  return 2 * (a + t) + 4 * (g + c);
}

export function santaLuciaTm(seq: string, opts: TmOptions = {}): TmResult {
  const s = seq.toUpperCase().replace(/U/g, 'T').replace(/[^ACGT]/g, '');
  const tmWallace = wallaceTm(seq);
  if (s.length < 2) {
    return { tmSantaLucia: tmWallace, tmWallace, tmUsed: tmWallace, method: 'wallace', deltaH: 0, deltaS: 0 };
  }
  const primerM = ((opts.primerConcNM ?? 250) * 1e-9);
  let naM = (opts.naConcMM ?? 50) * 1e-3;
  if (opts.mgConcMM) {
    // von Ahsen et al. simplified: [Na+]eq ≈ [Na+] + 120*sqrt([Mg++])
    naM += 120 * Math.sqrt(opts.mgConcMM * 1e-3);
  }
  let dh = 0.2;   // initiation ΔH
  let ds = -5.7;  // initiation ΔS
  // Terminal AT penalty
  if (s[0] === 'A' || s[0] === 'T') { dh += 2.2; ds += 6.9; }
  if (s[s.length - 1] === 'A' || s[s.length - 1] === 'T') { dh += 2.2; ds += 6.9; }
  for (let i = 0; i + 1 < s.length; i++) {
    const p = NN[pairKey(s[i], s[i + 1])] ?? NN['AA/TT'];
    dh += p.dh;
    ds += p.ds;
  }
  const tmKelvin = (dh * 1000) / (ds + R * Math.log(primerM / 2));
  let tmC = tmKelvin - 273.15 + 16.6 * Math.log10(naM);
  if (!isFinite(tmC)) { tmC = tmWallace; }
  const method = s.length < 14 ? 'wallace' as const : 'santalucia' as const;
  return {
    tmSantaLucia: round1(tmC),
    tmWallace,
    tmUsed: method === 'wallace' ? tmWallace : round1(tmC),
    method,
    deltaH: round1(dh),
    deltaS: round1(ds),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
