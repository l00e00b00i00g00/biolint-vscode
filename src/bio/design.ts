/**
 * design.ts — de-novo primer design (v2.0).
 * Given a construct and a target interval, scans flanking windows for
 * primer candidates and returns the best fwd/rev pairs by Tm match,
 * dimer safety and individual primer score.
 */
import { analyzePrimer, analyzePair, PrimerAnalysis } from './primer';
import { TmOptions } from './tm';

export interface DesignOptions {
  primerLenMin?: number;
  primerLenMax?: number;
  gcLow?: number;
  gcHigh?: number;
  tmMin?: number;
  tmMax?: number;
  maxDeltaTm?: number;
  flank?: number; // nt scanned on each side of the target
  topN?: number;
  tmOpts?: TmOptions;
}

export interface DesignedPair {
  fwd: PrimerAnalysis;
  rev: PrimerAnalysis;
  fwdStart: number; // 0-based in construct
  revStart: number; // 0-based position of the rev binding site (forward orientation)
  productSize: number;
  deltaTm: number;
  heteroDimerDG: number;
  score: number;
}

const DEF = {
  primerLenMin: 18, primerLenMax: 25,
  gcLow: 40, gcHigh: 60, tmMin: 57, tmMax: 63,
  maxDeltaTm: 5, flank: 400, topN: 3,
};

function candidates(
  seq: string, from: number, to: number, o: Required<Omit<DesignOptions, 'tmOpts'>>,
  gcLow: number, gcHigh: number, tmOpts: TmOptions,
): { seq: string; start: number; analysis: PrimerAnalysis }[] {
  const out: { seq: string; start: number; analysis: PrimerAnalysis }[] = [];
  const lo = Math.max(0, from), hi = Math.min(seq.length, to);
  for (let len = o.primerLenMin; len <= o.primerLenMax; len++) {
    for (let s = lo; s + len <= hi; s += 1) {
      const sub = seq.slice(s, s + len);
      if (/[^ACGT]/.test(sub)) { continue; }
      const a = analyzePrimer(sub, gcLow, gcHigh, tmOpts);
      if (a.gcPct < o.gcLow || a.gcPct > o.gcHigh) { continue; }
      if (a.tm < o.tmMin || a.tm > o.tmMax) { continue; }
      if (a.maxHomopolymer >= 5 || a.nCount > 0) { continue; }
      // Pre-filter extremes only — medium risks are penalized in pair scoring
      // (analyzePair still gates heterodimers and HIGH folding risk).
      if (a.hairpinDG <= -9 || a.selfDimerDG <= -9) { continue; }
      out.push({ seq: sub, start: s, analysis: a });
      if (out.length >= 400) { return out; }
    }
  }
  return out;
}

export function designPrimers(
  constructRaw: string, targetStart: number, targetEnd: number, opts: DesignOptions = {},
): DesignedPair[] {
  const o = { ...DEF, ...opts };
  const tmOpts = opts.tmOpts ?? {};
  const seq = constructRaw.toUpperCase().replace(/U/g, 'T');
  const ts = Math.max(0, Math.min(targetStart, targetEnd));
  const te = Math.min(seq.length, Math.max(targetStart, targetEnd));
  if (te - ts < 10 || seq.length < 50) { return []; }
  // Forward primer: 3' end anchored in [ts-flank, ts]; reverse primer binding
  // site starts in [te, te+flank] (reported 5'→3' as synthesized).
  const fwdCands = candidates(seq, ts - o.flank, ts, o, o.gcLow, o.gcHigh, tmOpts)
    .filter(c => c.start + c.seq.length <= ts + 5);
  const revSiteCands = candidates(seq, te, te + o.flank, o, o.gcLow, o.gcHigh, tmOpts)
    .filter(c => c.start >= te - 5);
  const pairs: DesignedPair[] = [];
  for (const f of fwdCands) {
    for (const r of revSiteCands) {
      const revSeq = reverseStr(r.seq);
      const pair = analyzePair(f.seq, revSeq, o.gcLow, o.gcHigh, tmOpts, o.maxDeltaTm);
      if (!pair.ok) { continue; }
      const productSize = (r.start + r.seq.length) - f.start;
      if (productSize < te - ts || productSize > 5000) { continue; }
      pairs.push({
        fwd: f.analysis, rev: pair.reverse,
        fwdStart: f.start, revStart: r.start,
        productSize, deltaTm: pair.deltaTm, heteroDimerDG: pair.heteroDimerDG,
        score: Math.round((f.analysis.score + pair.reverse.score) / 2 - pair.deltaTm * 4 + pair.heteroDimerDG),
      });
    }
  }
  return pairs.sort((a, b) => b.score - a.score).slice(0, o.topN);
}

function reverseStr(s: string): string {
  // Reverse-complement: the synthesized reverse primer.
  const comp: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G', N: 'N' };
  let out = '';
  for (let i = s.length - 1; i >= 0; i--) { out += comp[s[i]] ?? 'N'; }
  return out;
}

export function pairReport(p: DesignedPair, targetStart: number, targetEnd: number): string {
  return `Designed pair — product ${p.productSize} nt covering target ${targetStart + 1}..${targetEnd}:\n` +
    `• FWD [${p.fwdStart + 1}..${p.fwdStart + p.fwd.length}] Tm ${p.fwd.tm}°C GC ${p.fwd.gcPct}% score ${p.fwd.score}\n  ${p.fwd.sequence}\n` +
    `• REV (binds ${p.revStart + 1}..${p.revStart + p.rev.sequence.length}) Tm ${p.rev.tm}°C GC ${p.rev.gcPct}% score ${p.rev.score}\n  ${p.rev.sequence}\n` +
    `• ΔTm ${p.deltaTm}°C · heterodimer ΔG ${p.heteroDimerDG} kcal/mol · pair score ${p.score}`;
}
