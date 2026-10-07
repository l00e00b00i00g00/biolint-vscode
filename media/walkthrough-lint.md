# 1 · See live DNA diagnostics

1. Open `examples/demo.fasta` in this workspace.
2. Open the **Problems** panel (`View → Problems`).
3. You should see:
   - 🔴 `DEMO-MARKER-ALPHA` flagged for review + invalid bases `X` / `B`
   - 🟠 AT-rich (GC 0%) and GC-rich (95.6%) windows, broken ORFs

Every underline maps to the exact base — including in `CRLF` files and next to `N`s.
