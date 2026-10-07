/** enterprise.ts — OAuth2/JWT token vault + Command Center bridge. */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getConfig } from './config';

const TOKEN_KEY = 'biolint.enterpriseToken';

export async function getToken(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  return ctx.secrets.get(TOKEN_KEY);
}

export async function loginEnterprise(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  const cfg = getConfig();
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Paste API token / JWT', description: 'Copied from app.bioguard.ai → Settings → API keys' },
      { label: 'Open login page in browser', description: cfg.enterpriseUrl },
    ],
    { placeHolder: 'Connect BioLint to BioGuard Enterprise' },
  );
  if (!choice) { return undefined; }
  if (choice.label.startsWith('Open login')) {
    await vscode.env.openExternal(vscode.Uri.parse(`${cfg.enterpriseUrl.replace(/\/$/, '')}/login?client=vscode`));
    return loginWithPastedToken(ctx);
  }
  return loginWithPastedToken(ctx);
}

async function loginWithPastedToken(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  const token = await vscode.window.showInputBox({
    prompt: 'Paste your BioGuard Enterprise token (stored in VS Code SecretStorage, never in settings)',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v && v.trim().length >= 8 ? undefined : 'Token looks too short'),
  });
  if (!token) { return undefined; }
  await ctx.secrets.store(TOKEN_KEY, token.trim());
  vscode.window.showInformationMessage('BioLint: connected to BioGuard Enterprise.');
  return token.trim();
}

export async function logoutEnterprise(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.secrets.delete(TOKEN_KEY);
  vscode.window.showInformationMessage('BioLint: Enterprise token removed — back to Local mode.');
}

/** Open the web Command Center, optionally deep-linking a file hash + verdict. */
export async function openCommandCenter(hash?: string, verdict?: string): Promise<void> {
  const cfg = getConfig();
  const base = cfg.enterpriseUrl.replace(/\/$/, '');
  const q = hash ? `/command-center?file=${encodeURIComponent(hash)}&verdict=${encodeURIComponent(verdict ?? '')}&source=vscode` : '/command-center?source=vscode';
  await vscode.env.openExternal(vscode.Uri.parse(base + q));
}

/** Open the collaborative visual design surface (SynthFlow Studio bridge). */
export async function openSynthFlowStudio(hash?: string): Promise<void> {
  const cfg = getConfig();
  const base = cfg.synthFlowStudioUrl.replace(/\/$/, '');
  const q = hash ? `/import?sha256=${encodeURIComponent(hash)}&source=biolint-vscode` : '/?source=biolint-vscode';
  await vscode.env.openExternal(vscode.Uri.parse(base + q));
}

export function sha256HexSync(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
