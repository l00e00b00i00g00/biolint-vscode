# 🧬 BioLint-VSCode — DNA Linter for Synthetic Biology

Real-time linting, thermodynamic analysis and biosafety screening for DNA sequences, right inside VS Code. Open-core, local-first, enterprise-ready.

## Features

| Signal | Severity | What it catches |
|---|---|---|
| 🔴 Critical | Error | Restricted-agent pattern (`REJECTED` / `FLAGGED_FOR_REVIEW`) with regulation ref (IIGS / CDC) · GenBank CDS out of bounds |
| 🟠 Thermodynamic | Warning | Abnormal GC%, hairpin ΔG (stem highlighted), self-dimer ΔG, broken ORFs · GenBank LOCUS/CDS/translation mismatches |
| 🔵 Optimization | Info | GC clamp, homopolymers, ambiguous N, primer length → 1-click fixes · low-CAI ORFs → codon optimization |

- **Hover provider** — Tm (SantaLucia 1998, configurable salt/primer conditions), GC%, ΔG hairpin/self-dimer, folding risk, GC clamp, 1-click *Optimize* / *Reverse complement*.
- **Inlay hints** — inline `Tm · GC%` after DNA runs (toggle `biolint.enableInlayHints`).
- **Primer-pair QC** (`BioLint: QC Primer Pair`) — ΔTm matching + heterodimer ΔG from two selections or quickpick.
- **Codon optimization** (`BioLint: Optimize Codons for Host`) — CAI + rare codons for *E. coli* / yeast / human (custom JSON tables supported), blue hints on low-CAI ORFs.
- **GenBank validation** — LOCUS length vs ORIGIN, CDS bounds/start/stop/frame, `/translation` agreement (both strands, `join()` supported).
- **Codon lens** — hover any ORF-length DNA for CAI context; status bar shows live `nt · GC% · verdict` per file.
- **Construct diff** (`BioLint: Diff Two Constructs`) — Needleman-Wunsch mutation report (SNP/indel) with click-to-reveal in both files.
- **Audit trail** — every screening appended to a local JSONL log (`Open/Export Screening Audit Log`); per-file timings in the BioLint output channel (`biolint.debug`).
- **French localization** — commands, walkthrough and settings fully translated (`package.nls.fr`).
- **Hybrid mode** (status bar): `Local (offline)` = embedded engine + `.bioguard/` lists, no data leaves the machine · `Enterprise` = OAuth2/JWT → `app.bioguard.ai` threat feed + Command Center deep-links.
- **Sequence visualizer** (`BioLint: Show Sequence Visualizer`) — ORF map, restriction sites (24 enzymes), GC profile, biosafety verdict, certificate export, SynthFlow Studio bridge.
- **Compliance** — right-click any `.fa/.gb/.fastq/.yaml/.py/.ts` → *Export Compliance Certificate (SHA-256)* / *Verify File Hash*.
- **Guardrails** — `BioLint: Install Git Pre-commit Biosafety Hook` blocks commits containing `REJECTED` patterns (works offline, air-gapped friendly).

## Supported files

`.fa .fasta .fna .ffn .faa .frn` · `.gb .gbk .genbank .gbf` · `.fastq .fq` · inline DNA (≥15 nt) in `.yaml .json .py .ts .tsx .js .md .txt .csv`

## Quick start

```bash
npm install
npm run compile
npm run test:unit
# launch: F5 (Extension Development Host) — open examples/demo.fasta
# or follow the built-in walkthrough: Command Palette → "Get Started: Open Walkthrough… → BioLint"
```

Package offline (`air-gapped` enterprise deploys):

```bash
npm run package:vsix
code --install-extension biolint-vscode-1.0.0.vsix
```

## Privacy model

- **Local mode**: 100% offline. Sequences never leave the machine (embedded engine + `.bioguard/` lists).
- **Enterprise mode**: screening calls `POST {enterpriseUrl}/api/v1/screen` with file length, SHA-256 and up to the first 50 kb of sequence for cloud verdicts. Only enable on networks where transmitting synthesis-candidate sequences to your BioGuard tenant is approved.

## Configuration (`biolint.*`)

| Key | Default | Meaning |
|---|---|---|
| `mode` | `local` | `local` / `enterprise` |
| `enterpriseUrl` | `https://app.bioguard.ai` | Command Center + threat feed |
| `synthFlowStudioUrl` | `https://studio.synthflow.ai` | Visual-design bridge |
| `gc.warnLow / warnHigh` | `35 / 65` | GC% healthy window |
| `minPrimerLength` | `15` | Min DNA run linted in code/YAML |
| `minOrfLength` | `90` | Min ORF reported in visualizer |
| `enableHover` | `true` | Thermodynamic hovers |
| `enableLocalThreatDb` | `true` | Screen `.bioguard/` lists |
| `debounceMs` | `350` | Re-lint delay |

## Local threat lists (`.bioguard/`)

Drop curated JSON next to your repo — auto-loaded, offline:

```json
[
  { "pattern": "ACGTACGTACGTACGTACGT", "name": "CUSTOM-001 sample-block",
    "regulation": "CUSTOM", "severity": "FLAGGED_FOR_REVIEW",
    "description": "Example entry" }
]
```

Bundled patterns are **synthetic DEMO markers** (not real pathogen sequence) for exercising the flagged/rejected paths and CI.

## Commands

- `BioLint: Show Sequence Visualizer`
- `BioLint: Export Compliance Certificate (SHA-256)` / `Verify File Hash`
- `BioLint: Install Git Pre-commit Biosafety Hook`
- `BioLint: Switch Mode (Local / Enterprise)` · Login / Logout
- `BioLint: Optimize This Primer` · `Generate Reverse Complement`
- `BioLint: QC Primer Pair (ΔTm + Heterodimer)` · `Optimize Codons for Host (CAI)`
- `BioLint: Open Enterprise Command Center` · `Open in SynthFlow Studio`

## Distribution

- **Marketplace**: `code --install-extension bioguard.biolint-vscode`
- **Open VSX** (VSCodium / Theia / Gitpod): same package, `npx ovsx publish`
- **Enterprise / air-gapped**: `.vsix` from GitHub Releases → `code --install-extension biolint-vscode-x.y.z.vsix` (mass-deploy via fleet tools)
- **CI**: `.github/workflows/ci.yml` compiles, unit-tests, headless smoke-lints the examples (exact-offset check), packages the `.vsix` and attaches it to `v*` tag releases.

## License

Extension client: **Apache-2.0** (see `LICENSE`). Enterprise threat feed & backend: commercial SaaS (open-core model).
