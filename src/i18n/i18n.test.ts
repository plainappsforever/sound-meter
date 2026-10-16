/**
 * @jest-environment node
 */
import { de } from './de';
import { en, type MessageKey } from './en';
import { getLanguage, makeT, messages, resolveLanguage, setLanguage, subscribeLanguage, translate } from './index';

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).map((p) => p.slice(1, -1)).sort();

describe('translations (A14: key parity)', () => {
  it('every locale defines exactly the keys of en', () => {
    for (const [lang, table] of Object.entries(messages)) {
      expect([lang, Object.keys(table).sort()]).toEqual([lang, Object.keys(en).sort()]);
    }
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
  });

  it('no string is empty and placeholders match between languages', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      for (const table of Object.values(messages)) {
        expect([key, table[key].trim() !== '']).toEqual([key, true]);
        expect([key, placeholders(table[key])]).toEqual([key, placeholders(en[key])]);
      }
    }
  });

  it('wording rule (SPEC §3.4, L26): no proof/legal/certified/compliant/violation/safe claims', () => {
    const forbidden = [
      /\bproof\b/i,
      /\blegal\b/i,
      /certified/i,
      /compliant/i,
      /violation/i,
      /\bsafe\b/i,
      /court-ready/i,
      /accurate to/i,
      /Beweis/i,
      /rechtssicher/i,
      /gerichtsfest/i,
      /zertifiziert/i,
      /Verstoß/i,
      /unbedenklich/i,
      /\bsicher\b/i,
    ];
    for (const table of Object.values(messages))
      for (const [key, text] of Object.entries(table))
        for (const re of forbidden) expect([key, re.test(text)]).toEqual([key, false]);
  });

  it('every level unit and the report title say "estimate"', () => {
    expect(en['meter.unit']).toContain('estimate');
    expect(de['meter.unit']).toContain('Schätzung');
    expect(en['report.title']).toContain('estimate');
    expect(de['report.title']).toContain('Schätzung');
    expect(en['report.footer']).toContain('not a calibrated');
  });
});

describe('language switching (template behaviour, React Compiler rule)', () => {
  afterEach(() => setLanguage('en'));

  it('returns a different translator function per language', () => {
    const t1 = makeT('en');
    const t2 = makeT('de');
    expect(t2).not.toBe(t1);
    expect(makeT('en')).toBe(t1);
    expect(t1('settings.title')).toBe('Settings');
    expect(t2('settings.title')).toBe('Einstellungen');
  });

  it('switching notifies subscribers once per change', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeLanguage(() => seen.push(makeT(getLanguage())('settings.title')));
    setLanguage('de');
    setLanguage('de');
    unsubscribe();
    setLanguage('en');
    expect(seen).toEqual(['Einstellungen']);
  });

  it('interpolates params and resolves device tags', () => {
    expect(translate('de', 'dose.niosh', { pct: '46' })).toBe('Geschätzte Dosis nach der NIOSH-Formel: 46 %');
    expect(resolveLanguage('system', 'de-AT')).toBe('de');
    expect(resolveLanguage('system', 'fr-FR')).toBe('en');
    expect(resolveLanguage('de', 'en-US')).toBe('de');
    expect(resolveLanguage('system', undefined)).toBe('en');
  });
});
