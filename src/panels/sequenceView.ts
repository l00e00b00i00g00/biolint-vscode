/**
 * panels/sequenceView.ts — interactive sequence visualizer webview:
 * ORF map, restriction sites, GC profile, biosafety verdict, MolStar bridge.
 */
import * as vscode from 'vscode';
import {
  extractSegments, gcContent, gcProfile, findORFs, findRestrictionSites,
  screenSequence, loadLocalThreatDb, analyzePrimer, stripToPure,
} from '../bio';
import { getConfig, tmOptionsOf } from '../config';

export class SequenceViewPanel {
  private static current: vscode.WebviewPanel | undefined;

  static show(ctx: vscode.ExtensionContext): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      vscode.window.showWarningMessage('BioLint: open a sequence file first.');
      return;
    }
    if (this.current) {
      this.current.reveal(vscode.ViewColumn.Beside);
      this.update(ed.document);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'biolintSequenceView', `BioLint: ${shortName(ed.document.fileName)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.current = panel;
    ctx.subscriptions.push(panel);
    panel.onDidDispose(() => { this.current = undefined; });
    panel.webview.onDidReceiveMessage(async msg => {
      if (msg?.command === 'exportCertificate') {
        await vscode.commands.executeCommand('biolint.exportCertificate');
      } else if (msg?.command === 'openStudio') {
        await vscode.commands.executeCommand('biolint.openSynthFlowStudio');
      } else if (msg?.command === 'openCommandCenter') {
        await vscode.commands.executeCommand('biolint.openCommandCenter');
      } else if (msg?.command === 'reveal' && typeof msg.offset === 'number') {
        // Audit fix: resolve the editor at message time (the one captured at
        // show() time may be stale) and clamp the offset into the document.
        const ed = vscode.window.activeTextEditor;
        if (!ed) { return; }
        const off = Math.max(0, Math.min(msg.offset, ed.document.getText().length));
        const pos = ed.document.positionAt(off);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        ed.selection = new vscode.Selection(pos, pos);
      }
    });
    this.update(ed.document);
  }

  static update(doc: vscode.TextDocument): void {
    if (!this.current) { return; }
    const cfg = getConfig();
    const segments = extractSegments(doc.fileName, doc.getText(), cfg.minPrimerLength);
    const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    const db = loadLocalThreatDb(roots);
    const payload = segments.slice(0, 8).map(seg => {
      const { pure, map } = stripToPure(seg.raw);
      const gc = gcContent(pure || 'A');
      const orfs = findORFs(pure, cfg.minOrfLength).slice(0, 40);
      const sites = findRestrictionSites(pure).slice(0, 60);
      const screen = screenSequence(pure, db.entries, db.version, 'local');
      const primer = pure.length <= 500 && pure.length > 0 ? analyzePrimer(pure, cfg.gcWarnLow, cfg.gcWarnHigh, tmOptionsOf(cfg)) : null;
      return {
        id: seg.id, length: pure.length,
        gcPct: Math.round(gc.gcPct * 10) / 10,
        gcTrack: gcProfile(pure.slice(0, 5000), 50, 25),
        orfs, sites,
        verdict: screen.verdict,
        flagged: screen.matches.map(m => ({ name: m.entry.name, position: m.position, regulation: m.entry.regulation, severity: m.entry.severity })),
        primer,
        recordOffset: seg.recordOffset,
        // pure index → exact document offset (capped: downsampled beyond 20k).
        pureToDoc: downsamplePureToDoc(pure, map, seg.seqToDoc),
      };
    });
    this.current.title = `BioLint: ${shortName(doc.fileName)}`;
    this.current.webview.html = this.html(payload);
  }

  private static html(records: unknown[]): string {
    const data = JSON.stringify(records).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
:root{color-scheme:dark light}
body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
h2{font-size:15px;margin:14px 0 6px}h3{font-size:12px;margin:10px 0 4px;text-transform:uppercase;letter-spacing:.06em;opacity:.8}
.card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:10px 12px;margin:10px 0;background:var(--vscode-sideBar-background)}
.badge{display:inline-block;padding:2px 10px;border-radius:20px;font-weight:600;font-size:12px}
.ok{background:#1a7f37;color:#fff}.warn{background:#9a6700;color:#fff}.bad{background:#cf222e;color:#fff}
table{border-collapse:collapse;font-size:12px;width:100%}td,th{border-bottom:1px solid var(--vscode-panel-border);padding:3px 8px;text-align:left}
.track{position:relative;height:22px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;margin:3px 0;overflow:hidden}
.orf{position:absolute;top:3px;height:16px;border-radius:3px;background:#0969da;opacity:.9;cursor:pointer}
.orf.rev{background:#8250df}.orf.broken{background:#cf222e}
.tick{position:absolute;top:0;width:2px;height:22px;background:#d4a017;cursor:pointer}
.gcbar{display:flex;align-items:flex-end;gap:1px;height:44px;margin:4px 0}
.gcbar div{flex:1;background:#1f883d;min-width:2px;border-radius:1px}
.btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:6px;padding:6px 12px;margin:4px 6px 4px 0;cursor:pointer;font-size:12px}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.mono{font-family:var(--vscode-editor-font-family);font-size:11px;word-break:break-all}
.legend{font-size:11px;opacity:.75}
</style></head><body>
<div id="app"></div>
<script>
const vscode = acquireVsCodeApi();
const records = ${data};
const app = document.getElementById('app');
function badge(v){return v==='REJECTED'?'<span class="badge bad">⛔ REJECTED</span>':v==='FLAGGED_FOR_REVIEW'?'<span class="badge warn">⚠️ FLAGGED FOR REVIEW</span>':'<span class="badge ok">✅ APPROVED</span>';}
if(!records.length){app.innerHTML='<div class="card">No DNA segments detected. Open a <b>.fa / .gb / .fastq / .yaml / .py / .ts</b> file with DNA runs (threshold: <b>biolint.minPrimerLength</b>).</div>';}
for(const r of records){
  const el=document.createElement('div');el.className='card';
  const maxOrf=Math.max(1,...r.orfs.map(o=>o.length));
  const orfTracks=[0,1,2].map(f=>{
    const items=r.orfs.filter(o=>o.strand===1&&o.frame===f).map(o=>{
      const l=(o.start/r.length*100).toFixed(2),w=Math.max(1,(o.length/r.length*100)).toFixed(2);
      return '<div class="orf'+(o.complete?'':' broken')+'" data-p="'+o.start+'" style="left:'+l+'%;width:'+w+'%" title="'+(o.complete?'ORF':'incomplete')+' +'+(f+1)+' '+o.start+'..'+o.end+' ('+o.length+' nt) — click to reveal in editor"></div>';
    }).join('');
    return '<div class="legend">frame +'+(f+1)+'</div><div class="track">'+items+'</div>';
  }).join('');
  const siteTicks=r.sites.map(s=>{
    const l=(s.position/r.length*100).toFixed(2);
    return '<div class="tick" data-p="'+s.position+'" style="left:'+l+'%" title="'+s.enzyme+' '+s.site+' @ '+(s.position+1)+' — click to reveal"></div>';
  }).join('');
  const gcBars=r.gcTrack.map(v=>{
    const h=Math.max(4,Math.round(v));const c=v<35?'#cf222e':v>65?'#9a6700':'#1f883d';
    return '<div style="height:'+h+'%;background:'+c+'" title="GC '+v.toFixed(1)+'%"></div>';
  }).join('');
  const orfRows=r.orfs.slice(0,10).map(o=>'<tr><td>'+(o.strand===1?'+':'−')+(o.frame+1)+'</td><td>'+(o.start+1)+'..'+o.end+'</td><td>'+o.length+' nt</td><td>'+(o.complete?'complete':'<b>incomplete</b>')+'</td><td class="mono">'+(o.protein||'').slice(0,24)+'…</td></tr>').join('')||'<tr><td colspan="5">No ORFs ≥ threshold — see Problems panel for broken-ORF hints.</td></tr>';
  const siteRows=r.sites.slice(0,12).map(s=>'<tr><td>'+s.enzyme+'</td><td class="mono">'+s.site+'</td><td>'+(s.position+1)+'</td><td>'+s.overhang+'</td></tr>').join('')||'<tr><td colspan="4">No common restriction sites.</td></tr>';
  const prim=r.primer?'<h3>Primer thermodynamics</h3><table><tr><th>Tm (SantaLucia)</th><td>'+r.primer.tm+' °C ('+r.primer.tmMethod+')</td><th>ΔG hairpin / dimer</th><td>'+r.primer.hairpinDG+' / '+r.primer.selfDimerDG+' kcal/mol ('+r.primer.foldRisk+')</td></tr><tr><th>GC clamp (3′)</th><td>'+r.primer.gcClamp+'/5</td><th>Score</th><td>'+r.primer.score+'/100</td></tr></table>':'';
  const flags=r.flagged.length?'<h3>Biosafety hits</h3><table>'+r.flagged.slice(0,8).map(f=>'<tr><td>'+f.severity+'</td><td>'+f.name+'</td><td>'+f.regulation+'</td><td>@'+(f.position+1)+'</td></tr>').join('')+'</table>':'';
  el.innerHTML='<h2>🧬 '+escapeHtml(r.id)+' <span class="legend">'+r.length+' nt · GC '+r.gcPct+'%</span> '+badge(r.verdict)+'</h2>'
    +'<h3>ORF map (forward frames)</h3>'+orfTracks
    +'<h3>Restriction sites</h3><div class="track">'+siteTicks+'</div>'
    +'<h3>GC profile (5′→3′)</h3><div class="gcbar">'+gcBars+'</div>'
    +prim+flags
    +'<h3>Top ORFs</h3><table><tr><th>Strand·frame</th><th>Coords</th><th>Length</th><th>Status</th><th>Peptide</th></tr>'+orfRows+'</table>'
    +'<h3>Restriction sites (first 12)</h3><table><tr><th>Enzyme</th><th>Site</th><th>Pos</th><th>End</th></tr>'+siteRows+'</table>'
    +'<div style="margin-top:8px"><button class="btn" data-cmd="exportCertificate">🛡️ Export compliance certificate</button>'
    +'<button class="btn" data-cmd="openStudio">🎨 Open in SynthFlow Studio</button>'
    +(r.verdict!=='APPROVED'?'<button class="btn" data-cmd="openCommandCenter">🏢 Command Center review</button>':'')
    +'</div><div class="legend">3D folding: lightweight linear view here — full MolStar 3D rendering available via SynthFlow Studio / Enterprise.</div>';
  el.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>vscode.postMessage({command:b.dataset.cmd})));
  el.querySelectorAll('[data-p]').forEach(n=>n.addEventListener('click',()=>{
    const p=parseInt(n.dataset.p||'0',10);
    const m=r.pureToDoc;
    const off=m && m.offsets.length ? m.offsets[Math.min(Math.floor(p/(m.step||1)),m.offsets.length-1)] : undefined;
    if(typeof off==='number'){vscode.postMessage({command:'reveal',offset:off});}
  }));
  app.appendChild(el);
}
function escapeHtml(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
</script></body></html>`;
  }
}

function shortName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function downsamplePureToDoc(pure: string, map: number[], seqToDoc: number[]): { offsets: number[]; step: number } {
  // pure[i] → document offset via raw map; downsample only beyond 20k positions.
  const full: number[] = new Array(pure.length);
  for (let i = 0; i < pure.length; i++) {
    const rawIdx = map[i] ?? 0;
    full[i] = seqToDoc[rawIdx] ?? 0;
  }
  if (full.length <= 20000) { return { offsets: full, step: 1 }; }
  const step = Math.ceil(full.length / 20000);
  const out: number[] = [];
  for (let i = 0; i < full.length; i += step) { out.push(full[i]); }
  return { offsets: out, step };
}
