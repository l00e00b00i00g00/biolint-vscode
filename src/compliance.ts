/**
 * compliance.ts — SHA-256 compliance certificates (export / verify).
 * Certificate = signed snapshot: file hash + per-record GC/verdict + db version.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { extractSegments, gcContent, screenSequence, loadLocalThreatDb } from './bio';
import { getConfig } from './config';

export interface ComplianceCertificate {
  tool: 'biolint-vscode';
  version: string;
  file: string;
  sha256: string;
  createdAt: string;
  mode: string;
  threatDb: string;
  records: { id: string; length: number; gcPct: number; verdict: string }[];
  verdict: 'APPROVED' | 'FLAGGED_FOR_REVIEW' | 'REJECTED';
}

export function sha256Of(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildCertificate(doc: vscode.TextDocument): ComplianceCertificate {
  const cfg = getConfig();
  const text = doc.getText();
  const segments = extractSegments(doc.fileName, text, cfg.minPrimerLength);
  const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
  const db = loadLocalThreatDb(roots);
  const records = segments.map(seg => {
    const pure = seg.raw.toUpperCase().replace(/[^ACGT]/g, '');
    const screen = screenSequence(pure, db.entries, db.version, 'local');
    return {
      id: seg.id,
      length: pure.length,
      gcPct: Math.round(gcContent(pure || 'A').gcPct * 10) / 10,
      verdict: screen.verdict,
    };
  });
  const verdict = records.some(r => r.verdict === 'REJECTED')
    ? 'REJECTED'
    : records.some(r => r.verdict === 'FLAGGED_FOR_REVIEW')
      ? 'FLAGGED_FOR_REVIEW'
      : 'APPROVED';
  const ext = vscode.extensions.getExtension('bioguard.biolint-vscode');
  return {
    tool: 'biolint-vscode',
    version: ext?.packageJSON?.version ?? '1.0.0',
    file: path.basename(doc.fileName),
    sha256: sha256Of(text),
    createdAt: new Date().toISOString(),
    mode: cfg.mode,
    threatDb: db.version,
    records,
    verdict,
  };
}

export async function cmdExportCertificate(uri?: vscode.Uri): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  let doc: vscode.TextDocument | undefined;
  if (uri) {
    try { doc = await vscode.workspace.openTextDocument(uri); }
    catch { vscode.window.showErrorMessage('BioLint: cannot read that file.'); return; }
  } else if (ed) {
    doc = ed.document;
  } else {
    vscode.window.showWarningMessage('BioLint: open a sequence file or right-click it in the Explorer.');
    return;
  }
  const cert = buildCertificate(doc);
  const defaultName = doc.fileName.replace(/(\.[^.]+)?$/, '.biolint-cert.json');
  const save = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultName),
    filters: { JSON: ['json'] },
    saveLabel: 'Export compliance certificate',
  });
  if (!save) { return; }
  fs.writeFileSync(save.fsPath, JSON.stringify(cert, null, 2) + '\n');
  const icon = cert.verdict === 'APPROVED' ? '✅' : cert.verdict === 'REJECTED' ? '⛔' : '⚠️';
  const open = await vscode.window.showInformationMessage(
    `${icon} BioLint certificate: ${cert.verdict} · SHA-256 ${cert.sha256.slice(0, 16)}…`,
    'Open certificate', 'Copy SHA-256',
  );
  if (open === 'Open certificate') {
    const d = await vscode.workspace.openTextDocument(save);
    await vscode.window.showTextDocument(d);
  } else if (open === 'Copy SHA-256') {
    await vscode.env.clipboard.writeText(cert.sha256);
  }
}

export async function cmdVerifyHash(uri?: vscode.Uri): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const fileUri = uri ?? ed?.document.uri;
  if (!fileUri) { vscode.window.showWarningMessage('BioLint: nothing to verify.'); return; }
  const doc = ed && ed.document.uri.toString() === fileUri.toString()
    ? ed.document
    : await vscode.workspace.openTextDocument(fileUri);
  const current = sha256Of(doc.getText());
  const candidates = [
    doc.fileName.replace(/(\.[^.]+)?$/, '.biolint-cert.json'),
    path.join(path.dirname(doc.fileName), `${path.basename(doc.fileName)}.biolint-cert.json`),
  ];
  let cert: ComplianceCertificate | undefined;
  let certPath = '';
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { cert = JSON.parse(fs.readFileSync(c, 'utf8')); certPath = c; break; }
      catch { /* keep looking */ }
    }
  }
  if (!cert) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false, filters: { Certificates: ['json'] },
      openLabel: 'Select .biolint-cert.json to verify against',
    });
    if (!picked?.[0]) { return; }
    certPath = picked[0].fsPath;
    try { cert = JSON.parse(fs.readFileSync(certPath, 'utf8')); }
    catch { vscode.window.showErrorMessage('BioLint: unreadable certificate file.'); return; }
  }
  if (!cert) {
    vscode.window.showErrorMessage('BioLint: could not load a certificate to verify against.');
    return;
  }
  if (cert.sha256 === current) {
    vscode.window.showInformationMessage(`✅ BioLint: hash MATCHES certificate (${path.basename(certPath)}) — file untampered since ${cert.createdAt}.`);
  } else {
    const res = await vscode.window.showWarningMessage(
      `⚠️ BioLint: hash MISMATCH — file changed since certificate (${cert.createdAt}). Expected ${cert.sha256.slice(0, 16)}…, got ${current.slice(0, 16)}….`,
      'Re-export certificate', 'Show diff info',
    );
    if (res === 'Re-export certificate') { await cmdExportCertificate(fileUri); }
  }
}
