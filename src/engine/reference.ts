// Sourced reference values (SPEC F7, §7.8; RESEARCH §3.5). Every row names its source; secondary rows say so.
// Shown for orientation, never as a verdict about the user's situation (SPEC §3.4).
import type { MessageKey } from '@/i18n/en';

export type ReferenceGroup = 'everyday' | 'hearing' | 'night' | 'exposure';

export type ReferenceRow = {
  key: string;
  group: ReferenceGroup;
  labelKey: MessageKey;
  /** Level used for the "like …" line on Home (dB(A)); absent for rules without a single level. */
  levelDb?: number;
  sourceName: string;
  sourceUrl: string;
  /** True when the value comes from a secondary source (labelled in the UI/report). */
  secondary: boolean;
};

const NIDCD = { sourceName: 'NIDCD (NIH)', sourceUrl: 'https://www.nidcd.nih.gov/health/noise-induced-hearing-loss', secondary: false };

export const REFERENCE_ROWS: readonly ReferenceRow[] = [
  { key: 'library', group: 'everyday', labelKey: 'ref.secondary.library', levelDb: 40, sourceName: 'Commercial Acoustics', sourceUrl: 'https://commercial-acoustics.com/sound-advice/decibel-level-chart/', secondary: true },
  { key: 'conversation', group: 'everyday', labelKey: 'ref.nidcd.conversation', levelDb: 65, ...NIDCD },
  { key: 'motorcycle', group: 'everyday', labelKey: 'ref.nidcd.motorcycle', levelDb: 95, ...NIDCD },
  { key: 'concert', group: 'everyday', labelKey: 'ref.nidcd.concert', levelDb: 102, ...NIDCD },
  { key: 'siren', group: 'everyday', labelKey: 'ref.nidcd.siren', levelDb: 120, ...NIDCD },
  { key: 'below70', group: 'hearing', labelKey: 'ref.nidcd.below70', levelDb: 70, ...NIDCD },
  { key: 'above85', group: 'hearing', labelKey: 'ref.nidcd.above85', levelDb: 85, ...NIDCD },
  { key: 'apple80', group: 'hearing', labelKey: 'ref.apple.80', levelDb: 80, sourceName: 'Apple Support 102315', sourceUrl: 'https://support.apple.com/en-ke/102315', secondary: false },
  { key: 'who1999', group: 'night', labelKey: 'ref.who1999.bedroom', levelDb: 30, sourceName: 'WHO Guidelines for Community Noise 1999 (via IOA proceedings)', sourceUrl: 'https://www.ioa.org.uk/system/files/proceedings/d_fiumicelli_n_triner_world_health_organisation_who_guidelines_for_community_noise_-_a_help_or_a_hin.pdf', secondary: true },
  { key: 'who2009', group: 'night', labelKey: 'ref.who2009.lnight', levelDb: 40, sourceName: 'WHO Europe Night Noise Guidelines 2009', sourceUrl: 'https://www.who.int/europe/publications/i/item/9789289041737', secondary: false },
  { key: 'taLaerm', group: 'night', labelKey: 'ref.taLaerm.inside', levelDb: 25, sourceName: 'TA Lärm (Stadt Mannheim, LfU Bayern)', sourceUrl: 'https://www.lfu.bayern.de/laerm/laerm_allgemein/foliensammlung/gewerbelaerm/doc/g1.pdf', secondary: false },
  { key: 'niosh', group: 'exposure', labelKey: 'ref.niosh.rel', sourceName: 'CDC NIOSH', sourceUrl: 'https://www.cdc.gov/niosh/noise/about/noise.html', secondary: false },
  { key: 'osha', group: 'exposure', labelKey: 'ref.osha.pel', sourceName: 'OSHA 29 CFR 1910.95', sourceUrl: 'https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.95', secondary: false },
  { key: 'eu', group: 'exposure', labelKey: 'ref.eu.2003', sourceName: 'EU-OSHA, Directive 2003/10/EC', sourceUrl: 'https://osha.europa.eu/en/legislation/directives/82', secondary: false },
];

/** Rows printed in a night/case report (SPEC §7.8): WHO 1999 bedroom and TA Lärm (orientation only). */
export const NIGHT_REPORT_REFERENCES = REFERENCE_ROWS.filter((r) => r.key === 'who1999' || r.key === 'taLaerm');

/** The everyday row closest to a level ("Like normal conversation"), or null when none is within 6 dB. */
export function nearestEveryday(levelDb: number): ReferenceRow | null {
  let best: ReferenceRow | null = null;
  for (const r of REFERENCE_ROWS)
    if (r.group === 'everyday' && r.levelDb !== undefined && Math.abs(r.levelDb - levelDb) <= 6)
      if (!best || Math.abs(r.levelDb - levelDb) < Math.abs((best.levelDb ?? 0) - levelDb)) best = r;
  return best;
}
