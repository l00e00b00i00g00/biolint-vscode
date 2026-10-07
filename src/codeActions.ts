/** codeActions.ts — 1-click quick fixes surfaced as lightbulbs + hover command links. */
import * as vscode from 'vscode';
import { optimizePrimer, reverseComplement } from './bio';
import { getConfig } from './config';
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
    return actions;
  }
}
