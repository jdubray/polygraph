// Generates polyviz/assets/metrics.json — the pinned text-metrics table.
//
// Determinism (spec §4.7) is won here: measureText() must be a pure function of
// a checked-in table, identical on every machine, never reading a system font.
//
// Source: Adobe Core "Helvetica" AFM advance widths (units per 1000 em) — the
// canonical, publicly documented width set for the tokens' primary sans family
// ("Helvetica, Arial, sans-serif"). Monospace uses a constant advance (600/1000),
// matching Courier / DejaVu Sans Mono. Bold is approximated with a per-family
// scale factor for M1; a parsed table from the bundled shipping font replaces
// this at M5 (PNG export), when raster and measurement must share one font file.
//
// Run:  node polyviz/assets/gen-metrics.mjs   (regenerates metrics.json)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Helvetica advance widths for printable ASCII 32..126, in order.
const ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // 32-47
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 48-63
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // 64-79
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,  // 80-95
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,  // 96-111
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584        // 112-126
];

// Non-ASCII glyphs that appear in the figures (mostly rendered in mono, so the
// sans values below are conservative fallbacks used only if they land in sans).
const EXTRA = {
  0x00d7: 584, // ×  multiplication
  0x00b7: 278, // ·  middle dot
  0x2013: 556, // –  en dash
  0x2014: 1000, // — em dash
  0x2018: 222, // '  left single quote
  0x2019: 222, // '  right single quote (ACK'D)
  0x201c: 333, // "  left double quote
  0x201d: 333, // "  right double quote
  0x2192: 1000, // → rightwards arrow
  0x2208: 549, // ∈  element of
  0x2227: 604, // ∧  logical and
  0x2260: 549, // ≠  not equal
  0x2713: 600, // ✓  check mark
  0x2717: 600  // ✗  ballot x
};

const widths = {};
for (let i = 0; i < ASCII.length; i++) widths[32 + i] = ASCII[i];
for (const [cp, w] of Object.entries(EXTRA)) widths[cp] = w;

const metrics = {
  _provenance:
    'Adobe Core Helvetica AFM advance widths (per-1000 em) for sans; monospace = constant 600/1000 ' +
    '(Courier / DejaVu Sans Mono). Deterministic checked-in table; measureText is a pure function of ' +
    'this file. Bold approximated by boldFactor for M1; replaced by a parsed table from the bundled ' +
    'font at M5. See polyviz spec §4.5 / §4.7. Regenerate with assets/gen-metrics.mjs.',
  sans: { unitsPerEm: 1000, default: 556, boldFactor: 1.04, widths },
  mono: { unitsPerEm: 1000, default: 600, boldFactor: 1.0, advance: 600 }
};

// Sort width keys numerically for a canonical, diff-stable file.
const sortedWidths = {};
for (const k of Object.keys(widths).map(Number).sort((a, b) => a - b)) sortedWidths[k] = widths[k];
metrics.sans.widths = sortedWidths;

const out = join(dirname(fileURLToPath(import.meta.url)), 'metrics.json');
writeFileSync(out, JSON.stringify(metrics, null, 2) + '\n');
console.log(`wrote ${out} — ${Object.keys(sortedWidths).length} sans glyphs`);
