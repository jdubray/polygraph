// Theme loading (spec §3.6 / §4.6). Renderers reference tokens only — never
// hard-coded hex. CI greps renderer files for hex literals (see test).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '../../assets');

const REQUIRED = [
  'bg', 'panel', 'panel2', 'border', 'ink', 'muted',
  'ok', 'fail', 'accentA', 'accentB', 'warn', 'failBg', 'okBg',
  'fontSans', 'fontMono', 'radius', 'gap', 'rule'
];

/**
 * Load a theme by name ('dark' | 'light') with an optional override object
 * (parsed --tokens file). Fails loud on unknown theme or missing token.
 */
export function loadTheme(name = 'dark', override = null) {
  let base;
  try {
    base = JSON.parse(readFileSync(join(ASSETS, `tokens.${name}.json`), 'utf8'));
  } catch {
    throw new Error(`unknown theme "${name}" (expected dark | light) or unreadable tokens file`);
  }
  const tokens = override ? { ...base, ...override } : base;
  const missing = REQUIRED.filter((k) => tokens[k] == null);
  if (missing.length) throw new Error(`theme "${name}" missing tokens: ${missing.join(', ')}`);
  return tokens;
}

// Resolve a token name ("ok" | "accentA" | ...) to its color. Fails loud on an
// unknown name (spec §2.6) — a typo must error, not emit a silently-wrong color.
// A falsy ref falls back to the given token (default "ink").
export function color(tokens, ref, fallback = 'ink') {
  if (!ref) return tokens[fallback];
  const c = tokens[ref];
  if (c == null) throw new Error(`unknown theme token "${ref}" (renderers reference tokens only)`);
  return c;
}
