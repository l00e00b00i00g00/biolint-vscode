/**
 * diagnostics.ts — thin VS Code wrapper over analyze.ts (v2.0).
 * Small files: synchronous analyzeDocumentText on the extension host.
 * Large files (>WORKER_THRESHOLD): offloaded to a worker_thread so typing
 * stays responsive; timeout/errors fall back to synchronous analysis.
 * Enterprise re-screening stays on the main thread (needs SecretStorage).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Worker } from 'worker_threads';
import {
  analyzeDocumentText, AnalyzeOpts, AnalyzeResult, Finding,
  CODE, WORKER_THRESHOLD, HARD_CEILING,
} from './analyze';
import {
  extractSegments, stripToPure,
  loadLocalThreatDb, screenSequence, screenEnterprise,
} from './bio';
import { getConfig } from './config';
import { getToken, sha256HexSync } from './enterprise';
import { AuditLog } from './auditLog';

export { CODE };

const MAX_DIAGS = 500;
const WORKER_TIMEOUT_MS = 20000;

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

  buildOpts(): { opts: AnalyzeOpts; dbVersion: string } {
    const cfg = getConfig();
    const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    const db = cfg.enableLocalThreatDb ? loadLocalThreatDb(roots) : { entries: [], version: 'disabled' };
    return {
      dbVersion: db.version,
      opts: {
        fileLanguageId: undefined, // set per-document in lint()
        minPrimerLength: cfg.minPrimerLength,
        gcWarnLow: cfg.gcWarnLow,
        gcWarnHigh: cfg.gcWarnHigh,
        minOrfLength: cfg.minOrfLength,
        tmPrimerConcNM: cfg.tmPrimerConcNM,
        tmNaConcMM: cfg.tmNaConcMM,
        tmMgConcMM: cfg.tmMgConcMM,
        codonHost: cfg.codonHost,
        codonCaiWarnBelow: cfg.codonCaiWarnBelow,
        customTablePath: vscode.workspace.getConfiguration('biolint').get<string>('codon.customTablePath', ''),
        threatEntries: db.entries,
        dbVersion: db.version,
      },
    };
  }

  async lint(doc: vscode.TextDocument): Promise<void> {
    const started = Date.now();
    const key = doc.uri.toString();
    const runId = (this.runIds.get(key) ?? 0) + 1;
    this.runIds.set(key, runId);
    const alive = (): boolean => this.runIds.get(key) === runId;

    const cfg = getConfig();
    const text = doc.getText();
    if (text.length > HARD_CEILING) {
      this.collection.set(doc.uri, []);
      return;
    }
    const { opts, dbVersion } = this.buildOpts();
    opts.fileLanguageId = doc.languageId;
    const token = cfg.mode === 'enterprise' ? await getToken(this.ctx) : undefined;
    if (!alive()) { return; }

    let result: AnalyzeResult;
    if (text.length > WORKER_THRESHOLD) {
      result = await this.lintInWorker(doc.fileName, text, opts);
    } else {
      result = analyzeDocumentText(doc.fileName, text, opts);
    }
    if (!alive()) { return; }
    const diags = result.findings.map(f => toDiagnostic(doc, f));
    this.collection.set(doc.uri, diags);

    // Enterprise re-screen (main thread only, needs the token + segments).
    if (cfg.mode === 'enterprise' && token && text.length <= WORKER_THRESHOLD) {
      const segments = extractSegments(doc.fileName, text, cfg.minPrimerLength);
      for (const seg of segments) {
        const { pure } = stripToPure(seg.raw);
        if (pure.length >= 8) {
          void this.enterpriseRescreen(doc, pure, opts, token);
        }
      }
    }

    try {
      const ms = Date.now() - started;
      if (cfg.debug || result.verdict !== 'APPROVED') {
        const via = text.length > WORKER_THRESHOLD ? 'worker' : 'main';
        this.output.appendLine(
          `[biolint] ${shortName(doc.fileName)} — ${diags.length} diag (${result.errors}E/${result.warnings}W) ` +
          `verdict=${result.verdict} db=${dbVersion} ${ms}ms via=${via}`,
        );
      }
      void this.audit.append({
        ts: new Date().toISOString(),
        file: shortName(doc.fileName),
        sha256: sha256HexSync(text).slice(0, 16),
        mode: cfg.mode,
        dbVersion,
        records: result.segments,
        verdict: result.verdict,
        rejected: result.rejected,
        flagged: result.flagged,
        errors: result.errors,
        warnings: result.warnings,
      });
    } catch { /* observability must never break linting */ }
    try { this.onDone?.(doc); } catch { /* ignore */ }
  }

  /** v2.0: heavy analysis off the extension-host event loop. Falls back to sync. */
  private lintInWorker(fileName: string, text: string, opts: AnalyzeOpts): Promise<AnalyzeResult> {
    return new Promise(resolve => {
      const fallback = (): void => {
        try { resolve(analyzeDocumentText(fileName, text, opts)); }
        catch { resolve({ findings: [], segments: 0, verdict: 'APPROVED', rejected: 0, flagged: 0, errors: 0, warnings: 0 }); }
      };
      let worker: Worker;
      try {
        worker = new Worker(path.join(__dirname, 'lintWorker.js'), {
          workerData: { fileName, text, opts },
        });
      } catch {
        fallback();
        return;
      }
      const timer = setTimeout(() => {
        try { worker.terminate(); } catch { /* ignore */ }
        fallback();
      }, WORKER_TIMEOUT_MS);
      worker.once('message', (result: AnalyzeResult) => {
        clearTimeout(timer);
        try { worker.terminate(); } catch { /* ignore */ }
        if (result && Array.isArray(result.findings)) { resolve(result); }
        else { fallback(); }
      });
      worker.once('error', () => { clearTimeout(timer); fallback(); });
    });
  }

  private async enterpriseRescreen(
    doc: vscode.TextDocument, pure: string,
    opts: AnalyzeOpts, token: string,
  ): Promise<void> {
    const stamp = Date.now();
    this.pendingEnterprise.set(doc.uri.toString(), stamp);
    const cfg = getConfig();
    const fallback = screenSequence(pure, opts.threatEntries, opts.dbVersion, 'local');
    const res = await screenEnterprise(pure, { baseUrl: cfg.enterpriseUrl, token }, fallback);
    if (this.pendingEnterprise.get(doc.uri.toString()) !== stamp) { return; }
    if (res.mode === 'enterprise' && res.verdict !== fallback.verdict) {
      const isBioguard = (d: vscode.Diagnostic): boolean => {
        const c = typeof d.code === 'string' ? d.code : (d.code as { value?: string } | undefined)?.value ?? '';
        return c.startsWith('biolint.bioguard');
      };
      const current = (this.collection.get(doc.uri) ?? []).filter(d => !isBioguard(d));
      for (const m of res.matches.slice(0, 20)) {
        current.push(this.enterpriseDiagnostic(doc, m));
      }
      this.collection.set(doc.uri, current);
    }
  }

  private enterpriseDiagnostic(doc: vscode.TextDocument, m: import('./bio').ThreatMatch): vscode.Diagnostic {
    // Locate the k-mer in the document text directly (exact offsets, both strands).
    const upper = doc.getText().toUpperCase();
    const kmer = m.matchedKmer;
    let idx = upper.indexOf(kmer);
    if (idx === -1) {
      const comp: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G', N: 'N' };
      const rc = [...kmer].reverse().map(c => comp[c] ?? 'N').join('');
      idx = upper.indexOf(rc);
    }
    const range = idx >= 0
      ? new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + kmer.length))
      : new vscode.Range(0, 0, 0, 1);
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
    return d;
  }
}

export function toDiagnostic(doc: vscode.TextDocument, f: Finding): vscode.Diagnostic {
  const d = new vscode.Diagnostic(
    new vscode.Range(doc.positionAt(f.start), doc.positionAt(f.end)),
    f.message,
    f.severity as unknown as vscode.DiagnosticSeverity,
  );
  d.code = f.code;
  d.source = 'biolint';
  return d;
}

function shortName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
