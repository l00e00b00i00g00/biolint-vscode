/** statusBar.ts — Local / Enterprise hybrid mode selector. */
import * as vscode from 'vscode';
import { getConfig } from './config';
import { getToken } from './enterprise';

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

export async function cmdSwitchMode(ctx: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  const cfg = getConfig();
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
