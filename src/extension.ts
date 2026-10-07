/** extension.ts — BioLint-VSCode activation & wiring. */
import * as vscode from 'vscode';
import { BioLinter } from './diagnostics';
import { BioHoverProvider } from './hover';
import { BioCodeActionProvider, cmdOptimizePrimer, cmdReverseComplement } from './codeActions';
import { ModeStatusBar, cmdSwitchMode } from './statusBar';
import { loginEnterprise, logoutEnterprise, openCommandCenter, openSynthFlowStudio, sha256HexSync } from './enterprise';
import { SequenceViewPanel } from './panels/sequenceView';
import { cmdExportCertificate, cmdVerifyHash } from './compliance';
import { cmdInstallPreCommitHook } from './gitHook';
import { getConfig } from './config';
import { CODE } from './diagnostics';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'biofasta' }, { language: 'biogenbank' }, { language: 'biofastq' },
  { language: 'yaml' }, { language: 'python' }, { language: 'typescript' },
  { language: 'typescriptreact' }, { language: 'javascript' }, { language: 'json' },
  { scheme: 'file' }, { scheme: 'untitled' },
];

export function activate(ctx: vscode.ExtensionContext): void {
  const linter = new BioLinter(ctx);
  const statusBar = new ModeStatusBar(ctx);

  // Initial lint of already-open editors (LSP-style background analysis).
  for (const ed of vscode.window.visibleTextEditors) {
    if (linter.shouldLint(ed.document)) { void linter.lint(ed.document); }
  }

  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => { if (linter.shouldLint(doc)) { void linter.lint(doc); } }),
    vscode.workspace.onDidChangeTextDocument(e => linter.schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument(doc => { if (linter.shouldLint(doc)) { void linter.lint(doc); } }),
    vscode.workspace.onDidCloseTextDocument(doc => linter.clear(doc)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('biolint')) {
        void statusBar.refresh();
        for (const ed of vscode.window.visibleTextEditors) {
          if (linter.shouldLint(ed.document)) { void linter.lint(ed.document); }
        }
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(ed => {
      if (ed && linter.shouldLint(ed.document)) { SequenceViewPanel.update(ed.document); }
    }),

    vscode.languages.registerHoverProvider(SELECTOR, new BioHoverProvider()),
    vscode.languages.registerCodeActionsProvider(SELECTOR, new BioCodeActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty],
    }),

    vscode.commands.registerCommand('biolint.showSequenceView', () => SequenceViewPanel.show(ctx)),
    vscode.commands.registerCommand('biolint.exportCertificate', (uri?: vscode.Uri) => cmdExportCertificate(uri)),
    vscode.commands.registerCommand('biolint.verifyHash', (uri?: vscode.Uri) => cmdVerifyHash(uri)),
    vscode.commands.registerCommand('biolint.installPreCommitHook', (uri?: vscode.Uri) => cmdInstallPreCommitHook(uri)),
    vscode.commands.registerCommand('biolint.switchMode', () => cmdSwitchMode(ctx, () => void statusBar.refresh())),
    vscode.commands.registerCommand('biolint.loginEnterprise', async () => {
      await loginEnterprise(ctx);
      await statusBar.refresh();
    }),
    vscode.commands.registerCommand('biolint.logoutEnterprise', async () => {
      await logoutEnterprise(ctx);
      await statusBar.refresh();
    }),
    vscode.commands.registerCommand('biolint.optimizePrimer', (arg?: unknown) => cmdOptimizePrimer(arg)),
    vscode.commands.registerCommand('biolint.reverseComplement', (arg?: unknown) => cmdReverseComplement(arg)),
    vscode.commands.registerCommand('biolint.openCommandCenter', async () => {
      const hash = hashOfActive();
      const verdict = verdictOfActive();
      await openCommandCenter(hash, verdict);
    }),
    vscode.commands.registerCommand('biolint.openSynthFlowStudio', async () => {
      await openSynthFlowStudio(hashOfActive());
    }),
  );

  void statusBar.refresh();
}

function hashOfActive(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return undefined; }
  try { return sha256HexSync(ed.document.getText()).slice(0, 32); }
  catch { return undefined; }
}

function verdictOfActive(): string {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return ''; }
  const diags = vscode.languages.getDiagnostics(ed.document.uri);
  if (diags.some(d => d.code === CODE.rejected || codeValue(d) === CODE.rejected)) { return 'REJECTED'; }
  if (diags.some(d => d.code === CODE.flagged || codeValue(d) === CODE.flagged)) { return 'FLAGGED_FOR_REVIEW'; }
  return 'APPROVED';
}

function codeValue(d: vscode.Diagnostic): string | undefined {
  if (d.code && typeof d.code === 'object') { return (d.code as { value: string }).value; }
  return undefined;
}

// Keep for tests that import the module without vscode runtime.
export function getConfigSafe(): ReturnType<typeof getConfig> | undefined {
  try { return getConfig(); } catch { return undefined; }
}

export function deactivate(): void { /* diagnostics collection disposed via subscriptions */ }
