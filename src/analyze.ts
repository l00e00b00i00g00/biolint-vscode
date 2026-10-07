/**
 * analyze.ts — vscode-free document analysis core (v2.0).
 * All lint rules run here on plain strings and return serializable Findings
 * (document offsets, never Positions), so the SAME code executes on the main
 * thread (small files) and inside a worker_thread (large files) with zero drift.
 */
import {
  extractSegments, findInvalidChars, stripToPure, reverseComplement, DnaSegment,
  gcContent, analyzePrimer, detectBrokenORFs, findORFs,
  screenSequence, ThreatEntry,
  cai, findRareCodons, loadCodonTable,
  parseGenBankAnnotations, validateGenBank,
} from './bio';

/** Mirrors vscode.DiagnosticSeverity: Error=0, Warning=1, Information=2, Hint=3. */
export type FindingSeverity = 0 | 1 | 2 | 3;

export interface Finding {
  start: number; // document offset, inclusive
  end: number;   // document offset, exclusive
  severity: FindingSeverity;
  message: string;
  code: string;
}

export interface AnalyzeOpts {
  fileLanguageId?: string;
  minPrimerLength: number;
  gcWarnLow: number;
  gcWarnHigh: number;
  minOrfLength: number;
  tmPrimerConcNM: number;
  tmNaConcMM: number;
  tmMgConcMM: number;
  codonHost: 'ecoli' | 'yeast' | 'human';
  codonCaiWarnBelow: number;
  customTablePath: string;
  threatEntries: ThreatEntry[];
  dbVersion: string;
}

export const CODE = {
  invalidBase: 'biolint.invalid-base',
  gc: 'biolint.gc-content',
  hairpin: 'biolint.hairpin',
  dimer: 'biolint.self-dimer',
  brokenOrf: 'biolint.broken-orf',
  codon: 'biolint.codon-cai',
  gbAnnotation: 'biolint.genbank-annotation',
  rejected: 'biolint.bioguard-rejected',
  flagged: 'biolint.bioguard-flagged',
  suggestion: 'biolint.primer-suggestion',
} as const;

export const MAX_GC_WINDOW_DIAGS = 40;
export const MAX_DIAGS = 500;
/** Files above this size are analyzed in a worker_thread (v2.0). */
export const WORKER_THRESHOLD = 500_000;
/** Hard ceiling — files above are skipped (stale diagnostics cleared by caller). */
export const HARD_CEILING = 2_000_000;

export interface AnalyzeResult {
  findings: Finding[];
  segments: number;
  verdict: 'APPROVED' | 'FLAGGED_FOR_REVIEW' | 'REJECTED';
  rejected: number;
  flagged: number;
  errors: number;
  warnings: number;
}

export function analyzeDocumentText(fileName: string, text: string, opts: AnalyzeOpts): AnalyzeResult {
  const findings: Finding[] = [];
  const push = (f: Finding): void => { findings.push(f); };
  const segments = extractSegments(fileName, text, opts.minPrimerLength);
  const tmOpts = { primerConcNM: opts.tmPrimerConcNM, naConcMM: opts.tmNaConcMM, mgConcMM: opts.tmMgConcMM };

  let gcWindows = 0;
  let gcWindowsSkipped = 0;
  for (const seg of segments) {
    lintInvalidBases(seg, push);
    const r = lintThermo(seg, opts, tmOpts, gcWindows, push);
    gcWindows += r.windows; gcWindowsSkipped += r.skipped;
    lintOrfs(seg, opts, push);
    lintCodons(seg, opts, push);
    if (opts.threatEntries.length > 0) {
      const { pure, map } = stripToPure(seg.raw);
      if (pure.length >= 8) {
        const res = screenSequence(pure, opts.threatEntries, opts.dbVersion, 'local');
        pushBioguard(seg, res.matches, map, push);
      }
    }
    if (findings.length > MAX_DIAGS) { break; }
  }
  lintGenBankAnnotations(fileName, opts.fileLanguageId, text, push);
  if (gcWindowsSkipped > 0 && segments.length > 0) {
    const first = segments[0];
    push({
      start: first.seqToDoc[0] ?? 0,
      end: (first.seqToDoc[Math.min(11, first.seqToDoc.length - 1)] ?? 0) + 1,
      severity: 2,
      message: `BioLint: …and ${gcWindowsSkipped} more GC-anomalous windows capped from Problems — open the Sequence Visualizer for the full GC profile.`,
      code: CODE.gc,
    });
  }
  const out = findings.slice(0, MAX_DIAGS);
  let errors = 0, warnings = 0, rejected = 0, flagged = 0;
  for (const d of out) {
    if (d.severity === 0) { errors++; }
    else if (d.severity === 1) { warnings++; }
    if (d.code === CODE.rejected) { rejected++; }
    else if (d.code === CODE.flagged) { flagged++; }
  }
  return {
    findings: out,
    segments: segments.length,
    verdict: rejected > 0 ? 'REJECTED' : flagged > 0 ? 'FLAGGED_FOR_REVIEW' : 'APPROVED',
    rejected, flagged, errors, warnings,
  };
}

function rangeForRaw(seg: DnaSegment, rawStart: number, rawEnd: number): [number, number] {
  if (seg.seqToDoc.length === 0) { return [0, 1]; }
  const s = Math.max(0, Math.min(rawStart, seg.seqToDoc.length - 1));
  const e = Math.max(s + 1, Math.min(rawEnd, seg.seqToDoc.length));
  const startOff = seg.seqToDoc[s];
  const endOff = (e - 1 < seg.seqToDoc.length ? seg.seqToDoc[e - 1] + 1 : startOff + 1);
  return [startOff, endOff];
}

function rangeForPure(seg: DnaSegment, map: number[], pureStart: number, pureEnd: number): [number, number] {
  if (map.length === 0) { return rangeForRaw(seg, 0, 1); }
  const rawStart = map[Math.max(0, Math.min(pureStart, map.length - 1))] ?? 0;
  const rawLast = map[Math.max(0, Math.min(pureEnd - 1, map.length - 1))] ?? rawStart;
  return rangeForRaw(seg, rawStart, rawLast + 1);
}

/** Expand an offset to its full line span (for feature/LOCUS-anchored issues). */
function lineSpan(text: string, offset: number): [number, number] {
  const off = Math.max(0, Math.min(offset, text.length));
  let s = off;
  while (s > 0 && text[s - 1] !== '\n') { s--; }
  let e = off;
  while (e < text.length && text[e] !== '\n') { e++; }
  return [s, Math.max(e, s + 1)];
}

function lintInvalidBases(seg: DnaSegment, push: (f: Finding) => void): void {
  for (const inv of findInvalidChars(seg)) {
    push({
      start: inv.docOffset, end: inv.docOffset + 1, severity: 0,
      message: `BioLint: invalid base '${inv.char}' in ${seg.id} — synthesis requires A/C/G/T (N for ambiguous).`,
      code: CODE.invalidBase,
    });
  }
}

function lintThermo(
  seg: DnaSegment, opts: AnalyzeOpts,
  tmOpts: { primerConcNM: number; naConcMM: number; mgConcMM: number },
  gcWindowsSoFar: number, push: (f: Finding) => void,
): { windows: number; skipped: number } {
  let windows = 0;
  let skipped = 0;
  const { pure, map } = stripToPure(seg.raw);
  if (pure.length < opts.minPrimerLength) { return { windows, skipped }; }
  const pureRange = (ps: number, pe: number): [number, number] => rangeForPure(seg, map, ps, pe);

  if (pure.length > 600) {
    const win = 200;
    for (let i = 0; i + win <= pure.length; i += win) {
      const gc = gcContent(pure.slice(i, i + win));
      if (gc.gcPct < opts.gcWarnLow || gc.gcPct > opts.gcWarnHigh) {
        if (gcWindowsSoFar + windows >= MAX_GC_WINDOW_DIAGS) { skipped++; continue; }
        windows++;
        const [s, e] = pureRange(i, i + win);
        push({
          start: s, end: e, severity: 1,
          message: `BioLint: GC ${gc.gcPct.toFixed(1)}% over ${win} nt (healthy ${opts.gcWarnLow}–${opts.gcWarnHigh}%) — PCR/structure risk.`,
          code: CODE.gc,
        });
      }
    }
    return { windows, skipped };
  }
  const a = analyzePrimer(pure, opts.gcWarnLow, opts.gcWarnHigh, tmOpts);
  if (a.gcFlag !== 'normal') {
    const [s, e] = pureRange(0, pure.length);
    push({
      start: s, end: e, severity: 1,
      message: `BioLint: GC ${a.gcPct}% (${a.gcFlag === 'low' ? 'AT-rich' : 'GC-rich'}) — ${a.suggestions[0] ?? ''}`,
      code: CODE.gc,
    });
  }
  if (a.hairpinDG <= -5) {
    const stem = a.hairpinStem;
    const [s, e] = stem ? pureRange(stem.start, stem.start + stem.length) : pureRange(0, pure.length);
    push({
      start: s, end: e, severity: 1,
      message: `BioLint: hairpin ΔG ${a.hairpinDG} kcal/mol (stem ${stem ? `${stem.length} nt, loop ${stem.loop}` : 'detected'}) — unstable secondary structure (see hover for details).`,
      code: CODE.hairpin,
    });
  }
  if (a.selfDimerDG <= -6) {
    const [s, e] = pureRange(0, pure.length);
    push({
      start: s, end: e, severity: 1,
      message: `BioLint: self-dimer ΔG ${a.selfDimerDG} kcal/mol — primer-dimer risk in PCR.`,
      code: CODE.dimer,
    });
  }
  const actionable = a.suggestions.filter(s2 => /clamp|Homopolymer|ambiguous|shorter|longer/i.test(s2));
  for (const sug of actionable.slice(0, 2)) {
    const [s, e] = pureRange(Math.max(0, pure.length - 8), pure.length);
    push({ start: s, end: e, severity: 2, message: `BioLint suggestion: ${sug}`, code: CODE.suggestion });
  }
  return { windows, skipped };
}

function lintOrfs(seg: DnaSegment, opts: AnalyzeOpts, push: (f: Finding) => void): void {
  const { pure, map } = stripToPure(seg.raw);
  if (pure.length < 60) { return; }
  for (const b of detectBrokenORFs(pure, opts.minOrfLength)) {
    const ps = Math.min(b.start, Math.max(0, map.length - 1));
    const pe = Math.min(Math.max(b.end, ps + 1), map.length);
    const [s, e] = b.kind === 'no-orf'
      ? rangeForRaw(seg, 0, Math.min(12, seg.seqToDoc.length))
      : rangeForPure(seg, map, ps, pe);
    push({ start: s, end: e, severity: 1, message: `BioLint: broken ORF — ${b.message}`, code: CODE.brokenOrf });
  }
}

function lintCodons(seg: DnaSegment, opts: AnalyzeOpts, push: (f: Finding) => void): void {
  const { pure, map } = stripToPure(seg.raw);
  if (pure.length < 60) { return; }
  const table = loadCodonTable(opts.codonHost, opts.customTablePath);
  let emitted = 0;
  for (const o of findORFs(pure, opts.minOrfLength)) {
    if (emitted >= 5) { break; }
    if (!o.complete) { continue; }
    const slice = pure.slice(o.start, o.end);
    const coding = o.strand === 1 ? slice : reverseComplement(slice);
    const value = cai(coding, table);
    if (value < opts.codonCaiWarnBelow) {
      const nRare = findRareCodons(coding, table).length;
      const [s, e] = rangeForPure(seg, map, o.start, Math.min(o.end, o.start + 30));
      push({
        start: s, end: e, severity: 2,
        message: `BioLint suggestion: ORF CAI ${value.toFixed(2)} for ${table.name} (${nRare} rare codons) — run “BioLint: Optimize Codons for Host”.`,
        code: CODE.codon,
      });
      emitted++;
    }
  }
}

function lintGenBankAnnotations(fileName: string, languageId: string | undefined, text: string, push: (f: Finding) => void): void {
  const name = fileName.toLowerCase();
  const isGb = languageId === 'biogenbank' ||
    name.endsWith('.gb') || name.endsWith('.gbk') || name.endsWith('.genbank') || name.endsWith('.gbf');
  if (!isGb) { return; }
  const ann = parseGenBankAnnotations(text);
  if (!ann.hasOrigin) { return; }
  const segments = extractSegments(fileName, text, 1);
  const origin = segments.find(s => s.kind === 'genbank-origin');
  if (!origin) { return; }
  for (const issue of validateGenBank(origin.raw, ann)) {
    let span: [number, number];
    if (issue.seqPos >= 1 && issue.seqPos - 1 < origin.raw.length) {
      const rs = issue.seqPos - 1;
      span = rangeForRaw(origin, rs, Math.min(origin.raw.length, rs + Math.max(1, issue.seqLen)));
    } else {
      span = lineSpan(text, issue.lineOffset);
    }
    push({
      start: span[0], end: span[1],
      severity: issue.kind === 'cds-bounds' ? 0 : 1,
      message: `BioLint: GenBank annotation — ${issue.message}`,
      code: CODE.gbAnnotation,
    });
  }
}

function pushBioguard(
  seg: DnaSegment,
  matches: import('./bio').ThreatMatch[], map: number[],
  push: (f: Finding) => void,
): void {
  for (const m of matches.slice(0, 20)) {
    const [s, e] = rangeForPure(seg, map, m.position, m.position + m.matchedKmer.length);
    const critical = m.entry.severity === 'REJECTED';
    push({
      start: s, end: e, severity: 0,
      message: critical
        ? `BioLint CRITICAL: '${m.entry.name}' matches restricted agent pattern [${m.entry.regulation}] — synthesis blocked (IIGS/CDC). See BioGuard Command Center.`
        : `BioLint: '${m.entry.name}' flagged for review [${m.entry.regulation}] — confirm compliance before synthesis.`,
      code: critical ? CODE.rejected : CODE.flagged,
    });
  }
}
