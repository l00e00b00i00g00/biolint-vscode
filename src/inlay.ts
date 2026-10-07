/**
 * inlay.ts — inline `Tm · GC%` hints after DNA runs (v1.1.0).
 * Non-intrusive: single hint per line, padding only, honors minPrimerLength.
 */
import * as vscode from 'vscode';
import { analyzePrimer } from './bio';
import { getConfig, tmOptionsOf } from './config';

export class BioInlayProvider implements vscode.InlayHintsProvider {
  provideInlayHints(doc: vscode.TextDocument): vscode.InlayHint[] {
    const cfg = getConfig();
    if (!cfg.enableInlayHints) { return []; }
    const out: vscode.InlayHint[] = [];
    const re = new RegExp(`[ACGTUacgtuNn]{${Math.max(5, cfg.minPrimerLength)},}`, 'g');
    const maxLines = Math.min(doc.lineCount, 2000);
    for (let ln = 0; ln < maxLines; ln++) {
      const line = doc.lineAt(ln).text;
      if (line.length > 2000) { continue; }
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let perLine = 0;
      while ((m = re.exec(line)) !== null && perLine < 3) {
        perLine++;
        const token = m[0];
        if (new Set(token.toUpperCase()).size < 2) { continue; }
        if (token.length > 600) { continue; } // contigs: hover/webview territory
        const a = analyzePrimer(token, cfg.gcWarnLow, cfg.gcWarnHigh, tmOptionsOf(cfg));
        const label = `Tm ${a.tm}° · GC ${a.gcPct}%` + (a.foldRisk !== 'low' ? ` · ΔG ${Math.min(a.hairpinDG, a.selfDimerDG)}` : '');
        const hint = new vscode.InlayHint(
          new vscode.Position(ln, m.index + m[0].length),
          label,
          vscode.InlayHintKind.Parameter,
        );
        hint.paddingRight = true;
        hint.tooltip = `BioLint: score ${a.score}/100 — hover for full thermodynamics`;
        out.push(hint);
        if (out.length >= 200) { return out; }
      }
    }
    return out;
  }
}
