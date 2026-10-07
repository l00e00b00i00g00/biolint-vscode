/** Minimal zero-dependency unit tests for the bio engine (run via `npm run test:unit`). */
import * as assert from 'assert';
import { parseFasta, parseFastq, parseGenBank, extractInline, reverseComplement, stripToPure } from '../sequence';
import { heteroDimerDeltaG } from '../deltaG';
import { analyzePair } from '../primer';
import { cai, findRareCodons, optimizeCodons, HOST_TABLES } from '../codon';
import { parseGenBankAnnotations, validateGenBank, spliceFeature } from '../genbank';
import { alignConstructs } from '../align';
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

check('v1.1.0: CAI + rare codons + optimizer', () => {
  const ecoli = HOST_TABLES.ecoli;
  assert.strictEqual(cai('ATGATGATG', ecoli), 1, 'poly-Met CAI must be 1');
  const rare = findRareCodons('ATGAGAAGGCTAATA' + 'GCT'.repeat(6), ecoli);
  assert.ok(rare.some(r => r.codon === 'AGA'), 'AGA should be rare in E. coli');
  assert.ok(rare.some(r => r.codon === 'CTA'), 'CTA should be rare in E. coli');
  const coding = 'ATG' + 'AGAAGGCTAATA' + 'GCT'.repeat(20) + 'TAA';
  const res = optimizeCodons(coding, ecoli);
  assert.ok(res.caiAfter >= res.caiBefore, 'optimizer must not regress CAI');
  assert.ok(res.changes > 0, 'optimizer should change rare codons');
  assert.ok(res.optimized.startsWith('ATG') && res.optimized.endsWith('TAA'), 'start/stop preserved');
  assert.strictEqual(res.optimized.length, coding.length, 'length preserved');
});

check('v1.1.0: heterodimer + pair QC', () => {
  // Perfect cross-complementary 20-mers → strong heterodimer.
  const fwd = 'ATGCGATCGATCGATCGATC';
  const rev = reverseComplement(fwd);
  const hd = heteroDimerDeltaG(fwd, rev);
  assert.ok(hd.found && hd.deltaG < -9, `expected strong heterodimer, got ${hd.deltaG}`);
  const okPair = analyzePair('ATGCGATCGATCGATCGATCGA', 'TCGATCGATCGATCGATCGCAT');
  assert.ok(typeof okPair.ok === 'boolean' && okPair.report.includes('ΔTm'));
  const badPair = analyzePair('ATATATATATATATAT', 'GCGCGCGCGCGCGCGCGCGCGCGC');
  assert.strictEqual(badPair.ok, false, 'AT vs GC pair must fail ΔTm');
  assert.ok(badPair.deltaTm > 5, `deltaTm ${badPair.deltaTm}`);
});

const GB30 = 'ATGGCTGCTGCTGCTGCTGCTGCTGCTTAA'; // 30 nt, M + 8×A, TAA stop
function gbText(locusLen: number, loc: string, translation: string, origin: string): string {
  return `LOCUS       TEST30                 ${locusLen} bp    DNA     synthetic\n` +
    `FEATURES             Location/Qualifiers\n` +
    `     CDS             ${loc}\n` +
    `                     /translation="${translation}"\n` +
    `ORIGIN\n        1 ${origin.slice(0, 20).toLowerCase()} ${origin.slice(20).toLowerCase()}\n//\n`;
}

check('v1.1.0: genbank valid annotations', () => {
  const text = gbText(30, '1..30', 'MAAAAAAAA', GB30);
  const ann = parseGenBankAnnotations(text);
  assert.strictEqual(ann.locusLength, 30);
  assert.strictEqual(ann.features.length, 1);
  const issues = validateGenBank(GB30, ann);
  assert.deepStrictEqual(issues, [], `expected no issues, got ${JSON.stringify(issues)}`);
});

check('v1.1.0: genbank catches bad annotations', () => {
  const kinds = (t: string): string[] => validateGenBank(GB30, parseGenBankAnnotations(t)).map(i => i.kind);
  assert.ok(kinds(gbText(31, '1..30', 'MAAAAAAAA', GB30)).includes('locus-length'), 'locus mismatch');
  assert.ok(kinds(gbText(30, '1..99', 'MAAAAAAAA', GB30)).includes('cds-bounds'), 'oob exon');
  assert.ok(kinds(gbText(30, '1..30', 'MFFFFFFF', GB30)).includes('cds-translation'), 'translation mismatch');
  const badStart = 'TTG' + GB30.slice(3);
  assert.ok(validateGenBank(badStart, parseGenBankAnnotations(gbText(30, '1..30', 'MAAAAAAAA', badStart))).some(i => i.kind === 'cds-start'), 'bad start');
  const noStop = GB30.slice(0, 27) + 'TTT';
  assert.ok(validateGenBank(noStop, parseGenBankAnnotations(gbText(30, '1..30', 'MAAAAAAAA', noStop))).some(i => i.kind === 'cds-stop'), 'missing stop');
});

check('v1.1.0: genbank complement strand', () => {
  const fwd = reverseComplement(GB30);
  const text = gbText(30, 'complement(1..30)', 'MAAAAAAAA', fwd);
  const ann = parseGenBankAnnotations(text);
  assert.strictEqual(ann.features[0].strand, -1);
  assert.strictEqual(spliceFeature(fwd, ann.features[0]), GB30);
  assert.deepStrictEqual(validateGenBank(fwd, ann), [], 'complement CDS should validate');
});

check('AUDIT: genbank join() multi-exon', () => {
  // exons 1..9 (ATG GCT GCT) + 22..30 (GCT GCT TAA) → ATG×(GCT×4)×TAA = MAAAA
  const text = gbText(30, 'join(1..9,22..30)', 'MAAAA', GB30);
  const ann = parseGenBankAnnotations(text);
  assert.strictEqual(ann.features[0].exons.length, 2);
  assert.strictEqual(spliceFeature(GB30, ann.features[0]), 'ATGGCTGCTGCTGCTTAA');
  assert.deepStrictEqual(validateGenBank(GB30, ann), [], `join should validate, got ${JSON.stringify(validateGenBank(GB30, ann))}`);
  // minus-strand join: transcript 5' end = highest coord of first exon
  const ctext = gbText(30, 'complement(join(1..9,22..30))', 'MAAAA', reverseComplement(GB30));
  const cann = parseGenBankAnnotations(ctext);
  assert.strictEqual(cann.features[0].strand, -1);
  assert.strictEqual(spliceFeature(reverseComplement(GB30), cann.features[0]), 'ATGGCTGCTGCTGCTTAA');
  const cissues = validateGenBank(reverseComplement(GB30), cann);
  assert.deepStrictEqual(cissues, [], `complement join should validate: ${JSON.stringify(cissues)}`);
});

check('v1.2.0: construct alignment', () => {
  const same = alignConstructs('ATGCGATCGA', 'ATGCGATCGA');
  assert.strictEqual(same.variants.length, 0);
  assert.strictEqual(same.identity, 1);
  const snp = alignConstructs('ATGCGATCGA', 'ATGCGTTCGA');
  assert.strictEqual(snp.variants.length, 1);
  assert.strictEqual(snp.variants[0].kind, 'snp');
  assert.strictEqual(snp.variants[0].from, 'A');
  assert.strictEqual(snp.variants[0].to, 'T');
  assert.strictEqual(snp.variants[0].posA, 5);
  const indel = alignConstructs('ATGCGATCGA', 'ATGCGAAATCGA');
  assert.ok(indel.variants.some(v => v.kind === 'insertion' && v.to === 'AA'), `got ${JSON.stringify(indel.variants)}`);
  const del = alignConstructs('ATGCGAAATCGA', 'ATGCGATCGA');
  assert.ok(del.variants.some(v => v.kind === 'deletion' && v.from === 'AA'), `got ${JSON.stringify(del.variants)}`);
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
