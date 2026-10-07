/** restriction.ts — common Type II restriction recognition sites. */

export interface RestrictionEnzyme {
  name: string;
  site: string; // 5'->3' recognition (palindromic unless noted)
  cutAfter: number; // cut position on top strand (for display)
  overhang: 'blunt' | "5'" | "3'";
}

export const ENZYMES: RestrictionEnzyme[] = [
  { name: 'EcoRI', site: 'GAATTC', cutAfter: 1, overhang: "5'" },
  { name: 'BamHI', site: 'GGATCC', cutAfter: 1, overhang: "5'" },
  { name: 'HindIII', site: 'AAGCTT', cutAfter: 1, overhang: "5'" },
  { name: 'NotI', site: 'GCGGCCGC', cutAfter: 2, overhang: "5'" },
  { name: 'XhoI', site: 'CTCGAG', cutAfter: 1, overhang: "5'" },
  { name: 'NcoI', site: 'CCATGG', cutAfter: 1, overhang: "5'" },
  { name: 'NdeI', site: 'CATATG', cutAfter: 2, overhang: "5'" },
  { name: 'XbaI', site: 'TCTAGA', cutAfter: 1, overhang: "5'" },
  { name: 'SpeI', site: 'ACTAGT', cutAfter: 1, overhang: "5'" },
  { name: 'PstI', site: 'CTGCAG', cutAfter: 5, overhang: "3'" },
  { name: 'SalI', site: 'GTCGAC', cutAfter: 1, overhang: "5'" },
  { name: 'SmaI', site: 'CCCGGG', cutAfter: 3, overhang: 'blunt' },
  { name: 'KpnI', site: 'GGTACC', cutAfter: 5, overhang: "3'" },
  { name: 'SacI', site: 'GAGCTC', cutAfter: 5, overhang: "3'" },
  { name: 'SphI', site: 'GCATGC', cutAfter: 5, overhang: "3'" },
  { name: 'ApaI', site: 'GGGCCC', cutAfter: 5, overhang: "3'" },
  { name: 'AgeI', site: 'ACCGGT', cutAfter: 1, overhang: "5'" },
  { name: 'NheI', site: 'GCTAGC', cutAfter: 1, overhang: "5'" },
  { name: 'BglII', site: 'AGATCT', cutAfter: 1, overhang: "5'" },
  { name: 'ClaI', site: 'ATCGAT', cutAfter: 2, overhang: "5'" },
  { name: 'DraI', site: 'TTTAAA', cutAfter: 3, overhang: 'blunt' },
  { name: 'SnaBI', site: 'TACGTA', cutAfter: 3, overhang: 'blunt' },
  { name: 'EcoRV', site: 'GATATC', cutAfter: 3, overhang: 'blunt' },
  { name: 'PvuII', site: 'CAGCTG', cutAfter: 3, overhang: 'blunt' },
];

export interface RestrictionHit {
  enzyme: string;
  site: string;
  position: number; // 0-based seq index
  overhang: RestrictionEnzyme['overhang'];
}

/** Find all recognition sites (both strands — sites are palindromic so one scan suffices). */
export function findRestrictionSites(seq: string, enzymes: RestrictionEnzyme[] = ENZYMES): RestrictionHit[] {
  const s = seq.toUpperCase().replace(/U/g, 'T');
  const hits: RestrictionHit[] = [];
  for (const e of enzymes) {
    let from = 0;
    for (;;) {
      const idx = s.indexOf(e.site, from);
      if (idx === -1) { break; }
      hits.push({ enzyme: e.name, site: e.site, position: idx, overhang: e.overhang });
      from = idx + 1;
    }
  }
  return hits.sort((a, b) => a.position - b.position);
}
