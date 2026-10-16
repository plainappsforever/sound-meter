/**
 * @jest-environment node
 */
// SPEC §7: engines are pure TypeScript (no React/React Native/Expo imports), so they run in Node and can be ported 1:1
// to the native per-second fallback (D19) if P3 needs it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.ts$/.test(n) && !n.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('engine purity', () => {
  it('src/engine, src/i18n/translate.ts and src/lib/capture.ts import no React, React Native or Expo module', () => {
    const list = [...files(__dirname), join(__dirname, '../i18n/translate.ts'), join(__dirname, '../lib/capture.ts')];
    for (const f of list) {
      const imports = [...readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      const bad = imports.filter((i) => /^(react|react-native|expo|@expo)(\/|-|$)/.test(i) || i === '@/i18n' || i.startsWith('@/db') || i.startsWith('@/hooks'));
      expect([relative(join(__dirname, '../..'), f), bad]).toEqual([relative(join(__dirname, '../..'), f), []]);
    }
  });
});
