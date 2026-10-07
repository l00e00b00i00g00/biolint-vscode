/** orf.ts — Open Reading Frame finder + broken-ORF detector. */

import { reverseComplement, normalizeSeq } from './sequence';

export interface Orf {
  frame: number; // 0,1,2
  strand: 1 | -1;
  start: number; // seq index (0-based, inclusive) in input orientation
  end: number;   // exclusive
  length: number;
  complete: boolean;
  protein: string;
}

export interface BrokenOrf {
  kind: 'missing-start' | 'missing-stop' | 'internal-stop' | 'no-orf' | 'short-orf';
  frame: number;
  strand: 1 | -1;
  start: number;
  end: number;
  message: string;
}

const STOPS = new Set(['TAA', 'TAG', 'TGA']);
const START = 'ATG';

const GENETIC_CODE: Record<string, string> = {
  TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L', CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
  ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M', GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
  TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S', CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
  ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T', GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
  TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*', CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
  AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K', GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
  TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W', CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
  AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R', GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
};

export function translate(seq: string): string {
  const s = normalizeSeq(seq);
  let p = '';
  for (let i = 0; i + 3 <= s.length; i += 3) {
    p += GENETIC_CODE[s.slice(i, i + 3)] ?? 'X';
  }
  return p;
}

function findOrfsOneStrand(s: string, strand: 1 | -1, minLen: number, mapIdx: (i: number) => number): Orf[] {
  const out: Orf[] = [];
  for (let frame = 0; frame < 3; frame++) {
    let startCodonPos: number | null = null;
    for (let i = frame; i + 3 <= s.length; i += 3) {
      const codon = s.slice(i, i + 3);
      if (!/^[ACGT]{3}$/.test(codon)) { continue; }
      if (codon === START && startCodonPos === null) {
        startCodonPos = i;
      }
      if (STOPS.has(codon)) {
        if (startCodonPos !== null) {
          const len = i + 3 - startCodonPos;
          if (len >= minLen) {
            out.push({
              frame, strand,
              start: mapIdx(startCodonPos), end: mapIdx(i + 3),
              length: len, complete: true,
              protein: translate(s.slice(startCodonPos, i + 3)),
            });
          }
          startCodonPos = null;
        }
      }
    }
    // dangling start without stop → incomplete (broken)
    if (startCodonPos !== null) {
      const len = s.length - startCodonPos;
      if (len >= minLen) {
        out.push({
          frame, strand,
          start: mapIdx(startCodonPos), end: mapIdx(s.length),
          length: len, complete: false,
          protein: translate(s.slice(startCodonPos)),
        });
      }
    }
  }
  return out;
}

export function findORFs(seq: string, minLen = 90): Orf[] {
  const s = normalizeSeq(seq);
  const fwd = findOrfsOneStrand(s, 1, minLen, i => i);
  const rc = reverseComplement(s);
  const rev = findOrfsOneStrand(rc, -1, minLen, i => s.length - i);
  // normalize rev coords: mapIdx above gives mirrored positions; ensure start<end
  for (const o of rev) {
    const a = Math.min(o.start, o.end), b = Math.max(o.start, o.end);
    o.start = a; o.end = b;
  }
  return [...fwd, ...rev].sort((a, b) => b.length - a.length);
}

/** Detect broken / suspicious ORF architectures. Seq indices in input orientation. */
export function detectBrokenORFs(seq: string, minLen = 90): BrokenOrf[] {
  const s = normalizeSeq(seq);
  const issues: BrokenOrf[] = [];
  if (s.length >= 200) {
    const complete = findORFs(s, minLen).filter(o => o.complete);
    if (complete.length === 0) {
      issues.push({
        kind: 'no-orf', frame: 0, strand: 1, start: 0, end: s.length,
        message: `No complete ORF (AUG…stop, ≥${minLen} nt) in ${s.length} nt — possible broken frame or non-coding insert.`,
      });
    }
  }
  // Per-frame scan for orphan stops (stop before any start) and orphan starts (start, no stop).
  for (let frame = 0; frame < 3; frame++) {
    let seenStart = false;
    for (let i = frame; i + 3 <= s.length; i += 3) {
      const codon = s.slice(i, i + 3);
      if (!/^[ACGT]{3}$/.test(codon)) { continue; }
      if (codon === START) { seenStart = true; }
      if (STOPS.has(codon) && !seenStart) {
        issues.push({
          kind: 'missing-start', frame, strand: 1, start: i, end: i + 3,
          message: `Orphan stop codon ${codon} in frame +${frame + 1} without upstream AUG — 5′-truncated / frameshifted ORF.`,
        });
        break; // one report per frame to avoid noise
      }
    }
    // orphan start: last AUG in frame with no downstream stop
    for (let i = s.length - (s.length - frame) % 3 - 3; i >= frame; i -= 3) {
      if (i < 0) { break; }
      const codon = s.slice(i, i + 3);
      if (!/^[ACGT]{3}$/.test(codon)) { continue; }
      if (STOPS.has(codon)) { break; }
      if (codon === START) {
        // verify no stop between i and end
        let hasStop = false;
        for (let j = i + 3; j + 3 <= s.length; j += 3) {
          if (STOPS.has(s.slice(j, j + 3))) { hasStop = true; break; }
        }
        if (!hasStop && s.length - i >= 30) {
          issues.push({
            kind: 'missing-stop', frame, strand: 1, start: i, end: Math.min(s.length, i + 3),
            message: `AUG in frame +${frame + 1} has no downstream stop — 3′-truncated ORF (runs off contig end).`,
          });
        }
        break;
      }
    }
  }
  return issues;
}
