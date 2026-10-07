# Changelog

## 1.1.0 — 2026-10-07 (Design accuracy)
- Codon optimization: CAI + rare codons (E. coli/yeast/human built-ins, custom JSON override), optimizer command, blue CAI hints on complete ORFs
- Primer-pair QC command: ΔTm matching + heterodimer ΔG (selections or quickpick)
- GenBank annotation validation: LOCUS length, CDS bounds/start/stop/frame, /translation agreement, both strands + join()
- Configurable Tm conditions (primer nM, Na+/Mg++), inlay hints Tm·GC%
- Physics fix: hairpin/dimer alignment now scores plain-reverse (was reverse-complement → detected direct repeats)
- Hairpin warnings highlight the stem, not the whole primer

## 1.0.2 — 2026-10-07 (10/10 round)
- CI workflow: compile + unit tests + headless offset smoke-lint + `.vsix` artifact + tag release upload
- Get-started walkthrough (3 steps), editor title-bar visualizer button for bio files
- Snippets: `faprimer` / `faconstruct` (FASTA), `bgentry` (`.bioguard` JSON)
- Hover, quick-fixes and untitled detection now follow `biolint.minPrimerLength` (no threshold drift)

## 1.0.1 — 2026-10-07 (audit fixes)
- Fixed CRLF offset drift in FASTA/FASTQ parsers (diagnostics were misaligned on Windows files)
- Fixed pure/raw coordinate drift in thermo + biosafety highlights via `stripToPure()` (N/U/gaps/invalid bases)
- Fixed primer quick-fixes appearing on every line (whole-document text test)
- Hover Optimize/RevComp now act on the hovered token (range encoded in command args)
- Lint race guard (stale async runs dropped), GC-window cap (40 + summary), clear-on-skip for huge files
- Webview: click-to-reveal ORFs/sites wired with exact pure→document offsets
- Pre-commit hook hardened (NUL-separated list, argv spawn, no shell quoting)
- `npm test` wired to unit suite; test files excluded from `.vsix`; privacy model documented

## 1.0.0 — 2026-10-07
- Real-time DNA linter (FASTA / GenBank / FASTQ / inline YAML-py-TS): invalid bases, GC windows, hairpin/self-dimer ΔG, broken ORFs, BioGuard demo screening
- Hover thermodynamics (SantaLucia Tm, GC%, ΔG, GC clamp) + 1-click optimize / reverse complement + quick-fix lightbulbs
- Hybrid Local/Enterprise mode status bar, SecretStorage JWT, Command Center + SynthFlow Studio bridges
- Sequence visualizer webview (ORFs, 24 restriction enzymes, GC profile, verdict)
- SHA-256 compliance certificates (export/verify, explorer context)
- Offline git pre-commit biosafety hook generator
- Packaging: Marketplace + Open VSX + `.vsix` air-gapped flow
