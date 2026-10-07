/**
 * auditLog.ts — local screening audit trail (v1.2.0).
 * Every lint run appends one JSONL line to globalStorage; sensitive content is
 * never stored (only hashes, verdicts, counts). Rotated at ~512 KB.
 */
import * as vscode from 'vscode';

export interface AuditEntry {
  ts: string;
  file: string;
  sha256: string;
  mode: string;
  dbVersion: string;
  records: number;
  verdict: 'APPROVED' | 'FLAGGED_FOR_REVIEW' | 'REJECTED';
  rejected: number;
  flagged: number;
  errors: number;
  warnings: number;
}

const FILE = 'biolint-audit.jsonl';
const MAX_BYTES = 512 * 1024;

export class AuditLog {
  private dir: vscode.Uri;

  constructor(ctx: vscode.ExtensionContext) {
    this.dir = ctx.globalStorageUri;
  }

  private get file(): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, FILE);
  }

  async append(entry: AuditEntry): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.dir);
      const line = Buffer.from(JSON.stringify(entry) + '\n');
      let existing = Buffer.alloc(0);
      try {
        const raw = await vscode.workspace.fs.readFile(this.file);
        existing = Buffer.from(raw);
      } catch { /* first write */ }
      let combined = Buffer.concat([existing, line]);
      if (combined.length > MAX_BYTES) {
        // Rotate: keep the tail (most recent entries).
        const text = combined.toString('utf8');
        const lines = text.split('\n').filter(l => l.trim().length > 0);
        const keep = lines.slice(-2000);
        combined = Buffer.from(keep.join('\n') + '\n');
      }
      await vscode.workspace.fs.writeFile(this.file, combined);
    } catch {
      // Audit must never break linting.
    }
  }

  async open(): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(this.file);
      await vscode.window.showTextDocument(doc);
    } catch {
      vscode.window.showInformationMessage('BioLint: audit log is empty — lint a sequence file first.');
    }
  }

  async export(): Promise<void> {
    let src: Uint8Array;
    try {
      src = await vscode.workspace.fs.readFile(this.file);
    } catch {
      vscode.window.showInformationMessage('BioLint: audit log is empty — nothing to export.');
      return;
    }
    const save = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('biolint-audit-export.jsonl'),
      filters: { JSONL: ['jsonl'], All: ['*'] },
      saveLabel: 'Export audit log',
    });
    if (!save) { return; }
    await vscode.workspace.fs.writeFile(save, Buffer.from(src));
    vscode.window.showInformationMessage(`BioLint: audit log exported (${src.length} bytes).`);
  }
}
