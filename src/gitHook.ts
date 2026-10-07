/**
 * gitHook.ts — installs a local `pre-commit` hook that blocks commits
 * containing REJECTED (restricted) sequence patterns.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const HOOK_MARKER = '# biolint-vscode biosafety hook';

/** Exported for tests / air-gapped reuse: the exact installed hook content. */
export function getHookScript(): string {
  return hookScript();
}

function hookScript(): string {
  // Audit fix: null-separated file list + spawnSync argv (no shell quoting),
  // so paths with spaces/quotes/newlines can't break or bypass the screen.
  return `#!/bin/sh
${HOOK_MARKER} — blocks commits with BioLint REJECTED patterns (offline, no data leaves machine).
node -e '
const fs=require("fs"),path=require("path"),cp=require("child_process");
function loadDb(root){
  const out=[];
  const dir=path.join(root,".bioguard");
  let files=[];
  try{files=fs.readdirSync(dir).filter(f=>f.endsWith(".json"));}catch{return out;}
  for(const f of files){
    try{const raw=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
      for(const e of (Array.isArray(raw)?raw:(raw.entries||[]))){
        if(e.pattern&&e.name)out.push({pattern:String(e.pattern).toUpperCase().replace(/U/g,"T"),name:e.name,severity:e.severity==="REJECTED"?"REJECTED":"FLAGGED_FOR_REVIEW"});
      }
    }catch{}
  }
  return out;
}
let root="";
try{root=cp.execSync("git rev-parse --show-toplevel",{encoding:"utf8"}).trim();}catch{process.exit(0);}
const demo=[
  {pattern:"CCCCGGGGCCCCGGGGCCCC",name:"DEMO-MARKER-BETA (synthetic)",severity:"REJECTED"},
  {pattern:"GATTACAGATTACAGATTACA",name:"DEMO-MARKER-ALPHA (synthetic)",severity:"FLAGGED_FOR_REVIEW"},
];
const db=[...demo,...loadDb(root)];
const SEQ_EXT=/\\.(fa|fasta|fna|ffn|faa|frn|gb|gbk|genbank|gbf|fastq|fq|yaml|yml|py|ts|tsx|js|json)$/i;
let rawList;
try{rawList=cp.execSync("git diff --cached --name-only -z --diff-filter=ACM",{encoding:"buffer"});}catch{process.exit(0);}
const files=rawList.toString("utf8").split("\\0").filter(f=>f&&SEQ_EXT.test(f));
const blocked=[], flagged=[];
for(const f of files){
  const shown=cp.spawnSync("git",["show",":"+f],{encoding:"utf8"});
  if(shown.status!==0||typeof shown.stdout!=="string")continue;
  const seq=shown.stdout.toUpperCase().replace(/U/g,"T");
  for(const e of db){
    if(e.pattern.length>=8&&seq.includes(e.pattern)){
      if(e.severity==="REJECTED")blocked.push(f+" :: "+e.name);
      else flagged.push(f+" :: "+e.name);
    }
  }
  if(blocked.length+flagged.length>100)break;
}
if(blocked.length){
  console.error("\\n\\u26D4 BioLint pre-commit BLOCKED \\u2014 REJECTED biosafety pattern(s):");
  for(const b of blocked)console.error("   - "+b);
  console.error("\\nResolve via the BioLint Problems panel / Command Center review before committing.\\nTo bypass (NOT recommended, audited): git commit --no-verify\\n");
  process.exit(1);
}
if(flagged.length){
  console.error("\\n\\u26A0\\uFE0F  BioLint advisory \\u2014 FLAGGED_FOR_REVIEW pattern(s):");
  for(const f of flagged.slice(0,20))console.error("   - "+f);
  console.error("");
}
'
`;
}

function gitRootFor(uri?: vscode.Uri): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (uri) {
    const f = vscode.workspace.getWorkspaceFolder(uri);
    if (f) { return f.uri.fsPath; }
    if (fs.existsSync(path.dirname(uri.fsPath))) {
      try {
        const r = execSync('git rev-parse --show-toplevel', { cwd: path.dirname(uri.fsPath) }).toString().trim();
        if (r) { return r; }
      } catch { /* not a repo */ }
    }
  }
  if (folders?.length) {
    for (const f of folders) {
      if (fs.existsSync(path.join(f.uri.fsPath, '.git'))) { return f.uri.fsPath; }
    }
    return folders[0].uri.fsPath;
  }
  return undefined;
}

export async function cmdInstallPreCommitHook(uri?: vscode.Uri): Promise<void> {
  const root = gitRootFor(uri ?? vscode.window.activeTextEditor?.document.uri);
  if (!root) {
    vscode.window.showErrorMessage('BioLint: no workspace folder found — open a git repository first.');
    return;
  }
  let toplevel = root;
  try { toplevel = execSync('git rev-parse --show-toplevel', { cwd: root }).toString().trim() || root; }
  catch { /* root is not yet a repo */ }
  if (!fs.existsSync(path.join(toplevel, '.git'))) {
    const init = await vscode.window.showWarningMessage(
      `BioLint: ${toplevel} is not a git repository. Initialize one?`,
      'git init', 'Cancel',
    );
    if (init !== 'git init') { return; }
    try { execSync('git init', { cwd: toplevel }); }
    catch (e) { vscode.window.showErrorMessage(`BioLint: git init failed: ${e}`); return; }
  }
  const hooksDir = path.join(toplevel, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-commit');
  let existing = '';
  if (fs.existsSync(hookPath)) { existing = fs.readFileSync(hookPath, 'utf8'); }
  if (existing.includes(HOOK_MARKER)) {
    vscode.window.showInformationMessage('BioLint: pre-commit biosafety hook already installed (up to date).');
    return;
  }
  const script = hookScript();
  if (existing.trim().length > 0) {
    // Append, preserving the user's existing hook.
    fs.writeFileSync(hookPath, existing.replace(/\s*$/, '\n') + '\n' + script);
    vscode.window.showInformationMessage('BioLint: biosafety check appended to your existing pre-commit hook.');
  } else {
    fs.writeFileSync(hookPath, script);
    vscode.window.showInformationMessage('⛔ BioLint: pre-commit biosafety hook installed — commits with REJECTED patterns will now be blocked.');
  }
  try { fs.chmodSync(hookPath, 0o755); } catch { /* windows */ }
}
