/**
 * genbank.ts — GenBank annotation validation (the ".gb linter").
 * Checks LOCUS length vs ORIGIN, CDS bounds / start / stop / translation.
 * Coordinates are 1-based over concatenated ORIGIN letters (= raw index + 1
 * for genbank-origin segments), so diagnostics map exactly.
 */

export interface CdsFeature {
  strand: 1 | -1;
  /** Joined exons in 5'→3' transcript order, 1-based inclusive. */
  exons: { start: number; end: number }[];
  translation?: string;
  codonStart: number;
  /** Absolute document offset of the `CDS` feature line (for anchoring). */
  lineOffset: number;
  rawLoc: string;
}

export interface GenBankAnnotations {
  locusName?: string;
  locusLength?: number;
  locusLineOffset: number;
  features: CdsFeature[];
  originOffset: number;
  hasOrigin: boolean;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { starts.push(i + 1); }
  }
  return starts;
}

/** Parse LOCUS + CDS features. Tolerant of wrapped locations and qualifiers. */
export function parseGenBankAnnotations(text: string): GenBankAnnotations {
  const lines = text.split(/\r?\n/);
  const starts = lineStarts(text);
  const out: GenBankAnnotations = { locusLineOffset: 0, features: [], originOffset: -1, hasOrigin: false };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^LOCUS\s/.test(line)) {
      out.locusLineOffset = starts[i] ?? 0;
      const m = line.match(/^LOCUS\s+(\S+)\s+(\d+)\s*bp/i);
      if (m) { out.locusName = m[1]; out.locusLength = parseInt(m[2], 10); }
    }
    if (/^ORIGIN\b/.test(line)) { out.originOffset = starts[i] ?? 0; out.hasOrigin = true; break; }
  }

  // FEATURES block: between FEATURES line and ORIGIN.
  let featStart = lines.findIndex(l => /^FEATURES\b/.test(l));
  const originLine = lines.findIndex(l => /^ORIGIN\b/.test(l));
  if (featStart === -1 || originLine === -1) { return out; }
  featStart++;
  let i = featStart;
  while (i < originLine) {
    const line = lines[i];
    const fm = line.match(/^\s{2,}(\S+)\s+(.*?)\s*$/);
    if (fm && !fm[1].startsWith('/')) {
      const key = fm[1];
      let loc = fm[2];
      const lineOffset = starts[i] ?? 0;
      // Consume wrapped location lines (unbalanced parens) + qualifiers.
      const quals: Record<string, string> = {};
      i++;
      let depth = (loc.match(/\(/g) || []).length - (loc.match(/\)/g) || []).length;
      while (i < originLine && depth > 0 && /^\s+\S/.test(lines[i]) && !/^\s{2,}\S+\s+\S/.test(lines[i])) {
        loc += lines[i].trim();
        depth = (loc.match(/\(/g) || []).length - (loc.match(/\)/g) || []).length;
        i++;
      }
      while (i < originLine) {
        const qm = lines[i].match(/^\s+\/(\w+)(?:=(.*))?$/);
        if (!qm) { break; }
        let val = (qm[2] ?? '').trim();
        i++;
        // Multi-line quoted qualifier (translation often wraps).
        if (val.startsWith('"') && !val.endsWith('"')) {
          while (i < originLine && !lines[i].trimEnd().endsWith('"')) { val += lines[i].trim(); i++; }
          if (i < originLine) { val += lines[i].trim(); i++; }
        }
        quals[qm[1]] = val.replace(/^"|"$/g, '');
      }
      if (key === 'CDS') {
        const parsed = parseLocation(loc);
        if (parsed) {
          out.features.push({
            ...parsed,
            translation: quals['translation'],
            codonStart: quals['codon_start'] ? parseInt(quals['codon_start'], 10) || 1 : 1,
            lineOffset,
            rawLoc: loc,
          });
        }
      }
      continue;
    }
    i++;
  }
  return out;
}

function parseLocation(loc: string): { strand: 1 | -1; exons: { start: number; end: number }[] } | null {
  let s = loc.trim();
  let strand: 1 | -1 = 1;
  const comp = s.match(/^complement\((.*)\)$/);
  if (comp) { strand = -1; s = comp[1]; }
  const join = s.match(/^(?:join|order)\((.*)\)$/);
  const parts = join ? splitTopLevel(join[1]) : [s];
  const exons: { start: number; end: number }[] = [];
  for (const p of parts) {
    const m = p.trim().match(/^(\d+)\.\.(\d+)$/) ?? p.trim().match(/^(\d+)$/);
    if (!m) { return null; } // unsupported (e.g. remote accession, ^ caret) — skip silently
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (!(a >= 1 && b >= a)) { return null; }
    exons.push({ start: a, end: b });
  }
  if (strand === -1) { exons.reverse(); } // 5'→3' transcript order
  return { strand, exons };
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') { depth++; }
    if (ch === ')') { depth--; }
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else { cur += ch; }
  }
  if (cur) { out.push(cur); }
  return out;
}

const COMP: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G', N: 'N', U: 'T' };

/** Spliced 5'→3' coding sequence for a feature over the concatenated ORIGIN. */
export function spliceFeature(concat: string, feat: CdsFeature): string {
  const parts = feat.exons.map(e => concat.slice(e.start - 1, e.end));
  const joined = parts.join('');
  if (feat.strand === 1) { return joined.toUpperCase().replace(/U/g, 'T'); }
  let rc = '';
  for (let k = joined.length - 1; k >= 0; k--) {
    rc += COMP[joined[k].toUpperCase()] ?? 'N';
  }
  return rc;
}

export interface GbIssue {
  kind: 'locus-length' | 'cds-bounds' | 'cds-start' | 'cds-stop' | 'cds-frame' | 'cds-translation';
  message: string;
  /** 1-based seq position to highlight, or -1 to anchor at lineOffset. */
  seqPos: number;
  seqLen: number;
  lineOffset: number;
}

/** Validate annotations against the concatenated ORIGIN sequence. */
export function validateGenBank(concatRaw: string, ann: GenBankAnnotations): GbIssue[] {
  const issues: GbIssue[] = [];
  const concat = concatRaw.toUpperCase().replace(/U/g, 'T');
  if (ann.locusLength !== undefined && ann.locusLength !== concat.length) {
    issues.push({
      kind: 'locus-length', seqPos: -1, seqLen: 0, lineOffset: ann.locusLineOffset,
      message: `LOCUS declares ${ann.locusLength} bp but ORIGIN holds ${concat.length} nt — check for truncated export.`,
    });
  }
  for (const f of ann.features) {
    for (const e of f.exons) {
      if (e.end > concat.length) {
        issues.push({
          kind: 'cds-bounds', seqPos: -1, seqLen: 0, lineOffset: f.lineOffset,
          message: `CDS ${f.rawLoc}: exon ${e.start}..${e.end} exceeds sequence length ${concat.length} — out-of-bounds annotation.`,
        });
      }
    }
    if (f.exons.some(e => e.end > concat.length)) { continue; }
    const coding = spliceFeature(concat, f);
    const frame = coding.slice(f.codonStart - 1);
    const startCodon = frame.slice(0, 3);
    if (startCodon !== 'ATG' && /^[ACGT]{3}$/.test(startCodon)) {
      issues.push({
        kind: 'cds-start', seqPos: f.strand === 1 ? f.exons[0].start : f.exons[f.exons.length - 1].end - 2,
        seqLen: 3, lineOffset: f.lineOffset,
        message: `CDS ${f.rawLoc}: starts with ${startCodon}, not ATG — misannotated start or frameshift (codon_start=${f.codonStart}).`,
      });
    }
    if (frame.length % 3 !== 0) {
      issues.push({
        kind: 'cds-frame', seqPos: -1, seqLen: 0, lineOffset: f.lineOffset,
        message: `CDS ${f.rawLoc}: coding length ${frame.length} nt is not a multiple of 3 — frameshifted annotation.`,
      });
    }
    const stopCodon = frame.slice(Math.max(0, frame.length - 3));
    if (/^[ACGT]{3}$/.test(stopCodon) && !['TAA', 'TAG', 'TGA'].includes(stopCodon)) {
      const lastExon = f.exons[f.exons.length - 1];
      const pos = f.strand === 1 ? lastExon.end - 2 : f.exons[0].start;
      issues.push({
        kind: 'cds-stop', seqPos: pos, seqLen: 3, lineOffset: f.lineOffset,
        message: `CDS ${f.rawLoc}: ends with ${stopCodon}, not a stop codon — 3′-truncated or read-through annotation.`,
      });
    }
    if (f.translation !== undefined) {
      const expected = f.translation.replace(/\s+/g, '').toUpperCase();
      const actual = translateNoStop(frame);
      if (expected !== actual) {
        issues.push({
          kind: 'cds-translation', seqPos: -1, seqLen: 0, lineOffset: f.lineOffset,
          message: `CDS ${f.rawLoc}: /translation disagrees with sequence (annotated ${expected.length} aa vs computed ${actual.length} aa) — stale annotation.`,
        });
      }
    }
  }
  return issues;
}

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

function translateNoStop(frame: string): string {
  let p = '';
  for (let i = 0; i + 3 <= frame.length; i += 3) {
    const codon = frame.slice(i, i + 3);
    if (!/^[ACGT]{3}$/.test(codon)) { p += 'X'; continue; }
    const aa = GENETIC_CODE[codon] ?? 'X';
    if (aa === '*') { break; }
    p += aa;
  }
  return p;
}
