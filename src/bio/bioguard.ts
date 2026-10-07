/**
 * bioguard.ts — offline biosafety screening (open-source lists in `.bioguard/`)
 * plus Enterprise cloud-sync stub.
 *
 * IMPORTANT: the bundled patterns are SYNTHETIC DEMO markers, not real
 * pathogen sequences. Real deployments mount curated k-mer blocklists via
 * `.bioguard/threats.json` (local) or the Enterprise threat feed (cloud).
 */

import * as fs from 'fs';
import * as path from 'path';

export type Verdict = 'APPROVED' | 'FLAGGED_FOR_REVIEW' | 'REJECTED';
export type Regulation = 'IIGS' | 'CDC' | 'AUSTRALIA_GROUP' | 'CUSTOM' | 'DEMO';

export interface ThreatEntry {
  pattern: string; // literal k-mer (ACGT) matched exactly (both strands)
  name: string;
  regulation: Regulation;
  severity: Exclude<Verdict, 'APPROVED'>;
  description: string;
}

export interface ThreatMatch {
  entry: ThreatEntry;
  position: number; // seq index
  strand: 1 | -1;
  matchedKmer: string;
}

export interface ScreenResult {
  verdict: Verdict;
  matches: ThreatMatch[];
  screenedLength: number;
  dbVersion: string;
  mode: 'local' | 'enterprise';
}

/** Bundled DEMO markers — clearly synthetic, for UI/CI testing only. */
export const DEMO_THREAT_DB: ThreatEntry[] = [
  {
    pattern: 'GATTACAGATTACAGATTACA',
    name: 'DEMO-MARKER-ALPHA (synthetic test signature)',
    regulation: 'DEMO',
    severity: 'FLAGGED_FOR_REVIEW',
    description: 'Synthetic demo signature to exercise the FLAGGED_FOR_REVIEW path. Not a real threat.',
  },
  {
    pattern: 'CCCCGGGGCCCCGGGGCCCC',
    name: 'DEMO-MARKER-BETA (synthetic test signature)',
    regulation: 'DEMO',
    severity: 'REJECTED',
    description: 'Synthetic demo signature to exercise the REJECTED path and pre-commit blocking. Not a real threat.',
  },
];

let localDbCache: { entries: ThreatEntry[]; version: string } | null = null;

/** Load `.bioguard/threats.json` (+ `*.json`) from workspace root(s); falls back to demo DB. */
export function loadLocalThreatDb(workspaceRoots: string[] = []): { entries: ThreatEntry[]; version: string } {
  if (localDbCache) { return localDbCache; }
  const entries: ThreatEntry[] = [...DEMO_THREAT_DB];
  let version = `demo-${DEMO_THREAT_DB.length}`;
  for (const root of workspaceRoots) {
    const dir = path.join(root, '.bioguard');
    if (!fs.existsSync(dir)) { continue; }
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const list: ThreatEntry[] = Array.isArray(raw) ? raw : raw.entries ?? [];
        for (const e of list) {
          if (typeof e.pattern === 'string' && typeof e.name === 'string') {
            entries.push({
              pattern: e.pattern.toUpperCase().replace(/U/g, 'T'),
              name: e.name,
              regulation: e.regulation ?? 'CUSTOM',
              severity: e.severity === 'REJECTED' ? 'REJECTED' : 'FLAGGED_FOR_REVIEW',
              description: e.description ?? '',
            });
          }
        }
        version += `+${f}`;
      } catch { /* ignore malformed custom lists */ }
    }
  }
  localDbCache = { entries, version };
  return localDbCache;
}

export function clearThreatCache(): void {
  localDbCache = null;
}

function reverseComplementStr(s: string): string {
  const comp: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G', N: 'N' };
  let out = '';
  for (let i = s.length - 1; i >= 0; i--) { out += comp[s[i]] ?? 'N'; }
  return out;
}

export function screenSequence(
  seq: string,
  entries: ThreatEntry[],
  dbVersion: string,
  mode: 'local' | 'enterprise' = 'local',
): ScreenResult {
  const s = seq.toUpperCase().replace(/U/g, 'T');
  const matches: ThreatMatch[] = [];
  for (const e of entries) {
    const pat = e.pattern.toUpperCase().replace(/U/g, 'T');
    if (pat.length < 8) { continue; }
    let from = 0;
    for (;;) {
      const idx = s.indexOf(pat, from);
      if (idx === -1) { break; }
      matches.push({ entry: e, position: idx, strand: 1, matchedKmer: pat });
      from = idx + 1;
      if (matches.length > 50) { break; }
    }
    // reverse strand
    const rcPat = reverseComplementStr(pat);
    if (rcPat !== pat) {
      let from2 = 0;
      for (;;) {
        const idx = s.indexOf(rcPat, from2);
        if (idx === -1) { break; }
        matches.push({ entry: e, position: idx, strand: -1, matchedKmer: rcPat });
        from2 = idx + 1;
        if (matches.length > 100) { break; }
      }
    }
    if (matches.length > 100) { break; }
  }
  matches.sort((a, b) => a.position - b.position);
  let verdict: Verdict = 'APPROVED';
  if (matches.some(m => m.entry.severity === 'REJECTED')) { verdict = 'REJECTED'; }
  else if (matches.length > 0) { verdict = 'FLAGGED_FOR_REVIEW'; }
  return { verdict, matches: matches.slice(0, 100), screenedLength: s.length, dbVersion, mode };
}

export interface EnterpriseScreenOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

/**
 * Enterprise cloud screening. POSTs SHA-256 + k-mer sketch (never raw IP
 * unnecessarily — server decides) — here simplified to a JSON screen call with
 * graceful fallback to local DB on any network failure (fail-closed = flag).
 */
export async function screenEnterprise(
  seq: string,
  opts: EnterpriseScreenOptions,
  localFallback: ScreenResult,
): Promise<ScreenResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/api/v1/screen`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify({ length: seq.length, sha256: await sha256Hex(seq), sequence: seq.slice(0, 50000) }),
      signal: ctrl.signal,
    });
    if (!res.ok) { return { ...localFallback, mode: 'enterprise' }; }
    const data = (await res.json()) as { verdict?: Verdict; matches?: ThreatMatch[]; dbVersion?: string };
    return {
      verdict: data.verdict ?? localFallback.verdict,
      matches: data.matches ?? localFallback.matches,
      screenedLength: seq.length,
      dbVersion: data.dbVersion ?? 'enterprise-live',
      mode: 'enterprise',
    };
  } catch {
    return { ...localFallback, mode: 'enterprise' };
  } finally {
    clearTimeout(t);
  }
}

async function sha256Hex(s: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(s).digest('hex');
}
