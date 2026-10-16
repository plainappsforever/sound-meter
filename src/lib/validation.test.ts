import { NAME_MAX, TEXT_MAX, cleanText, validateCase } from './validation';

describe('validateCase', () => {
  it('trims and accepts a valid case', () => {
    expect(validateCase({ name: '  Flat above  ', address: ' Main St 1 ', notes: '' })).toEqual({
      ok: true,
      value: { name: 'Flat above', address: 'Main St 1', notes: '' },
    });
  });

  it('rejects a missing or too long name and too long texts', () => {
    expect(validateCase({ name: '   ', address: '', notes: '' })).toEqual({ ok: false, error: 'name-required' });
    expect(validateCase({ name: 'x'.repeat(NAME_MAX + 1), address: '', notes: '' })).toEqual({ ok: false, error: 'name-too-long' });
    expect(validateCase({ name: 'ok', address: '', notes: 'x'.repeat(TEXT_MAX + 1) })).toEqual({ ok: false, error: 'text-too-long' });
  });

  it('cleanText trims and limits', () => {
    expect(cleanText('  a  ')).toBe('a');
    expect(cleanText('abc', 2)).toBeNull();
  });
});
