// Deterministic text measurement over the pinned metrics table (spec §4.5/§4.7).
// Pure function of assets/metrics.json — never reads a system font.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const METRICS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../assets/metrics.json'), 'utf8')
);

// Advance width of a single code point, in em units (metrics.unitsPerEm base).
function advance(cp, m) {
  if (m.advance != null) return m.advance; // monospace: constant
  return m.widths[cp] ?? m.default;
}

/**
 * Width of `str` in px. Options: { size, mono=false, bold=false }.
 */
export function measureText(str, { size = 16, mono = false, bold = false } = {}) {
  const m = mono ? METRICS.mono : METRICS.sans;
  let units = 0;
  for (const ch of String(str)) units += advance(ch.codePointAt(0), m);
  const px = (units / m.unitsPerEm) * size;
  return bold ? px * m.boldFactor : px;
}

/**
 * Greedy word-wrap to `maxWidth` px. Breaks on spaces; hard-breaks any single
 * word wider than maxWidth so nothing overflows (spec: no clipping). Returns
 * an array of line strings (never empty).
 */
export function wrapText(str, { size = 16, mono = false, bold = false, maxWidth }) {
  const words = String(str).split(/\s+/).filter(Boolean);
  if (!maxWidth || words.length === 0) return [String(str)];
  const opts = { size, mono, bold };
  const lines = [];
  let line = '';

  const pushHardBroken = (word) => {
    // Word alone exceeds maxWidth: break by character.
    let chunk = '';
    for (const ch of word) {
      if (chunk && measureText(chunk + ch, opts) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    return chunk; // remainder becomes the current line
  };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measureText(candidate, opts) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) { lines.push(line); line = ''; }
    if (measureText(word, opts) > maxWidth) {
      line = pushHardBroken(word);
    } else {
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/**
 * Truncate `str` with a trailing ellipsis so it fits within maxWidth px.
 * Returns the original string when it already fits.
 */
export function ellipsize(str, { size = 16, mono = false, bold = false, maxWidth }) {
  const s = String(str);
  if (!maxWidth || measureText(s, { size, mono, bold }) <= maxWidth) return s;
  const ell = '…';
  const budget = maxWidth - measureText(ell, { size, mono, bold });
  let out = '';
  for (const ch of s) {
    if (measureText(out + ch, { size, mono, bold }) > budget) break;
    out += ch;
  }
  return (out.trimEnd() || s[0]) + ell;
}

export { METRICS };
