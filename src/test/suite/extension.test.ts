/** extension.test.ts — end-to-end: activation, diagnostics, commands, config. */
import * as assert from 'assert';
import * as vscode from 'vscode';

function codeOf(d: vscode.Diagnostic): string | undefined {
  return typeof d.code === 'string' ? d.code : (d.code as { value?: string } | undefined)?.value;
}

async function waitFor(
  pred: () => boolean, timeoutMs = 15000, stepMs = 250,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) { return; }
    if (Date.now() - start > timeoutMs) { throw new Error('timed out waiting for condition'); }
    await new Promise(r => setTimeout(r, stepMs));
  }
}

suite('BioLint extension', () => {
  test('activates on bio files', async () => {
    const ext = vscode.extensions.getExtension('bioguard.biolint-vscode');
    assert.ok(ext, 'extension not found');
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('lints demo.fasta with exact-code diagnostics', async () => {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, 'examples workspace not open');
    const uri = vscode.Uri.joinPath(folders[0].uri, 'demo.fasta');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await waitFor(() => vscode.languages.getDiagnostics(uri).some(d => d.source === 'biolint'));
    const diags = vscode.languages.getDiagnostics(uri).filter(d => d.source === 'biolint');
    const codes = new Set(diags.map(codeOf));
    assert.ok(codes.has('biolint.invalid-base'), 'expected invalid-base (X/B demo record)');
    assert.ok(codes.has('biolint.bioguard-flagged'), 'expected flagged DEMO marker');
    assert.ok(codes.has('biolint.gc-content'), 'expected GC warning (AT-rich record)');
    // Every diagnostic must sit on non-empty, in-bounds ranges.
    for (const d of diags) {
      assert.ok(d.range.end.isAfter(d.range.start), `empty range: ${d.message}`);
      assert.ok(d.range.start.line < doc.lineCount, 'range out of bounds');
    }
  });

  test('registers all commands', async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const c of [
      'biolint.showSequenceView', 'biolint.exportCertificate', 'biolint.verifyHash',
      'biolint.installPreCommitHook', 'biolint.switchMode', 'biolint.optimizePrimer',
      'biolint.reverseComplement', 'biolint.checkPrimerPair', 'biolint.optimizeCodons',
      'biolint.designPrimers', 'biolint.diffConstructs', 'biolint.openAuditLog',
    ]) {
      assert.ok(cmds.includes(c), `missing command ${c}`);
    }
  });

  test('default config is local/offline', () => {
    const cfg = vscode.workspace.getConfiguration('biolint');
    assert.strictEqual(cfg.get('mode'), 'local');
    assert.strictEqual(cfg.get('enableLocalThreatDb'), true);
  });

  test('aux commands execute cleanly', async () => {
    await vscode.commands.executeCommand('biolint.showOutput');
  });
});
