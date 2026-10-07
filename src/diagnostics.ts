/**
 * diagnostics.ts — async non-blocking linter.
 * Red (Error): invalid bases, BioGuard REJECTED / FLAGGED_FOR_REVIEW.
 * Orange (Warning): GC out of range, hairpin / self-dimer risk, broken ORFs.
 * Blue (Information): primer/PCR optimization suggestions.
 *
 * Coordinate discipline: analysis runs on `pure` (stripped) coordinates and is
 * projected back to document offsets via `stripToPure().map` — never index
 * `seqToDoc` with pure coordinates directly (audit fix #2).
 */
import * as vscode from 'vscode';
import {
  extractSegments, findInvalidChars, stripToPure, reverseComplement, DnaSegment,
  gcContent, analyzePrimer, detectBrokenORFs, findORFs,
  loadLocalThreatDb, screenSequence, screenEnterprise,
  cai, findRareCodons, HOST_TABLES, loadCodonTable,
  parseGenBankAnnotations, validateGenBank,
} from './bio';
import { getConfig, tmOptionsOf } from './config';
import { getToken } from './enterprise';
import { AuditLog } from './auditLog';
import { sha256HexSync } from './enterprise';

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

/** Cap windowed GC warnings per document; beyond that a summary is emitted. */
const MAX_GC_WINDOW_DIAGS = 40;
/** Hard per-document diagnostic ceiling (VS Code itself caps at ~1000/file). */
const MAX_DIAGS = 500;

export class BioLinter {
  private collection: vscode.DiagnosticCollection;
  private timers = new Map<string, NodeJS.Timeout>();
  private runIds = new Map<string, number>();
  private pendingEnterprise = new Map<string, number>();

  constructor(
    private ctx: vscode.ExtensionContext,
    private output: vscode.OutputChannel,
    private audit: AuditLog,
    private onDone?: (doc: vscode.TextDocument) => void,
  ) {
    this.collection = vscode.languages.createDiagnosticCollection('biolint');
    ctx.subscriptions.push(this.collection);
  }

  schedule(doc: vscode.TextDocument): void {
    if (!this.shouldLint(doc)) { return; }
    const key = doc.uri.toString();
    if (this.timers.has(key)) { clearTimeout(this.timers.get(key)!); }
    const ms = getConfig().debounceMs;
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.lint(doc);
    }, ms));
  }

  clear(doc: vscode.TextDocument): void {
    this.collection.delete(doc.uri);
  }

  shouldLint(doc: vscode.TextDocument): boolean {
    if (doc.isUntitled) {
      // Audit fix: don't lint arbitrary scratch notes — only bio language tabs
      // or untitled content that actually contains DNA-looking runs.
      if (['biofasta', 'biogenbank', 'biofastq'].includes(doc.languageId)) { return true; }
      const minLen = Math.max(5, getConfig().minPrimerLength);
      return new RegExp(`[ACGTNacgtn]{${minLen},}`).test(doc.getText().slice(0, 50000));
    }
    const name = doc.fileName.toLowerCase();
    if (/\.(fa|fasta|fna|ffn|faa|frn|gb|gbk|genbank|gbf|fastq|fq)$/.test(name)) { return true; }
    if (/\.(yaml|yml|json|py|ts|tsx|js|jsx|md|txt|csv|xml)$/.test(name)) { return true; }
    if (['biofasta', 'biogenbank', 'biofastq'].includes(doc.languageId)) { return true; }
    return false;
  }

  async lint(doc: vscode.TextDocument): Promise<void> {
    const started = Date.now();
    const key = doc.uri.toString();
    const runId = (this.runIds.get(key) ?? 0) + 1;
    this.runIds.set(key, runId);
    const alive = (): boolean => this.runIds.get(key) === runId;

    const cfg = getConfig();
    const text = doc.getText();
    if (text.length > 2_000_000) {
      // Audit fix: don't leave stale diagnostics on skipped files.
      this.collection.set(doc.uri, []);
      return;
    }
    const segments = extractSegments(doc.fileName, text, cfg.minPrimerLength);
    const diags: vscode.Diagnostic[] = [];

    const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    const db = cfg.enableLocalThreatDb ? loadLocalThreatDb(roots) : { entries: [], version: 'disabled' };
    // Yield point — a newer keystroke may have scheduled a fresher run.
    const token = cfg.mode === 'enterprise' ? await getToken(this.ctx) : undefined;
    if (!alive()) { return; } // audit fix: drop stale run

    let gcWindows = 0;
    let gcWindowsSkipped = 0;
    for (const seg of segments) {
      this.lintInvalidBases(doc, seg, diags);
      const { gcWindows: w, skipped: s } = this.lintThermo(doc, seg, diags, cfg, gcWindows);
      gcWindows += w; gcWindowsSkipped += s;
      this.lintOrfs(doc, seg, diags, cfg);
      this.lintCodons(doc, seg, diags, cfg);
      if (db.entries.length > 0) {
        const { pure, map } = stripToPure(seg.raw);
        if (pure.length >= 8) {
          const res = screenSequence(pure, db.entries, db.version, 'local');
          this.pushBioguard(doc, seg, res.matches, diags, map);
          if (cfg.mode === 'enterprise' && token) {
            void this.enterpriseRescreen(doc, seg, db.version, token);
          }
        }
      }
      if (diags.length > MAX_DIAGS) { break; }
    }
    this.lintGenBankAnnotations(doc, text, diags);
    if (gcWindowsSkipped > 0 && segments.length > 0) {
      const first = segments[0];
      diags.push(this.info(
        doc, first, 0, Math.min(12, first.seqToDoc.length),
        `BioLint: …and ${gcWindowsSkipped} more GC-anomalous windows capped from Problems — open the Sequence Visualizer for the full GC profile.`,
        CODE.gc,
      ));
    }
    if (!alive()) { return; }
    const finalDiags = diags.slice(0, MAX_DIAGS);
    this.collection.set(doc.uri, finalDiags);
    // v1.2.0: output timings + local audit trail (never blocks linting).
    try {
      const ms = Date.now() - started;
      let errors = 0, warnings = 0, rejected = 0, flagged = 0;
      for (const d of finalDiags) {
        if (d.severity === vscode.DiagnosticSeverity.Error) { errors++; }
        else if (d.severity === vscode.DiagnosticSeverity.Warning) { warnings++; }
        const code = typeof d.code === 'string' ? d.code : (d.code as { value?: string } | undefined)?.value ?? '';
        if (code === CODE.rejected) { rejected++; }
        else if (code === CODE.flagged) { flagged++; }
      }
      const verdict = rejected > 0 ? 'REJECTED' : flagged > 0 ? 'FLAGGED_FOR_REVIEW' : 'APPROVED';
      if (cfg.debug || verdict !== 'APPROVED') {
        this.output.appendLine(`[biolint] ${shortName(doc.fileName)} — ${finalDiags.length} diag (${errors}E/${warnings}W) verdict=${verdict} db=${db.version} ${ms}ms`);
      }
      void this.audit.append({
        ts: new Date().toISOString(),
        file: shortName(doc.fileName),
        sha256: sha256HexSync(text).slice(0, 16),
        mode: cfg.mode,
        dbVersion: db.version,
        records: segments.length,
        verdict, rejected, flagged, errors, warnings,
      });
    } catch { /* observability must never break linting */ }
    try { this.onDone?.(doc); } catch { /* ignore */ }
  }

  private async enterpriseRescreen(doc: vscode.TextDocument, seg: DnaSegment, localVersion: string, token: string): Promise<void> {
    const stamp = Date.now();
    this.pendingEnterprise.set(doc.uri.toString(), stamp);
    const cfg = getConfig();
    const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    const db = loadLocalThreatDb(roots);
    const { pure, map } = stripToPure(seg.raw);
    const fallback = screenSequence(pure, db.entries, localVersion, 'local');
    // Screen the same stripped coordinates the server positions refer to.
    const res = await screenEnterprise(pure, { baseUrl: cfg.enterpriseUrl, token }, fallback);
    // Drop stale results if user kept typing.
    if (this.pendingEnterprise.get(doc.uri.toString()) !== stamp) { return; }
    if (res.mode === 'enterprise' && res.verdict !== fallback.verdict) {
      const isBioguard = (d: vscode.Diagnostic): boolean => {
        const c = typeof d.code === 'string' ? d.code : (d.code as { value?: string } | undefined)?.value ?? '';
        return c.startsWith('biolint.bioguard');
      };
      const current = (this.collection.get(doc.uri) ?? []).filter(d => !isBioguard(d));
      this.pushBioguard(doc, seg, res.matches, current, map);
      this.collection.set(doc.uri, current);
    }
  }

  /** Raw-coordinate range (indices into seg.seqToDoc). */
  private rangeForRaw(doc: vscode.TextDocument, seg: DnaSegment, rawStart: number, rawEnd: number): vscode.Range {
    if (seg.seqToDoc.length === 0) {
      return new vscode.Range(0, 0, 0, 1);
    }
    const s = Math.max(0, Math.min(rawStart, seg.seqToDoc.length - 1));
    const e = Math.max(s + 1, Math.min(rawEnd, seg.seqToDoc.length));
    const startOff = seg.seqToDoc[s];
    const endOff = (e - 1 < seg.seqToDoc.length ? seg.seqToDoc[e - 1] + 1 : startOff + 1);
    return new vscode.Range(doc.positionAt(startOff), doc.positionAt(endOff));
  }

  /** Pure-coordinate range projected through the strip map (audit fix #2). */
  private rangeForPure(doc: vscode.TextDocument, seg: DnaSegment, map: number[], pureStart: number, pureEnd: number): vscode.Range {
    if (map.length === 0) { return this.rangeForRaw(doc, seg, 0, 1); }
    const rawStart = map[Math.max(0, Math.min(pureStart, map.length - 1))] ?? 0;
    const rawLast = map[Math.max(0, Math.min(pureEnd - 1, map.length - 1))] ?? rawStart;
    return this.rangeForRaw(doc, seg, rawStart, rawLast + 1);
  }

  private err(doc: vscode.TextDocument, seg: DnaSegment, rs: number, re: number, msg: string, code: string): vscode.Diagnostic {
    const d = new vscode.Diagnostic(this.rangeForRaw(doc, seg, rs, re), msg, vscode.DiagnosticSeverity.Error);
    d.code = code; d.source = 'biolint';
    return d;
  }

  private warn(doc: vscode.TextDocument, seg: DnaSegment, rs: number, re: number, msg: string, code: string): vscode.Diagnostic {
    const d = new vscode.Diagnostic(this.rangeForRaw(doc, seg, rs, re), msg, vscode.DiagnosticSeverity.Warning);
    d.code = code; d.source = 'biolint';
    return d;
  }

  private info(doc: vscode.TextDocument, seg: DnaSegment, rs: number, re: number, msg: string, code: string): vscode.Diagnostic {
    const d = new vscode.Diagnostic(this.rangeForRaw(doc, seg, rs, re), msg, vscode.DiagnosticSeverity.Information);
    d.code = code; d.source = 'biolint';
    return d;
  }

  private lintInvalidBases(doc: vscode.TextDocument, seg: DnaSegment, out: vscode.Diagnostic[]): void {
    for (const inv of findInvalidChars(seg)) {
      // inv.docOffset is an exact document offset (parsers guarantee it post-audit).
      const pos = doc.positionAt(inv.docOffset);
      const d = new vscode.Diagnostic(
        new vscode.Range(pos, doc.positionAt(inv.docOffset + 1)),
        `BioLint: invalid base '${inv.char}' in ${seg.id} — synthesis requires A/C/G/T (N for ambiguous).`,
        vscode.DiagnosticSeverity.Error,
      );
      d.code = CODE.invalidBase;
      d.source = 'biolint';
      out.push(d);
      if (out.length > MAX_DIAGS) { return; }
    }
  }

  private lintThermo(
    doc: vscode.TextDocument, seg: DnaSegment,
    out: vscode.Diagnostic[], cfg: ReturnType<typeof getConfig>,
    gcWindowsSoFar: number,
  ): { gcWindows: number; skipped: number } {
    let gcWindows = 0;
    let skipped = 0;
    const push = (d: vscode.Diagnostic): void => { out.push(d); };
    const { pure, map } = stripToPure(seg.raw);
    if (pure.length < cfg.minPrimerLength) { return { gcWindows, skipped }; }
    const pureRange = (ps: number, pe: number): vscode.Range => this.rangeForPure(doc, seg, map, ps, pe);
    const tmOpts = tmOptionsOf(cfg);

    const emitGcWindow = (ps: number, pe: number, gcPct: number, win: number): void => {
      if (gcWindowsSoFar + gcWindows >= MAX_GC_WINDOW_DIAGS) { skipped++; return; }
      gcWindows++;
      const d = new vscode.Diagnostic(
        pureRange(ps, pe),
        `BioLint: GC ${gcPct.toFixed(1)}% over ${win} nt (healthy ${cfg.gcWarnLow}–${cfg.gcWarnHigh}%) — PCR/structure risk.`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.code = CODE.gc; d.source = 'biolint';
      push(d);
    };

    // Long contigs: windowed GC scan so local anomalies are located precisely.
    if (pure.length > 600) {
      const win = 200;
      for (let i = 0; i + win <= pure.length; i += win) {
        const slice = pure.slice(i, i + win);
        const gc = gcContent(slice);
        if (gc.gcPct < cfg.gcWarnLow || gc.gcPct > cfg.gcWarnHigh) {
          emitGcWindow(i, i + win, gc.gcPct, win);
        }
        if (out.length > MAX_DIAGS) { return { gcWindows, skipped }; }
      }
      return { gcWindows, skipped };
    }
    const a = analyzePrimer(pure, cfg.gcWarnLow, cfg.gcWarnHigh, tmOpts);
    if (a.gcFlag !== 'normal') {
      const d = new vscode.Diagnostic(
        pureRange(0, pure.length),
        `BioLint: GC ${a.gcPct}% (${a.gcFlag === 'low' ? 'AT-rich' : 'GC-rich'}) — ${a.suggestions[0] ?? ''}`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.code = CODE.gc; d.source = 'biolint';
      push(d);
    }
    if (a.hairpinDG <= -5) {
      // v1.1.0: highlight the stem itself, not the whole primer.
      const stem = a.hairpinStem;
      const d = new vscode.Diagnostic(
        stem ? pureRange(stem.start, stem.start + stem.length) : pureRange(0, pure.length),
        `BioLint: hairpin ΔG ${a.hairpinDG} kcal/mol (stem ${stem ? `${stem.length} nt, loop ${stem.loop}` : 'detected'}) — unstable secondary structure (see hover for details).`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.code = CODE.hairpin; d.source = 'biolint';
      push(d);
    }
    if (a.selfDimerDG <= -6) {
      const d = new vscode.Diagnostic(
        pureRange(0, pure.length),
        `BioLint: self-dimer ΔG ${a.selfDimerDG} kcal/mol — primer-dimer risk in PCR.`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.code = CODE.dimer; d.source = 'biolint';
      push(d);
    }
    // Blue optimization hints (only when sequence is otherwise sane).
    const actionable = a.suggestions.filter(s => /clamp|Homopolymer|ambiguous|shorter|longer/i.test(s));
    for (const s of actionable.slice(0, 2)) {
      const d = new vscode.Diagnostic(
        pureRange(Math.max(0, pure.length - 8), pure.length),
        `BioLint suggestion: ${s}`,
        vscode.DiagnosticSeverity.Information,
      );
      d.code = CODE.suggestion; d.source = 'biolint';
      push(d);
    }
    return { gcWindows, skipped };
  }

  private lintOrfs(
    doc: vscode.TextDocument, seg: DnaSegment,
    out: vscode.Diagnostic[], cfg: ReturnType<typeof getConfig>,
  ): void {
    const { pure, map } = stripToPure(seg.raw);
    if (pure.length < 60) { return; }
    for (const b of detectBrokenORFs(pure, cfg.minOrfLength)) {
      const ps = Math.min(b.start, Math.max(0, map.length - 1));
      const pe = Math.min(Math.max(b.end, ps + 1), map.length);
      const range = b.kind === 'no-orf'
        ? this.rangeForRaw(doc, seg, 0, Math.min(12, seg.seqToDoc.length))
        : this.rangeForPure(doc, seg, map, ps, pe);
      // 'no-orf' spans whole contig — anchored at record start to avoid red walls.
      const d = new vscode.Diagnostic(
        range,
        `BioLint: broken ORF — ${b.message}`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.code = CODE.brokenOrf;
      d.source = 'biolint';
      out.push(d);
      if (out.length > MAX_DIAGS) { return; }
    }
  }

  /** v1.1.0: codon optimality — CAI + rare codons on complete ORFs (blue hints). */
  private lintCodons(
    doc: vscode.TextDocument, seg: DnaSegment,
    out: vscode.Diagnostic[], cfg: ReturnType<typeof getConfig>,
  ): void {
    const { pure, map } = stripToPure(seg.raw);
    if (pure.length < 60) { return; }
    const table = loadCodonTable(cfg.codonHost, vscode.workspace.getConfiguration('biolint').get<string>('codon.customTablePath', ''));
    let emitted = 0;
    for (const o of findORFs(pure, cfg.minOrfLength)) {
      if (!o.complete || emitted >= 5) { break; }
      const slice = pure.slice(o.start, o.end);
      const coding = o.strand === 1 ? slice : reverseComplement(slice);
      const value = cai(coding, table);
      if (value < cfg.codonCaiWarnBelow) {
        const rare = findRareCodons(coding, table).length;
        const d = new vscode.Diagnostic(
          this.rangeForPure(doc, seg, map, o.start, Math.min(o.end, o.start + 30)),
          `BioLint suggestion: ORF CAI ${value.toFixed(2)} for ${table.name} (${rare} rare codons) — run “BioLint: Optimize Codons for Host”.`,
          vscode.DiagnosticSeverity.Information,
        );
        d.code = CODE.codon;
        d.source = 'biolint';
        out.push(d);
        emitted++;
      }
      if (out.length > MAX_DIAGS) { return; }
    }
  }

  /** v1.1.0: GenBank annotation validation (LOCUS / CDS / translation). */
  private lintGenBankAnnotations(doc: vscode.TextDocument, text: string, out: vscode.Diagnostic[]): void {
    const name = doc.fileName.toLowerCase();
    const isGb = doc.languageId === 'biogenbank' ||
      name.endsWith('.gb') || name.endsWith('.gbk') || name.endsWith('.genbank') || name.endsWith('.gbf');
    if (!isGb) { return; }
    const ann = parseGenBankAnnotations(text);
    if (!ann.hasOrigin) { return; }
    // Concatenated ORIGIN letters in order = first genbank-origin segment's raw.
    const segments = extractSegments(doc.fileName, text, 1);
    const origin = segments.find(s => s.kind === 'genbank-origin');
    if (!origin) { return; }
    for (const issue of validateGenBank(origin.raw, ann)) {
      let range: vscode.Range;
      if (issue.seqPos >= 1 && issue.seqPos - 1 < origin.raw.length) {
        const rs = issue.seqPos - 1;
        range = this.rangeForRaw(doc, origin, rs, Math.min(origin.raw.length, rs + Math.max(1, issue.seqLen)));
      } else {
        // Anchor at the feature/LOCUS line.
        try {
          const line = doc.lineAt(doc.positionAt(Math.min(issue.lineOffset, text.length)).line);
          range = line.range;
        } catch {
          range = new vscode.Range(0, 0, 0, 1);
        }
      }
      const sev = issue.kind === 'cds-bounds'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
      const d = new vscode.Diagnostic(
        range,
        `BioLint: GenBank annotation — ${issue.message}`,
        sev,
      );
      d.code = CODE.gbAnnotation;
      d.source = 'biolint';
      out.push(d);
      if (out.length > MAX_DIAGS) { return; }
    }
  }

  private pushBioguard(
    doc: vscode.TextDocument, seg: DnaSegment,
    matches: import('./bio').ThreatMatch[], out: vscode.Diagnostic[],
    pureMap: number[],
  ): void {
    for (const m of matches.slice(0, 20)) {
      // Matches are pure coordinates (screened on stripped seq) → project via map.
      const range = this.rangeForPure(doc, seg, pureMap, m.position, m.position + m.matchedKmer.length);
      const critical = m.entry.severity === 'REJECTED';
      const d = new vscode.Diagnostic(
        range,
        critical
          ? `BioLint CRITICAL: '${m.entry.name}' matches restricted agent pattern [${m.entry.regulation}] — synthesis blocked (IIGS/CDC). See BioGuard Command Center.`
          : `BioLint: '${m.entry.name}' flagged for review [${m.entry.regulation}] — confirm compliance before synthesis.`,
        vscode.DiagnosticSeverity.Error,
      );
      d.code = critical ? CODE.rejected : CODE.flagged;
      d.source = 'biolint';
      out.push(d);
    }
  }
}

function shortName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
