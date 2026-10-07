/** config.ts — typed access to `biolint.*` settings + hybrid mode. */
import * as vscode from 'vscode';

export type BioLintMode = 'local' | 'enterprise';

export interface BioLintConfig {
  mode: BioLintMode;
  enterpriseUrl: string;
  synthFlowStudioUrl: string;
  gcWarnLow: number;
  gcWarnHigh: number;
  minPrimerLength: number;
  minOrfLength: number;
  enableHover: boolean;
  enableLocalThreatDb: boolean;
  debounceMs: number;
}

export function getConfig(): BioLintConfig {
  const c = vscode.workspace.getConfiguration('biolint');
  const mode = c.get<string>('mode', 'local');
  return {
    mode: mode === 'enterprise' ? 'enterprise' : 'local',
    enterpriseUrl: c.get<string>('enterpriseUrl', 'https://app.bioguard.ai'),
    synthFlowStudioUrl: c.get<string>('synthFlowStudioUrl', 'https://studio.synthflow.ai'),
    gcWarnLow: c.get<number>('gc.warnLow', 35),
    gcWarnHigh: c.get<number>('gc.warnHigh', 65),
    minPrimerLength: c.get<number>('minPrimerLength', 15),
    minOrfLength: c.get<number>('minOrfLength', 90),
    enableHover: c.get<boolean>('enableHover', true),
    enableLocalThreatDb: c.get<boolean>('enableLocalThreatDb', true),
    debounceMs: c.get<number>('debounceMs', 350),
  };
}

export async function setMode(mode: BioLintMode): Promise<void> {
  await vscode.workspace.getConfiguration('biolint').update('mode', mode, vscode.ConfigurationTarget.Global);
}
