/**
 * primer.ts — embedded equivalent of `@synthflow/primer-calc`.
 * Single entry point for hover metrics, diagnostics and quick-fixes.
 */
import { gcContent, gcProfile, classifyGC } from './gc';
import { santaLuciaTm } from './tm';
import { hairpinDeltaG, selfDimerDeltaG, foldRisk } from './deltaG';

export interface PrimerAnalysis {
  sequence: string;
  length: number;
  gcPct: number;
  gcFlag: 'low' | 'normal' | 'high';
  tm: number;
  tmMethod: string;
  tmWallace: number;
  hairpinDG: number;
  selfDimerDG: number;
  foldRisk: 'low' | 'medium' | 'high';
  gcClamp: number; // G/C count in last 5 nt (ideal 1-2)
  maxHomopolymer: number;
  nCount: number;
  score: number; // 0-100
  suggestions: string[];
  gcSpark: string;
}

export function maxHomopolymerRun(seq: string): number {
  const s = seq.toUpperCase();
  let best = 1, cur = 1;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === s[i - 1]) { cur++; best = Math.max(best, cur); }
    else { cur = 1; }
  }
  return seq.length === 0 ? 0 : best;
}

export function analyzePrimer(seqRaw: string, gcLow = 35, gcHigh = 65): PrimerAnalysis {
  const sequence = seqRaw.toUpperCase().replace(/U/g, 'T');
  const gc = gcContent(sequence);
  const tm = santaLuciaTm(sequence);
  const hp = hairpinDeltaG(sequence);
  const sd = selfDimerDeltaG(sequence);
  const risk = foldRisk(hp.deltaG, sd.deltaG);
  const tail = sequence.slice(-5);
  const gcClamp = [...tail].filter(b => b === 'G' || b === 'C').length;
  const maxHomo = maxHomopolymerRun(sequence);
  const nCount = (sequence.match(/N/g) || []).length;

  const suggestions: string[] = [];
  let score = 100;
  const gcFlag = classifyGC(gc.gcPct, gcLow, gcHigh);
  if (gcFlag !== 'normal') {
    suggestions.push(gcFlag === 'low'
      ? `GC content low (${gc.gcPct.toFixed(1)}%) — extend primer or shift into a GC-richer window.`
      : `GC content high (${gc.gcPct.toFixed(1)}%) — shorten or shift to reduce secondary structure risk.`);
    score -= 18;
  }
  if (tm.tmUsed < 52 || tm.tmUsed > 68) {
    suggestions.push(`Tm ${tm.tmUsed}°C outside ideal PCR window (52–68°C) — adjust length to target ~60°C.`);
    score -= 12;
  }
  if (hp.found && hp.deltaG <= -5) {
    suggestions.push(`Hairpin ΔG ${hp.deltaG} kcal/mol (stem ${hp.stemLength} nt, loop ${hp.loopLength}) — redesign to break the inverted repeat.`);
    score -= hp.deltaG <= -9 ? 20 : 10;
  }
  if (sd.found && sd.deltaG <= -6) {
    suggestions.push(`Self-dimer ΔG ${sd.deltaG} kcal/mol — high primer-dimer risk; change 3′ end.`);
    score -= sd.deltaG <= -9 ? 20 : 10;
  }
  if (gcClamp === 0) {
    suggestions.push('Weak 3′ GC clamp (0 G/C in last 5 nt) — prefer 1–2 G/C at the 3′ end for polymerase anchoring.');
    score -= 8;
  } else if (gcClamp >= 4) {
    suggestions.push(`Overly strong 3′ GC clamp (${gcClamp}/5) — mispriming risk; reduce 3′ G/C.`);
    score -= 8;
  }
  if (maxHomo >= 5) {
    suggestions.push(`Homopolymer run of ${maxHomo} nt — polymerase slippage risk; interrupt the repeat.`);
    score -= 10;
  }
  if (nCount > 0) {
    suggestions.push(`${nCount} ambiguous base(s) (N) — resolve before ordering synthesis.`);
    score -= 5 * nCount;
  }
  if (sequence.length < 15) {
    suggestions.push('Primer shorter than 15 nt — specificity will be poor.');
    score -= 12;
  } else if (sequence.length > 35) {
    suggestions.push('Primer longer than 35 nt — cost up, mismatch tolerance down; consider splitting.');
    score -= 6;
  }

  const profile = gcProfile(sequence, Math.min(20, Math.max(5, Math.floor(sequence.length / 4))), 2);
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const gcSpark = profile.map(p => blocks[Math.min(7, Math.max(0, Math.floor(p / 12.5)))]).join('');

  return {
    sequence, length: sequence.length,
    gcPct: Math.round(gc.gcPct * 10) / 10, gcFlag,
    tm: tm.tmUsed, tmMethod: tm.method, tmWallace: tm.tmWallace,
    hairpinDG: hp.deltaG, selfDimerDG: sd.deltaG, foldRisk: risk,
    gcClamp, maxHomopolymer: maxHomo, nCount,
    score: Math.max(0, Math.min(100, score)),
    suggestions, gcSpark,
  };
}

export interface OptimizationResult {
  optimized: string;
  changes: string[];
  before: PrimerAnalysis;
  after: PrimerAnalysis;
}

/**
 * 1-click primer optimization heuristic:
 *  - trims/pads length toward Tm ≈ 60°C,
 *  - breaks homopolymers ≥4 by transversion that preserves GC class,
 *  - enforces a sane 3′ GC clamp (1–2 GC in last 5).
 */
export function optimizePrimer(seqRaw: string): OptimizationResult {
  const changes: string[] = [];
  let arr = seqRaw.toUpperCase().replace(/U/g, 'T').split('');
  const before = analyzePrimer(arr.join(''));

  // 1. Break homopolymers
  for (let i = 0; i < arr.length; i++) {
    let run = 1;
    while (i + run < arr.length && arr[i + run] === arr[i]) { run++; }
    if (run >= 4) {
      const mid = i + Math.floor(run / 2);
      const old = arr[mid];
      // transversion preserving AT/GC class where possible
      const swap: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };
      arr[mid] = swap[old] ?? old;
      changes.push(`Broke ${run}-nt ${old} run at position ${mid + 1} (${old}→${arr[mid]}).`);
      i += run;
    }
  }

  // 2. Fix 3′ clamp
  const tail5 = arr.slice(-5).join('');
  const clamp = [...tail5].filter(b => b === 'G' || b === 'C').length;
  if (clamp === 0 && arr.length >= 6) {
    // strengthen position -2 to S (G/C) keeping it simple
    const prev = arr[arr.length - 2];
    arr[arr.length - 2] = (prev === 'A' || prev === 'T') ? 'G' : 'C';
    changes.push(`Strengthened 3′ clamp: position ${arr.length - 1} ${prev}→${arr[arr.length - 2]}.`);
  } else if (clamp >= 4 && arr.length >= 6) {
    const prev = arr[arr.length - 2];
    arr[arr.length - 2] = (prev === 'G' || prev === 'C') ? 'A' : 'T';
    changes.push(`Relaxed 3′ clamp (${clamp}/5 G/C): position ${arr.length - 1} ${prev}→${arr[arr.length - 2]}.`);
  }

  // 3. Length tune toward Tm ~60 (only for primer-sized inputs)
  let probe = analyzePrimer(arr.join(''));
  let guard = 0;
  while (probe.tm < 55 && arr.length < 35 && guard++ < 8) {
    arr.push(arr[arr.length % 2 === 0 ? 0 : 1] === 'G' ? 'C' : 'G'); // balanced pad
    changes.push('Extended 3′ end by 1 nt to raise Tm toward ~60°C.');
    probe = analyzePrimer(arr.join(''));
  }
  guard = 0;
  while (probe.tm > 68 && arr.length > 15 && guard++ < 8) {
    const removed = arr.shift();
    changes.push(`Trimmed 5′ base ${removed} to lower Tm toward ~60°C.`);
    probe = analyzePrimer(arr.join(''));
  }

  const after = analyzePrimer(arr.join(''));
  if (changes.length === 0) { changes.push('Primer already near-optimal — no changes applied.'); }
  return { optimized: arr.join(''), changes, before, after };
}
