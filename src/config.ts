/** config.ts — typed access to `biolint.*` settings + hybrid mode. */
import * as vscode from 'vscode';

export type BioLintMode = 'local' | 'enterprise';
export type CodonHost = 'ecoli' | 'yeast' | 'human';

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
  tmPrimerConcNM: number;
  tmNaConcMM: number;
  tmMgConcMM: number;
  codonHost: CodonHost;
  codonCaiWarnBelow: number;
  pairMaxDeltaTm: number;
  enableInlayHints: boolean;
  debug: boolean;
}

export function tmOptionsOf(cfg: BioLintConfig): { primerConcNM: number; naConcMM: number; mgConcMM: number } {
  return { primerConcNM: cfg.tmPrimerConcNM, naConcMM: cfg.tmNaConcMM, mgConcMM: cfg.tmMgConcMM };
}

export function getConfig(): BioLintConfig {
  const c = vscode.workspace.getConfiguration('biolint');
  const mode = c.get<string>('mode', 'local');
  const host = c.get<string>('codonHost', 'ecoli');
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
    tmPrimerConcNM: c.get<number>('tm.primerConcNM', 250),
    tmNaConcMM: c.get<number>('tm.naConcMM', 50),
    tmMgConcMM: c.get<number>('tm.mgConcMM', 0),
    codonHost: host === 'yeast' || host === 'human' ? host : 'ecoli',
    codonCaiWarnBelow: c.get<number>('codon.caiWarnBelow', 0.65),
    pairMaxDeltaTm: c.get<number>('pair.maxDeltaTm', 5),
    enableInlayHints: c.get<boolean>('enableInlayHints', true),
    debug: c.get<boolean>('debug', false),
  };
}

export async function setMode(mode: BioLintMode): Promise<void> {
  await vscode.workspace.getConfiguration('biolint').update('mode', mode, vscode.ConfigurationTarget.Global);
}
