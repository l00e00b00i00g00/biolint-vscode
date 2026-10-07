/** codeActions.ts — 1-click quick fixes surfaced as lightbulbs + hover command links. */
import * as vscode from 'vscode';
import {
  optimizePrimer, reverseComplement, analyzePair, optimizeCodons,
  HOST_TABLES, loadCodonTable, extractSegments,
} from './bio';
import { getConfig, tmOptionsOf } from './config';
import { CODE } from './diagnostics';

interface CmdArgs { seq?: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } } }

function argsOf(arg: unknown): CmdArgs {
  if (arg && typeof arg === 'object') { return arg as CmdArgs; }
  return {};
}

function dnaPattern(): RegExp {
  // Audit 10/10: same threshold as the linter — no drift between lint & actions.
  return new RegExp(`[ACGTUacgtuNn]{${Math.max(5, getConfig().minPrimerLength)},}`);
}

function dnaRangeAt(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range | undefined {
  const word = doc.getWordRangeAtPosition(pos, dnaPattern());
  return word ?? undefined;
}

export async function cmdOptimizePrimer(arg?: unknown): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return; }
  const a = argsOf(arg);
  let range: vscode.Range | undefined;
  let seq: string | undefined = a.seq;
  if (a.range) {
    range = new vscode.Range(
      new vscode.Position(a.range.start.line, a.range.start.character),
      new vscode.Position(a.range.end.line, a.range.end.character),
    );
    seq = ed.document.getText(range);
  } else if (!seq) {
    range = dnaRangeAt(ed.document, ed.selection.active);
    if (range) { seq = ed.document.getText(range); }
    else if (!ed.selection.isEmpty) {
      range = new vscode.Range(ed.selection.start, ed.selection.end);
      seq = ed.document.getText(range);
    }
  }
  if (!seq || !range) {
    vscode.window.showWarningMessage(`BioLint: place the cursor on a DNA sequence (≥${getConfig().minPrimerLength} nt) to optimize it.`);
    return;
  }
  const clean = seq.replace(/[^ACGTUacgtuNn]/g, '');
  const res = optimizePrimer(clean);
  const detail = `Tm ${res.before.tm}°C → ${res.after.tm}°C · GC ${res.before.gcPct}% → ${res.after.gcPct}% · score ${res.before.score} → ${res.after.score}\n` +
    res.changes.map(c => `• ${c}`).join('\n');
  const apply = await vscode.window.showInformationMessage(
    `BioLint optimized primer (score ${res.before.score} → ${res.after.score}). Apply?`,
    { modal: false, detail },
    'Apply optimization',
    'Copy to clipboard',
  );
  if (apply === 'Apply optimization') {
    await ed.edit(b => b.replace(range!, res.optimized));
  } else if (apply === 'Copy to clipboard') {
    await vscode.env.clipboard.writeText(res.optimized);
  }
}

export async function cmdReverseComplement(arg?: unknown): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return; }
  const a = argsOf(arg);
  let range: vscode.Range | undefined;
  let seq: string | undefined = a.seq;
  if (a.range) {
    range = new vscode.Range(
      new vscode.Position(a.range.start.line, a.range.start.character),
      new vscode.Position(a.range.end.line, a.range.end.character),
    );
    seq = ed.document.getText(range);
  } else if (!seq) {
    range = dnaRangeAt(ed.document, ed.selection.active);
    if (range) { seq = ed.document.getText(range); }
    else if (!ed.selection.isEmpty) {
      range = new vscode.Range(ed.selection.start, ed.selection.end);
      seq = ed.document.getText(range);
    }
  }
  if (!seq) {
    vscode.window.showWarningMessage('BioLint: place the cursor on a DNA sequence to get its reverse complement.');
    return;
  }
  const clean = seq.replace(/[^ACGTUacgtuNn]/g, '');
  const out = reverseComplement(clean);
  if (range) {
    const place = await vscode.window.showQuickPick(['Replace selection', 'Insert below', 'Copy to clipboard'], { placeHolder: `Reverse complement of ${clean.length} nt` });
    if (place === 'Replace selection') { await ed.edit(b => b.replace(range!, out)); }
    else if (place === 'Insert below') { await ed.edit(b => b.insert(range!.end, `\n${out}`)); }
    else if (place === 'Copy to clipboard') { await vscode.env.clipboard.writeText(out); }
  } else {
    await vscode.env.clipboard.writeText(out);
    vscode.window.showInformationMessage('BioLint: reverse complement copied to clipboard.');
  }
}

export class BioCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    doc: vscode.TextDocument, range: vscode.Range | vscode.Selection,
    ctx: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const hasBiolintDiag = ctx.diagnostics.some(d => d.source === 'biolint');
    // Audit fix: NEVER call doc.getText(undefined) (whole document) here — only
    // the word under the cursor or the selected text decides the lightbulb.
    // A whole-document test made primer actions appear on every line.
    let looksLikeDna = false;
    if (!range.isEmpty) {
      looksLikeDna = dnaPattern().test(doc.getText(range));
    } else {
      looksLikeDna = !!doc.getWordRangeAtPosition(range.start, dnaPattern());
    }

    if (hasBiolintDiag || looksLikeDna) {
      const opt = new vscode.CodeAction('BioLint: Optimize this primer', vscode.CodeActionKind.QuickFix);
      opt.command = { command: 'biolint.optimizePrimer', title: 'Optimize primer' };
      opt.diagnostics = ctx.diagnostics.filter(d => d.source === 'biolint');
      actions.push(opt);

      const rvc = new vscode.CodeAction('BioLint: Generate reverse complement', vscode.CodeActionKind.QuickFix);
      rvc.command = { command: 'biolint.reverseComplement', title: 'Reverse complement' };
      actions.push(rvc);
    }
    const flagged = ctx.diagnostics.some(d =>
      d.code === CODE.rejected || d.code === CODE.flagged ||
      (typeof d.code === 'object' && d.code !== null && ((d.code as { value: string }).value === CODE.rejected || (d.code as { value: string }).value === CODE.flagged)));
    if (flagged) {
      const cc = new vscode.CodeAction('BioLint: Open Enterprise Command Center for review', vscode.CodeActionKind.QuickFix);
      cc.command = { command: 'biolint.openCommandCenter', title: 'Open Command Center' };
      actions.push(cc);
    }
    if (hasBiolintDiag) {
      const studio = new vscode.CodeAction('BioLint: Continue in SynthFlow Studio (visual design)', vscode.CodeActionKind.Empty);
      studio.command = { command: 'biolint.openSynthFlowStudio', title: 'Open SynthFlow Studio' };
      actions.push(studio);
    }
    const needsCodon = ctx.diagnostics.some(d =>
      d.code === CODE.codon || (typeof d.code === 'object' && d.code !== null && (d.code as { value: string }).value === CODE.codon));
    if (needsCodon) {
      const co = new vscode.CodeAction('BioLint: Optimize codons for host (CAI)', vscode.CodeActionKind.QuickFix);
      co.command = { command: 'biolint.optimizeCodons', title: 'Optimize codons' };
      actions.push(co);
    }
    return actions;
  }
}

/** v1.1.0: primer-pair QC from two selections (or two primer quickpicks). */
export async function cmdCheckPrimerPair(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return; }
  const cfg = getConfig();
  const clean = (s: string): string => s.toUpperCase().replace(/[^ACGTUN]/g, '').replace(/U/g, 'T');
  const nonEmpty = ed.selections.filter(s => !s.isEmpty && clean(ed.document.getText(s)).length >= 10);
  let fwd = '', rev = '';
  if (nonEmpty.length >= 2) {
    fwd = clean(ed.document.getText(nonEmpty[0]));
    rev = clean(ed.document.getText(nonEmpty[1]));
  } else {
    const cands = extractSegments(ed.document.fileName, ed.document.getText(), cfg.minPrimerLength)
      .map(s => ({ id: s.id, seq: clean(s.raw) }))
      .filter(c => c.seq.length >= 10 && c.seq.length <= 200);
    if (cands.length < 2) {
      vscode.window.showWarningMessage('BioLint: select two primers (multi-cursor) or open a file with ≥2 primer candidates.');
      return;
    }
    const pick = async (place: string): Promise<string | undefined> => {
      const c = await vscode.window.showQuickPick(
        cands.map(x => ({ label: x.id, description: `${x.seq.length} nt`, seq: x.seq })),
        { placeHolder: `Select ${place} primer` },
      );
      return c?.seq;
    };
    fwd = (await pick('forward')) ?? '';
    if (!fwd) { return; }
    rev = (await pick('reverse')) ?? '';
    if (!rev) { return; }
  }
  const res = analyzePair(fwd, rev, cfg.gcWarnLow, cfg.gcWarnHigh, tmOptionsOf(cfg), cfg.pairMaxDeltaTm);
  const choice = await vscode.window.showInformationMessage(
    res.ok ? `✅ Primer pair PASS — ΔTm ${res.deltaTm}°C, heterodimer ΔG ${res.heteroDimerDG} kcal/mol.` : `❌ Primer pair FAIL — ΔTm ${res.deltaTm}°C, heterodimer ΔG ${res.heteroDimerDG} kcal/mol.`,
    { modal: false, detail: res.report },
    'Copy report',
  );
  if (choice === 'Copy report') { await vscode.env.clipboard.writeText(res.report); }
}

/** v1.1.0: codon optimization for the configured (or picked) host. */
export async function cmdOptimizeCodons(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return; }
  const cfg = getConfig();
  let range: vscode.Range | undefined;
  let seq = '';
  if (!ed.selection.isEmpty) {
    range = new vscode.Range(ed.selection.start, ed.selection.end);
    seq = ed.document.getText(range);
  } else {
    range = dnaRangeAt(ed.document, ed.selection.active);
    if (range) { seq = ed.document.getText(range); }
  }
  const cleanSeq = seq.toUpperCase().replace(/[^ACGTU]/g, '').replace(/U/g, 'T');
  if (cleanSeq.length < 30) {
    vscode.window.showWarningMessage('BioLint: select a coding sequence (≥30 nt, ideally a full ORF) to optimize codons.');
    return;
  }
  const hostPick = await vscode.window.showQuickPick(
    (Object.keys(HOST_TABLES) as (keyof typeof HOST_TABLES)[]).map(h => ({
      label: HOST_TABLES[h].name,
      description: h === cfg.codonHost ? 'configured default' : '',
      id: h,
    })),
    { placeHolder: 'Expression host for codon optimization' },
  );
  if (!hostPick) { return; }
  const customPath = vscode.workspace.getConfiguration('biolint').get<string>('codon.customTablePath', '');
  const table = loadCodonTable(hostPick.id, customPath);
  const res = optimizeCodons(cleanSeq, table);
  const apply = await vscode.window.showInformationMessage(
    `BioLint codon optimization (${table.name}): CAI ${res.caiBefore} → ${res.caiAfter}, ${res.changes} codons changed. Apply?`,
    { modal: false, detail: res.notes.join('\n') },
    'Apply optimization',
    'Copy to clipboard',
  );
  if (apply === 'Apply optimization' && range) {
    await ed.edit(b => b.replace(range!, res.optimized));
  } else if (apply === 'Copy to clipboard') {
    await vscode.env.clipboard.writeText(res.optimized);
  }
}
