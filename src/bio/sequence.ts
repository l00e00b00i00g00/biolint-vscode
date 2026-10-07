/**
 * sequence.ts — parsers for FASTA / FASTQ / GenBank / inline DNA in code & YAML.
 * Maps every cleaned sequence character back to its document offset so that
 * diagnostics, hovers and code actions can highlight the exact source range.
 */

export type SegmentKind = 'fasta' | 'genbank-origin' | 'fastq' | 'inline';

export interface DnaSegment {
  /** Record / contig id (FASTA header, LOCUS, read name, or inline-n). */
  id: string;
  /** Cleaned sequence, uppercase, whitespace/digits stripped (may still contain invalid letters for linting). */
  raw: string;
  /** For each char of `raw`, the document offset it came from. */
  seqToDoc: number[];
  kind: SegmentKind;
  /** Document offset where the record starts (header line). */
  recordOffset: number;
}

export interface InvalidChar {
  segmentId: string;
  seqIndex: number;
  docOffset: number;
  char: string;
}

const VALID_SEQ = new Set(['A', 'C', 'G', 'T', 'N', 'U']);

export function isValidBase(ch: string): boolean {
  return VALID_SEQ.has(ch.toUpperCase());
}

export function cleanBase(ch: string): string {
  return ch.toUpperCase();
}

/** Find invalid (non-ACGTN) letters inside an already-extracted segment. */
export function findInvalidChars(seg: DnaSegment): InvalidChar[] {
  const out: InvalidChar[] = [];
  for (let i = 0; i < seg.raw.length; i++) {
    const ch = seg.raw[i];
    // '-' and '.' are accepted gap chars in alignments; digits/spaces already stripped.
    if (ch === '-' || ch === '.') { continue; }
    if (!isValidBase(ch)) {
      out.push({ segmentId: seg.id, seqIndex: i, docOffset: seg.seqToDoc[i], char: ch });
    }
  }
  return out;
}

function pushRecord(
  segments: DnaSegment[], id: string, chars: string[], offsets: number[],
  kind: SegmentKind, recordOffset: number,
): void {
  if (chars.length === 0) { return; }
  segments.push({ id, raw: chars.join(''), seqToDoc: offsets.slice(), kind, recordOffset });
}

/** Start offset of every line — exact for LF and CRLF alike. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { starts.push(i + 1); }
  }
  return starts;
}

/** Parse FASTA text (headers start with '>' or ';' comment). */
export function parseFasta(text: string): DnaSegment[] {
  const segments: DnaSegment[] = [];
  let curId = 'seq-1';
  let curRecordOffset = 0;
  let chars: string[] = [];
  let offsets: number[] = [];
  let recordCount = 0;
  const lines = text.split(/\r?\n/);
  const starts = lineStarts(text);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const lineStart = starts[ln] ?? 0;
    const trimmed = line.trim();
    if (trimmed.startsWith('>') || trimmed.startsWith(';')) {
      if (chars.length > 0) {
        pushRecord(segments, curId, chars, offsets, 'fasta', curRecordOffset);
        chars = []; offsets = [];
      }
      if (trimmed.startsWith('>')) {
        recordCount++;
        curId = trimmed.slice(1).trim().split(/\s+/)[0] || `seq-${recordCount}`;
        curRecordOffset = lineStart;
      }
    } else if (trimmed.length > 0) {
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === ' ' || ch === '\t' || ch === '\r') { continue; }
        if (/[0-9]/.test(ch)) { continue; }
        chars.push(cleanBase(ch));
        offsets.push(lineStart + i);
      }
    }
  }
  if (chars.length > 0) {
    pushRecord(segments, curId || 'seq-1', chars, offsets, 'fasta', curRecordOffset);
  }
  return segments;
}

/** Parse FASTQ (4 lines per read: @name, seq, +, qual). */
export function parseFastq(text: string): DnaSegment[] {
  const segments: DnaSegment[] = [];
  const lines = text.split(/\r?\n/);
  const starts = lineStarts(text);
  for (let i = 0; i + 3 < lines.length; i += 4) {
    const header = lines[i].trim();
    if (!header.startsWith('@')) { continue; }
    const id = header.slice(1).split(/\s+/)[0] || `read-${i / 4 + 1}`;
    const seqLine = lines[i + 1] ?? '';
    const base = starts[i + 1] ?? 0;
    const chars: string[] = [];
    const offs: number[] = [];
    for (let j = 0; j < seqLine.length; j++) {
      const ch = seqLine[j];
      if (ch === ' ' || ch === '\t' || ch === '\r') { continue; }
      chars.push(cleanBase(ch));
      offs.push(base + j);
    }
    pushRecord(segments, id, chars, offs, 'fastq', starts[i] ?? 0);
  }
  return segments;
}

/** Parse GenBank: sequence lives after ORIGIN (positions + letters), ends with //. */
export function parseGenBank(text: string): DnaSegment[] {
  const segments: DnaSegment[] = [];
  const locusMatch = text.match(/^LOCUS\s+(\S+)/m);
  const id = locusMatch ? locusMatch[1] : 'genbank-origin';
  const originIdx = text.indexOf('ORIGIN');
  if (originIdx === -1) {
    // No ORIGIN — fall back to inline extraction so FEATURES/table coords still lint.
    return extractInline(text, id, 15);
  }
  const chars: string[] = [];
  const offs: number[] = [];
  // walk char by char after ORIGIN
  for (let i = originIdx + 'ORIGIN'.length; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') { break; }
    if (/[a-zA-Z]/.test(ch)) {
      chars.push(cleanBase(ch));
      offs.push(i);
    }
  }
  pushRecord(segments, id, chars, offs, 'genbank-origin', originIdx);
  return segments;
}

/**
 * Extract DNA-looking tokens from generic text (TS/Python/YAML/config).
 * Runs of ≥minLen ACGTN letters with at least 2 distinct bases
 * (kills English words; long "TATA" repeats are kept when genuinely long).
 */
export function extractInline(text: string, fallbackId = 'inline', minLen = 15): DnaSegment[] {
  const segments: DnaSegment[] = [];
  const re = new RegExp(`[ACGTUacgtuNn]{${minLen},}`, 'g');
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    const upper = token.toUpperCase();
    const distinct = new Set(upper).size;
    if (distinct < 2) { continue; }
    // Reject camelCase English bleed: require no lowercase run context beyond token (regex handles).
    n++;
    const chars = token.split('').map(cleanBase);
    const offs = chars.map((_, k) => (m as RegExpExecArray).index + k);
    pushRecord(segments, `${fallbackId}-inline-${n}`, chars, offs, 'inline', m.index);
  }
  return segments;
}

/** Dispatch on filename. Always returns ≥0 segments; empty file → []. */
export function extractSegments(fileName: string, text: string, minInlineLen = 15): DnaSegment[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.fa') || lower.endsWith('.fasta') || lower.endsWith('.fna') ||
      lower.endsWith('.ffn') || lower.endsWith('.faa') || lower.endsWith('.frn')) {
    return parseFasta(text);
  }
  if (lower.endsWith('.fastq') || lower.endsWith('.fq')) {
    return parseFastq(text);
  }
  if (lower.endsWith('.gb') || lower.endsWith('.gbk') ||
      lower.endsWith('.genbank') || lower.endsWith('.gbf')) {
    return parseGenBank(text);
  }
  // .yaml/.yml/.py/.ts and anything else: inline DNA mining.
  return extractInline(text, baseName(fileName), minInlineLen);
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return (parts[parts.length - 1] || 'inline').replace(/\.[^.]+$/, '');
}

export function reverseComplement(seq: string): string {
  const comp: Record<string, string> = { A: 'T', T: 'A', U: 'A', G: 'C', C: 'G', N: 'N', '-': '-', '.': '.' };
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) {
    const b = seq[i].toUpperCase();
    out += comp[b] ?? 'N';
  }
  return out;
}

export interface PureSeq {
  /** Sequence stripped to [ACGTN] only, uppercase, U→T. Indexable for analysis. */
  pure: string;
  /** pure[i] came from raw[map[i]] — use to project analysis coords back to document. */
  map: number[];
}

/**
 * Strip a raw segment to analyzable bases.
 * Invalid letters (X, B, …), gaps and digits are dropped; U is normalized to T
 * and N is kept (ambiguity is itself a lint signal). `map` keeps every pure
 * index traceable to its raw/document offset — never index seqToDoc with pure
 * coordinates directly.
 */
export function stripToPure(raw: string): PureSeq {
  let pure = '';
  const map: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i].toUpperCase();
    if (c === 'A' || c === 'C' || c === 'G' || c === 'T' || c === 'N') {
      pure += c;
      map.push(i);
    } else if (c === 'U') {
      pure += 'T';
      map.push(i);
    }
  }
  return { pure, map };
}

export function normalizeSeq(seq: string): string {
  return seq.toUpperCase().replace(/U/g, 'T');
}
