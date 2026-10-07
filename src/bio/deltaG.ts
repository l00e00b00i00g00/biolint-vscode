/**
 * deltaG.ts — lightweight intramolecular folding estimates:
 * hairpin (inverted repeat + loop) and self-dimer (primer-primer) ΔG.
 * Heuristic energy model calibrated to flag risky primers (ΔG < thresholds),
 * NOT a full Zuker/MFOLD partition function.
 */

/**
 * NOTE (v1.1.0 audit): folding alignments score the query against the PLAIN
 * REVERSE of the partner strand — never the reverse-complement. In an
 * antiparallel duplex, facing bases (top 5'→3', bottom 3'→5') must be
 * Watson-Crick complementary, i.e. bottom[j] == complement(top[i]), which
 * pairing against reverse() tests directly. Using reverseComplement() here
 * detects direct repeats instead of inverted ones (physically wrong).
 */

function rev(s: string): string {
  return s.split('').reverse().join('');
}

export interface HairpinResult {
  deltaG: number; // kcal/mol, most stable found
  stemStart: number;
  stemLength: number;
  loopLength: number;
  found: boolean;
}

export interface SelfDimerResult {
  deltaG: number;
  shift: number;
  overlap: number;
  alignment: string;
  found: boolean;
}

export type FoldRisk = 'low' | 'medium' | 'high';

function pairEnergy(a: string, b: string): number {
  const x = a.toUpperCase(), y = b.toUpperCase();
  if ((x === 'G' && y === 'C') || (x === 'C' && y === 'G')) { return -1.5; }
  if ((x === 'A' && y === 'T') || (x === 'T' && y === 'A')) { return -0.9; }
  if ((x === 'G' && y === 'T') || (x === 'T' && y === 'G')) { return -0.4; } // wobble
  return 0.6; // mismatch penalty
}

/** Scan for inverted repeats: stem 4..9 nt, loop 3..11 nt. */
export function hairpinDeltaG(seq: string): HairpinResult {
  const s = seq.toUpperCase().replace(/U/g, 'T');
  let best: HairpinResult = { deltaG: 0, stemStart: -1, stemLength: 0, loopLength: 0, found: false };
  const n = s.length;
  if (n < 11) { return best; }
  for (let i = 0; i < n; i++) {
    for (let stem = 4; stem <= 9; stem++) {
      for (let loop = 3; loop <= 11; loop++) {
        const j = i + stem + loop; // start of downstream arm
        if (j + stem > n) { continue; }
        const left = s.slice(i, i + stem);
        const right = s.slice(j, j + stem);
        const revRight = rev(right);
        let e = 0;
        for (let k = 0; k < stem; k++) { e += pairEnergy(left[k], revRight[k]); }
        e += 3.5 + loop * 0.35; // loop entropy penalty
        if (e < best.deltaG) {
          best = { deltaG: round1(e), stemStart: i, stemLength: stem, loopLength: loop, found: true };
        }
      }
    }
  }
  return best;
}

/** Align sequence against its own reverse complement at all shifts; best overlap wins. */
export function selfDimerDeltaG(seq: string): SelfDimerResult {
  return heteroDimerDeltaG(seq, seq);
}

/**
 * Heterodimer ΔG between two primers (a vs reverse-complement of b).
 * This is the general core; selfDimerDeltaG(a) === heteroDimerDeltaG(a, a).
 */
export function heteroDimerDeltaG(aRaw: string, bRaw: string): SelfDimerResult {
  const a = aRaw.toUpperCase().replace(/U/g, 'T');
  const revB = rev(bRaw.toUpperCase().replace(/U/g, 'T'));
  const n = a.length, m = revB.length;
  let best: SelfDimerResult = { deltaG: 0, shift: 0, overlap: 0, alignment: '', found: false };
  if (n < 6 || m < 6) { return best; }
  for (let shift = -(m - 1); shift <= n - 1; shift++) {
    let e = 4.1; // bimolecular initiation
    let overlap = 0;
    let matches = 0;
    let alignTop = '', alignMid = '', alignBot = '';
    for (let i = 0; i < n; i++) {
      const j = i - shift;
      if (j < 0 || j >= m) { continue; }
      overlap++;
      const pe = pairEnergy(a[i], revB[j]);
      e += pe;
      if (pe < 0) { matches++; }
      alignTop += a[i]; alignMid += pe < 0 ? '|' : ' '; alignBot += revB[j];
    }
    if (overlap >= 5 && matches >= 4 && e < best.deltaG) {
      best = {
        deltaG: round1(e), shift, overlap,
        alignment: `${alignTop}\n${alignMid}\n${alignBot}`,
        found: true,
      };
    }
  }
  return best;
}

export function foldRisk(hairpinDG: number, dimerDG: number): FoldRisk {
  const worst = Math.min(hairpinDG, dimerDG);
  if (worst <= -9) { return 'high'; }
  if (worst <= -5) { return 'medium'; }
  return 'low';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
