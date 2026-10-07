/** Minimal zero-dependency unit tests for the bio engine (run via `npm run test:unit`). */
import * as assert from 'assert';
import { parseFasta, parseFastq, parseGenBank, extractInline, reverseComplement, stripToPure } from '../sequence';
import { gcContent, classifyGC } from '../gc';
import { santaLuciaTm, wallaceTm } from '../tm';
import { hairpinDeltaG, selfDimerDeltaG } from '../deltaG';
import { findORFs, detectBrokenORFs, translate } from '../orf';
import { findRestrictionSites } from '../restriction';
import { analyzePrimer, optimizePrimer } from '../primer';
import { screenSequence, DEMO_THREAT_DB } from '../bioguard';

let passed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}:`, (e as Error).message); process.exitCode = 1; }
}

check('parseFasta + offset map', () => {
  const segs = parseFasta('>seq1\nATGC\nGGCC\n');
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].raw, 'ATGCGGCC');
  assert.strictEqual(segs[0].seqToDoc.length, 8);
});

check('parseFastq', () => {
  const segs = parseFastq('@r1\nACGT\n+\nIIII\n');
  assert.strictEqual(segs[0].raw, 'ACGT');
});

check('parseGenBank ORIGIN', () => {
  const gb = 'LOCUS X 100 bp\nORIGIN\n 1 atgc atgc\n//\n';
  const segs = parseGenBank(gb);
  assert.ok(segs[0].raw.replace(/\s/g, '').includes('ATGC'));
});

check('extractInline finds DNA in code', () => {
  const segs = extractInline('const primer = "ATGCGATCGATCGATCGATCG";', 't', 15);
  assert.ok(segs.length >= 1);
});

check('reverseComplement', () => {
  assert.strictEqual(reverseComplement('ATGC'), 'GCAT');
});

check('gcContent', () => {
  const g = gcContent('GGCCAA');
  assert.ok(Math.abs(g.gcPct - 66.666) < 0.1);
  assert.strictEqual(classifyGC(20), 'low');
  assert.strictEqual(classifyGC(50), 'normal');
  assert.strictEqual(classifyGC(80), 'high');
});

check('wallace + santalucia', () => {
  assert.strictEqual(wallaceTm('ATGC'), 12);
  const t = santaLuciaTm('ATGCGATCGATCGATCGATC');
  assert.ok(t.tmUsed > 30 && t.tmUsed < 90, `tm ${t.tmUsed}`);
});

check('hairpin + selfdimer run', () => {
  const h = hairpinDeltaG('GCGCATATATGCGC');
  assert.ok(typeof h.deltaG === 'number');
  const d = selfDimerDeltaG('ATATATATATATATAT');
  assert.ok(typeof d.deltaG === 'number');
});

check('ORF find + translate', () => {
  assert.strictEqual(translate('ATGGCTTAA'), 'MA*');
  const orfs = findORFs(`ATG${'GCT'.repeat(40)}TAA`, 30);
  assert.ok(orfs.some(o => o.complete), 'expected complete ORF');
});

check('broken ORF: orphan stop', () => {
  const issues = detectBrokenORFs(`GGG${'AAA'.repeat(80)}TAAGGG${'CCC'.repeat(80)}`, 90);
  assert.ok(issues.length >= 1, 'expected ≥1 broken-ORF issue');
});

check('restriction sites', () => {
  const hits = findRestrictionSites('AAAGAATTCAAA');
  assert.ok(hits.some(h => h.enzyme === 'EcoRI'));
});

check('analyzePrimer flags GC + clamp', () => {
  const a = analyzePrimer('ATATATATATATATATATAT');
  assert.ok(a.suggestions.length > 0);
  assert.ok(a.score < 100);
});

check('optimizePrimer breaks homopolymer', () => {
  const r = optimizePrimer('AAAAAAAAGGGGGGCCCCCCATAT');
  assert.ok(r.optimized.length > 0 && r.changes.length > 0);
});

check('bioguard demo screen', () => {
  const res = screenSequence(`AAA${DEMO_THREAT_DB[0].pattern}AAA`, DEMO_THREAT_DB, 'demo', 'local');
  assert.strictEqual(res.verdict, 'FLAGGED_FOR_REVIEW');
  const res2 = screenSequence(`AAA${DEMO_THREAT_DB[1].pattern}AAA`, DEMO_THREAT_DB, 'demo', 'local');
  assert.strictEqual(res2.verdict, 'REJECTED');
  const ok = screenSequence('ATGCGATCGATCGATCGATCGATCGATCGA', DEMO_THREAT_DB, 'demo', 'local');
  assert.strictEqual(ok.verdict, 'APPROVED');
});

check('AUDIT: CRLF fasta offsets are exact', () => {
  const text = '>s1\r\nATGC\r\nGGCC\r\n>s2\r\nTTAA\r\n';
  const segs = parseFasta(text);
  assert.strictEqual(segs.length, 2);
  for (const s of segs) {
    for (let i = 0; i < s.raw.length; i++) {
      assert.strictEqual(text[s.seqToDoc[i]], s.raw[i], `drift at ${s.id}[${i}]`);
    }
  }
  assert.strictEqual(text.slice(segs[1].recordOffset, segs[1].recordOffset + 3), '>s2');
});

check('AUDIT: CRLF fastq offsets are exact', () => {
  const text = '@r1\r\nACGT\r\n+\r\nIIII\r\n';
  const segs = parseFastq(text);
  assert.strictEqual(segs[0].raw, 'ACGT');
  for (let i = 0; i < segs[0].raw.length; i++) {
    assert.strictEqual(text[segs[0].seqToDoc[i]], segs[0].raw[i]);
  }
});

check('AUDIT: genbank + inline offsets are exact', () => {
  const gb = 'LOCUS X 100 bp\nORIGIN\n 1 atgc atgc\n//\n';
  for (const s of parseGenBank(gb)) {
    for (let i = 0; i < s.raw.length; i++) {
      assert.strictEqual(gb[s.seqToDoc[i]].toUpperCase(), s.raw[i]);
    }
  }
  const code = 'x = "ATGCGATCGATCGATCGATCGATCG";';
  for (const s of extractInline(code, 't', 15)) {
    for (let i = 0; i < s.raw.length; i++) {
      assert.strictEqual(code[s.seqToDoc[i]].toUpperCase(), s.raw[i]);
    }
  }
});

check('AUDIT: stripToPure mapping (N/U/gaps/invalid)', () => {
  const { pure, map } = stripToPure('ATGNXATGCU--ATGC');
  assert.strictEqual(pure, 'ATGNATGCTATGC');
  const raw = 'ATGNXATGCU--ATGC';
  for (let i = 0; i < pure.length; i++) {
    const rc = raw[map[i]].toUpperCase();
    assert.strictEqual(rc === 'U' ? 'T' : rc, pure[i], `map drift at pure[${i}]`);
  }
  assert.ok(!pure.includes('X') && !pure.includes('-'));
});

console.log(`\n${passed} tests passed.`);
