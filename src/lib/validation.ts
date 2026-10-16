// Input validation for user-written texts (cases, sessions, events). Trimmed, length-limited; the engine never
// interprets them (they are escaped in report HTML and guarded in CSV).
export const NAME_MAX = 100;
export const TEXT_MAX = 2000;

export type CaseInput = { name: string; address: string; notes: string };
export type ValidationError = 'name-required' | 'name-too-long' | 'text-too-long';
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: ValidationError };

export function validateCase(raw: CaseInput): ValidationResult<CaseInput> {
  const name = raw.name.trim();
  const address = raw.address.trim();
  const notes = raw.notes.trim();
  if (!name) return { ok: false, error: 'name-required' };
  if (name.length > NAME_MAX) return { ok: false, error: 'name-too-long' };
  if (address.length > TEXT_MAX || notes.length > TEXT_MAX) return { ok: false, error: 'text-too-long' };
  return { ok: true, value: { name, address, notes } };
}

/** Free texts of an event/session: trimmed; null when too long. */
export function cleanText(raw: string, max = TEXT_MAX): string | null {
  const v = raw.trim();
  return v.length > max ? null : v;
}
