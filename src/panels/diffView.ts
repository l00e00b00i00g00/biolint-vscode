/**
 * panels/diffView.ts — construct-vs-construct mutation report (v1.2.0).
 * Needleman-Wunsch alignment → SNP/indel table with click-to-reveal in both files.
 */
import * as vscode from 'vscode';
import { extractSegments, stripToPure, alignConstructs, Variant } from '../bio';
import { getConfig } from '../config';

interface DiffSide {
  uri: vscode.Uri;
  recordId: string;
  pure: string;
  docOffsets: number[]; // pure index → document offset
}

export class DiffPanel {
  private static current: vscode.WebviewPanel | undefined;

  static async run(ctx: vscode.ExtensionContext): Promise<void> {
    const a = await pickSide('Select FIRST construct (A)');
    if (!a) { return; }
    const b = await pickSide('Select SECOND construct (B)', a.uri);
    if (!b) { return; }
    if (a.uri.toString() === b.uri.toString() && a.recordId === b.recordId) {
      vscode.window.showWarningMessage('BioLint: pick two different records to diff.');
      return;
    }
    const res = alignConstructs(a.pure, b.pure);
    this.show(ctx, a, b, res.variants, res.identity, res.alignedLength, res.approximate, res.truncated);
  }

  private static show(
    ctx: vscode.ExtensionContext, a: DiffSide, b: DiffSide,
    variants: Variant[], identity: number, alignedLength: number,
    approximate: boolean, truncated: boolean,
  ): void {
    if (this.current) { this.current.dispose(); }
    const panel = vscode.window.createWebviewPanel(
      'biolintDiffView', `BioLint diff: ${shortName(a.uri.fsPath)} ↔ ${shortName(b.uri.fsPath)}`,
      vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true },
    );
    this.current = panel;
    ctx.subscriptions.push(panel);
    panel.onDidDispose(() => { if (this.current === panel) { this.current = undefined; } });
    panel.webview.onDidReceiveMessage(async msg => {
      if (msg?.command === 'reveal' && typeof msg.offset === 'number' && typeof msg.file === 'string') {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.file));
          const ed = await vscode.window.showTextDocument(doc, { preview: false });
          const off = Math.max(0, Math.min(msg.offset, doc.getText().length));
          const pos = doc.positionAt(off);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          ed.selection = new vscode.Selection(pos, pos);
        } catch { /* file moved — ignore */ }
      }
    });
    panel.webview.html = this.html(a, b, variants, identity, alignedLength, approximate, truncated);
  }

  private static html(
    a: DiffSide, b: DiffSide, variants: Variant[],
    identity: number, alignedLength: number, approximate: boolean, truncated: boolean,
  ): string {
    const data = JSON.stringify({
      a: { file: a.uri.toString(), id: a.recordId, len: a.pure.length, docOffsets: a.docOffsets.slice(0, 20000) },
      b: { file: b.uri.toString(), id: b.recordId, len: b.pure.length, docOffsets: b.docOffsets.slice(0, 20000) },
      variants: variants.slice(0, 200),
      identity: Math.round(identity * 1000) / 10,
      alignedLength, approximate, truncated, total: variants.length,
    }).replace(/</g, '\\u003c');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
.card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:10px 12px;margin:10px 0;background:var(--vscode-sideBar-background)}
table{border-collapse:collapse;font-size:12px;width:100%}td,th{border-bottom:1px solid var(--vscode-panel-border);padding:3px 8px;text-align:left}
tr[data-a]{cursor:pointer}tr[data-a]:hover{background:var(--vscode-list-hoverBackground)}
.mono{font-family:var(--vscode-editor-font-family)}
.badge{display:inline-block;padding:2px 10px;border-radius:20px;font-weight:600;font-size:12px;background:#1a7f37;color:#fff}
.badge.mid{background:#9a6700}.badge.low{background:#cf222e}
.legend{font-size:11px;opacity:.75}
</style></head><body><div id="app"></div>
<script>
const vscode = acquireVsCodeApi();
const d = ${data};
const app = document.getElementById('app');
const cls = d.identity >= 99 ? '' : d.identity >= 90 ? 'mid' : 'low';
const kindIcon = k => k==='snp' ? '🔁 SNP' : k==='insertion' ? '➕ insertion' : k==='deletion' ? '➖ deletion' : '🔀 complex';
let rows = d.variants.map((v,i)=>{
  const seq = v.kind==='snp' ? v.from+'→'+v.to : (v.kind==='insertion' ? '+'+v.to.slice(0,24) : '−'+v.from.slice(0,24));
  return '<tr data-a="'+i+'"><td>'+(i+1)+'</td><td>'+kindIcon(v.kind)+'</td><td class="mono">A:'+(v.posA+1)+'</td><td class="mono">B:'+(v.posB+1)+'</td><td class="mono">'+escapeHtml(seq)+'</td></tr>';
}).join('') || '<tr><td colspan="5">No differences — constructs are identical over the aligned region.</td></tr>';
app.innerHTML = '<div class="card"><h2>🧬 Construct diff <span class="badge '+cls+'">'+d.identity+'% identity</span></h2>'
  + '<div class="legend">A: '+escapeHtml(d.a.id)+' ('+d.a.len+' nt) · B: '+escapeHtml(d.b.id)+' ('+d.b.len+' nt) · aligned '+d.alignedLength+' columns'
  + (d.approximate ? ' · ⚠️ approximate (large sequences)' : '') + (d.truncated ? ' · showing first 200 of '+d.total : ' · '+d.total+' variant(s)') + '</div></div>'
  + '<div class="card"><table><tr><th>#</th><th>Type</th><th>Pos A</th><th>Pos B</th><th>Change</th></tr>'+rows+'</table>'
  + '<div class="legend">Click a row to reveal it in both files.</div></div>';
app.querySelectorAll('tr[data-a]').forEach(tr=>tr.addEventListener('click',()=>{
  const v = d.variants[parseInt(tr.dataset.a,10)];
  const offA = d.a.docOffsets[Math.min(v.posA, d.a.docOffsets.length-1)];
  const offB = d.b.docOffsets[Math.min(v.posB, d.b.docOffsets.length-1)];
  if(typeof offA==='number'){vscode.postMessage({command:'reveal',file:d.a.file,offset:offA});}
  if(typeof offB==='number'){setTimeout(()=>vscode.postMessage({command:'reveal',file:d.b.file,offset:offB}),150);}
}));
function escapeHtml(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
</script></body></html>`;
  }
}

async function pickSide(place: string, skip?: vscode.Uri): Promise<DiffSide | undefined> {
  const cfg = getConfig();
  const files = await vscode.workspace.findFiles('**/*.{fa,fasta,gb,gbk,fastq,fq,yaml,yml}', '**/node_modules/**', 100);
  const active = vscode.window.activeTextEditor?.document.uri;
  const items = files
    .filter(u => !skip || u.toString() !== skip.toString())
    .sort((x, y) => (x.toString() === active?.toString() ? -1 : 0) - (y.toString() === active?.toString() ? -1 : 0))
    .map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));
  if (items.length === 0) {
    vscode.window.showWarningMessage('BioLint: no sequence files found in the workspace.');
    return undefined;
  }
  const file = await vscode.window.showQuickPick(items, { placeHolder: place });
  if (!file) { return undefined; }
  const doc = await vscode.workspace.openTextDocument(file.uri);
  const segments = extractSegments(doc.fileName, doc.getText(), cfg.minPrimerLength)
    .filter(s => stripToPure(s.raw).pure.length > 0);
  if (segments.length === 0) {
    vscode.window.showWarningMessage('BioLint: no DNA found in that file.');
    return undefined;
  }
  let seg = segments[0];
  if (segments.length > 1) {
    const rec = await vscode.window.showQuickPick(
      segments.map(s => ({ label: s.id, description: `${s.raw.length} chars`, seg: s })),
      { placeHolder: `Record in ${file.label}` },
    );
    if (!rec) { return undefined; }
    seg = rec.seg;
  }
  const { pure, map } = stripToPure(seg.raw);
  return {
    uri: file.uri, recordId: seg.id, pure,
    docOffsets: map.map(rawIdx => seg.seqToDoc[rawIdx] ?? 0),
  };
}

function shortName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
