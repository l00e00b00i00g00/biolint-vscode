/**
 * hover.ts — thermodynamic hover provider (Tm SantaLucia, GC%, ΔG hairpin/dimer).
 * Works on bio languages + inline DNA inside py/ts/yaml.
 */
import * as vscode from 'vscode';
import { analyzePrimer } from './bio';
import { getConfig } from './config';

export class BioHoverProvider implements vscode.HoverProvider {
  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const cfg0 = getConfig();
    if (!cfg0.enableHover) { return undefined; }
    if (pos.line >= doc.lineCount) { return undefined; }
    // Audit 10/10: threshold follows the user's minPrimerLength setting.
    const re = new RegExp(`[ACGTUacgtuNn]{${Math.max(5, cfg0.minPrimerLength)},}`, 'g');
    const line = doc.lineAt(pos.line).text;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const start = m.index, end = m.index + m[0].length;
      const cursor = pos.character;
      if (cursor < start || cursor > end) { continue; }
      const token = m[0];
      if (new Set(token.toUpperCase()).size < 2) { continue; }
      // Audit fix: encode the hovered range so Optimize/RevComp act on the
      // hovered token even when the text cursor sits elsewhere.
      const range = {
        start: { line: pos.line, character: start },
        end: { line: pos.line, character: end },
      };
      return this.renderHover(token, range);
    }
    return undefined;
  }

  private renderHover(token: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Hover {
    const cfg = getConfig();
    const a = analyzePrimer(token, cfg.gcWarnLow, cfg.gcWarnHigh);
    const riskEmoji = a.foldRisk === 'high' ? '🔴' : a.foldRisk === 'medium' ? '🟠' : '🟢';
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = false;
    md.appendMarkdown(`### 🧬 BioLint Primer Analysis \`${a.length} nt · score ${a.score}/100\`\n\n`);
    md.appendMarkdown(`| Metric | Value |\n|---|---|\n`);
    md.appendMarkdown(`| **T<sub>m</sub>** (SantaLucia) | **${a.tm}°C** _(${a.tmMethod}, Wallace ${a.tmWallace}°C)_ |\n`);
    md.appendMarkdown(`| **GC content** | **${a.gcPct}%** ${a.gcFlag !== 'normal' ? `⚠️ _${a.gcFlag}_` : '✅'} \`${a.gcSpark}\` |\n`);
    md.appendMarkdown(`| **ΔG hairpin** | **${a.hairpinDG}** kcal/mol |\n`);
    md.appendMarkdown(`| **ΔG self-dimer** | **${a.selfDimerDG}** kcal/mol |\n`);
    md.appendMarkdown(`| **Folding risk** | ${riskEmoji} **${a.foldRisk.toUpperCase()}** |\n`);
    md.appendMarkdown(`| **3′ GC clamp** | ${a.gcClamp}/5 ${a.gcClamp >= 1 && a.gcClamp <= 2 ? '✅' : '⚠️'} |\n`);
    md.appendMarkdown(`| **Homopolymer** | max run ${a.maxHomopolymer} ${a.maxHomopolymer >= 5 ? '⚠️' : '✅'} |\n`);
    if (a.suggestions.length > 0) {
      md.appendMarkdown(`\n**Suggestions**\n\n`);
      for (const s of a.suggestions.slice(0, 4)) { md.appendMarkdown(`- ${s}\n`); }
    } else {
      md.appendMarkdown(`\n✅ Primer looks excellent for PCR.\n`);
    }
    const enc = encodeURIComponent(JSON.stringify({ seq: token, range }));
    md.appendMarkdown(`\n---\n`);
    md.appendMarkdown(`[⚡ Optimize this primer](command:biolint.optimizePrimer?${enc}) · `);
    md.appendMarkdown(`[🔁 Reverse complement](command:biolint.reverseComplement?${enc}) · `);
    md.appendMarkdown(`[📊 Sequence view](command:biolint.showSequenceView)`);
    return new vscode.Hover(md);
  }
}
