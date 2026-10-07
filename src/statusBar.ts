/** statusBar.ts — Local / Enterprise hybrid mode selector + file summary. */
import * as vscode from 'vscode';
import { getConfig } from './config';
import { getToken } from './enterprise';
import { extractSegments, stripToPure, gcContent, screenSequence, loadLocalThreatDb } from './bio';

export class ModeStatusBar {
  private item: vscode.StatusBarItem;

  constructor(private ctx: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'biolint.switchMode';
    this.item.tooltip = 'BioLint screening mode — click to switch';
    ctx.subscriptions.push(this.item);
    this.item.show();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const cfg = getConfig();
    if (cfg.mode === 'enterprise') {
      const token = await getToken(this.ctx);
      this.item.text = token ? '$(cloud) BioLint: Enterprise ✓' : '$(cloud) BioLint: Enterprise (login needed)';
      this.item.backgroundColor = token ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.text = '$(shield) BioLint: Local (offline)';
      this.item.backgroundColor = undefined;
    }
    this.item.tooltip = `BioLint mode: ${cfg.mode}\nLocal = embedded open-source engine + .bioguard/ lists (no data leaves the machine).\nEnterprise = cloud threat feed + compliance sync (${cfg.enterpriseUrl}).\nClick to switch.`;
  }
}

export async function cmdSwitchMode(ctx: vscode.ExtensionContext, refresh: () => void): Promise<void> {  const cfg = getConfig();
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: '$(shield) Local (Offline / Open Source)',
        description: 'Embedded engine + .bioguard/ public lists',
        detail: 'Academic research & rapid prototyping. No data leaves the machine.',
        mode: 'local' as const,
      },
      {
        label: '$(cloud) Enterprise (Cloud Connected)',
        description: 'OAuth2/JWT → app.bioguard.ai threat feed',
        detail: 'Exclusive threat DB + manufacturer compliance flow. Requires login.',
        mode: 'enterprise' as const,
      },
    ],
    { placeHolder: `BioLint mode (current: ${cfg.mode})` },
  );
  if (!pick) { return; }
  await vscode.workspace.getConfiguration('biolint').update('mode', pick.mode, vscode.ConfigurationTarget.Global);
  if (pick.mode === 'enterprise') {
    const { loginEnterprise } = await import('./enterprise');
    const token = await ctx.secrets.get('biolint.enterpriseToken');
    if (!token) { await loginEnterprise(ctx); }
  }
  refresh();
  vscode.window.showInformationMessage(`BioLint: switched to ${pick.mode.toUpperCase()} mode.`);
}

/** v1.2.0: live file summary — length-weighted GC% + local biosafety verdict. */
export class FileSummary {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;

  constructor(ctx: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.item.command = 'biolint.showSequenceView';
    this.item.tooltip = 'BioLint file summary — click for the Sequence Visualizer';
    ctx.subscriptions.push(this.item);
  }

  /** Debounced refresh (analysis is sync; keep it off the keystroke path). */
  schedule(doc?: vscode.TextDocument): void {
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => this.update(doc ?? vscode.window.activeTextEditor?.document), 400);
  }

  update(doc?: vscode.TextDocument): void {
    try {
      if (!doc || doc.getText().length > 500_000) { this.item.hide(); return; }
      const cfg = getConfig();
      const segments = extractSegments(doc.fileName, doc.getText(), cfg.minPrimerLength);
      if (segments.length === 0) { this.item.hide(); return; }
      let gcSum = 0, lenSum = 0, worst = 0; // 0 approved, 1 flagged, 2 rejected
      const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
      const db = loadLocalThreatDb(roots);
      for (const seg of segments.slice(0, 50)) {
        const { pure } = stripToPure(seg.raw);
        if (pure.length === 0) { continue; }
        gcSum += gcContent(pure).gcPct * pure.length;
        lenSum += pure.length;
        if (db.entries.length > 0 && pure.length >= 8) {
          const v = screenSequence(pure, db.entries, db.version, 'local').verdict;
          worst = Math.max(worst, v === 'REJECTED' ? 2 : v === 'FLAGGED_FOR_REVIEW' ? 1 : 0);
        }
      }
      if (lenSum === 0) { this.item.hide(); return; }
      const gc = (gcSum / lenSum).toFixed(1);
      const badge = worst === 2 ? '$(error) REJECTED' : worst === 1 ? '$(warning) FLAGGED' : '$(check) OK';
      this.item.text = `$(beaker) ${lenSum} nt · GC ${gc}% · ${badge}`;
      this.item.backgroundColor = worst === 2
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : worst === 1
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
      this.item.show();
    } catch {
      this.item.hide();
    }
  }
}
