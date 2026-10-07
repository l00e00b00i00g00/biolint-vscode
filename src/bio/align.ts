/**
 * align.ts — pairwise construct comparison (v1.2.0 "diff two constructs").
 * Needleman-Wunsch global alignment (linear gap penalty), capped at 15k nt
 * per sequence; beyond that a positional diff on the shared prefix is used
 * and flagged as approximate.
 */

export type VariantKind = 'snp' | 'insertion' | 'deletion' | 'complex';

export interface Variant {
  kind: VariantKind;
  /** 0-based position in A (for del: first deleted base; ins: anchor before). */
  posA: number;
  /** 0-based position in B. */
  posB: number;
  from: string;
  to: string;
}

export interface AlignmentResult {
  variants: Variant[];
  identity: number; // 0..1 over aligned columns
  alignedLength: number;
  approximate: boolean;
  truncated: boolean;
}

const MATCH = 2;
const MISMATCH = -3;
const GAP = -4;
const MAX_NW = 15000;
const MAX_VARIANTS = 500;

export function alignConstructs(aRaw: string, bRaw: string): AlignmentResult {
  const a = aRaw.toUpperCase().replace(/U/g, 'T');
  const b = bRaw.toUpperCase().replace(/U/g, 'T');
  if (a.length > MAX_NW || b.length > MAX_NW) {
    return positionalDiff(a.slice(0, MAX_NW), b.slice(0, MAX_NW), true, true);
  }
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) {
    return { variants: [], identity: n === m ? 1 : 0, alignedLength: Math.max(n, m), approximate: false, truncated: false };
  }
  // Score matrix (n+1)×(m+1), Int32 for memory (15k² × 4B = 900MB — too big!).
  // Banded fallback: full matrix only when n*m <= 25M, else positional diff.
  if (n * m > 25_000_000) {
    return positionalDiff(a, b, true, false);
  }
  const W = m + 1;
  const score = new Int32Array((n + 1) * W);
  const trace = new Uint8Array((n + 1) * W); // 0 diag, 1 up (del in B), 2 left (ins in B)
  for (let i = 1; i <= n; i++) { score[i * W] = i * GAP; trace[i * W] = 1; }
  for (let j = 1; j <= m; j++) { score[j] = j * GAP; trace[j] = 2; }
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      const diag = score[(i - 1) * W + (j - 1)] + (ai === b[j - 1] ? MATCH : MISMATCH);
      const up = score[(i - 1) * W + j] + GAP;
      const left = score[i * W + (j - 1)] + GAP;
      const idx = i * W + j;
      if (diag >= up && diag >= left) { score[idx] = diag; trace[idx] = 0; }
      else if (up >= left) { score[idx] = up; trace[idx] = 1; }
      else { score[idx] = left; trace[idx] = 2; }
    }
  }
  // Traceback → aligned columns.
  const colA: string[] = [];
  const colB: string[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const t = i > 0 && j > 0 ? trace[i * W + j] : i > 0 ? 1 : 2;
    if (t === 0) { colA.push(a[i - 1]); colB.push(b[j - 1]); i--; j--; }
    else if (t === 1) { colA.push(a[i - 1]); colB.push('-'); i--; }
    else { colA.push('-'); colB.push(b[j - 1]); j--; }
  }
  colA.reverse(); colB.reverse();
  // Collapse columns into variants.
  const variants: Variant[] = [];
  let matches = 0;
  let pA = 0, pB = 0;
  let k = 0;
  const total = colA.length;
  while (k < total && variants.length < MAX_VARIANTS) {
    if (colA[k] === colB[k]) { matches++; if (colA[k] !== '-') { pA++; pB++; } k++; continue; }
    if (colA[k] !== '-' && colB[k] !== '-') {
      variants.push({ kind: 'snp', posA: pA, posB: pB, from: colA[k], to: colB[k] });
      pA++; pB++; k++; continue;
    }
    // Gap run → single indel variant.
    let delSeq = '', insSeq = '';
    const startA = pA, startB = pB;
    while (k < total && (colA[k] === '-' || colB[k] === '-')) {
      if (colA[k] === '-') { insSeq += colB[k]; pB++; }
      else { delSeq += colA[k]; pA++; }
      k++;
    }
    if (delSeq && insSeq) {
      variants.push({ kind: 'complex', posA: startA, posB: startB, from: delSeq, to: insSeq });
    } else if (delSeq) {
      variants.push({ kind: 'deletion', posA: startA, posB: startB, from: delSeq, to: '' });
    } else {
      variants.push({ kind: 'insertion', posA: startA, posB: startB, from: '', to: insSeq });
    }
  }
  return {
    variants,
    identity: total === 0 ? 1 : matches / total,
    alignedLength: total,
    approximate: false,
    truncated: variants.length >= MAX_VARIANTS,
  };
}

/** Fast positional diff for huge sequences (shared prefix + length tail). */
function positionalDiff(a: string, b: string, approximate: boolean, truncated: boolean): AlignmentResult {
  const variants: Variant[] = [];
  const shared = Math.min(a.length, b.length);
  let matches = 0;
  for (let k = 0; k < shared && variants.length < MAX_VARIANTS; k++) {
    if (a[k] === b[k]) { matches++; }
    else { variants.push({ kind: 'snp', posA: k, posB: k, from: a[k], to: b[k] }); }
  }
  if (a.length !== b.length && variants.length < MAX_VARIANTS) {
    if (a.length > b.length) {
      variants.push({ kind: 'deletion', posA: shared, posB: shared, from: a.slice(shared, shared + 50), to: '' });
    } else {
      variants.push({ kind: 'insertion', posA: shared, posB: shared, from: '', to: b.slice(shared, shared + 50) });
    }
  }
  const total = Math.max(a.length, b.length, 1);
  return { variants, identity: matches / total, alignedLength: total, approximate, truncated: truncated || variants.length >= MAX_VARIANTS };
}
