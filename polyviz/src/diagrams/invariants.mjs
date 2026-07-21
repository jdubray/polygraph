// D2 — invariants ("the must-nevers"): the checked safety/liveness properties
// with pass/fail status. Source section: `invariants`. Reference: fig2 (bottom).
// Standalone, auto-sized: the panel grows with the number and length of the
// invariants; long text wraps (no clipping, spec §4.11 overflow).
//
// The panel body is factored into `invariantsPanel` so the model-card (D1+D2)
// can reuse it.

import { svg, text } from '../render/svg.mjs';
import { color } from '../render/theme.mjs';
import { chrome, panel, PAD, contentTop, wrapText, measureText } from '../render/components.mjs';

const WIDTH = 1200;
const IPAD = 36;        // panel inner padding
const ID_GAP_MIN = 56;  // minimum id column width
const ID_GAP_PAD = 20;  // gap between the id and its text
const LINE_H = 26;      // wrapped-line leading
const ROW_MIN = 50;     // minimum row height
const HEADER_H = 60;    // panel header band
const BOTTOM_PAD = 28;  // panel bottom padding
const FOOTER_RESERVE = 70;

function idColor(inv) {
  if (inv.status === 'fail') return 'fail';
  if (inv.status === 'unchecked') return 'muted';
  if (inv.kind === 'liveness') return 'accentB';
  return 'ok';
}

/**
 * Render the invariants panel at (x, y) with width w. `headerLabel` overrides
 * the auto "N MUST-NEVERS" band. Returns { h, svg }. Pure and reusable.
 */
export function invariantsPanel(tokens, { x, y, w, invariants, headerLabel }) {
  const ordered = [
    ...invariants.filter((i) => i.kind !== 'liveness'),
    ...invariants.filter((i) => i.kind === 'liveness')
  ];
  const widestId = Math.max(...ordered.map((i) => measureText(i.id, { size: 17, mono: true, bold: true })));
  const idGap = Math.max(ID_GAP_MIN, Math.ceil(widestId) + ID_GAP_PAD);
  const textX = x + IPAD + idGap;
  const maxTextW = x + w - IPAD - textX;

  const rows = ordered.map((inv) => {
    const lines = wrapText(inv.text, { size: 17, maxWidth: maxTextW });
    const h = Math.max(ROW_MIN, lines.length * LINE_H + 24);
    return { inv, lines, h };
  });

  const rowsHeight = rows.reduce((a, r) => a + r.h, 0);
  const panelH = HEADER_H + rowsHeight + BOTTOM_PAD;

  let s = panel(tokens, { x, y, w, h: panelH });

  const nSafety = invariants.filter((i) => i.kind !== 'liveness').length;
  const nLive = invariants.length - nSafety;
  const label = headerLabel ?? (nLive > 0 ? `${nSafety} MUST-NEVERS · ${nLive} LIVENESS` : `${nSafety} MUST-NEVERS`);
  s += text(label, {
    x: x + IPAD, y: y + 38, 'font-family': tokens.fontMono, 'font-size': 15,
    fill: color(tokens, 'ok'), 'font-weight': 700, 'text-anchor': 'start', 'letter-spacing': 2
  });

  let ry = y + HEADER_H;
  for (const { inv, lines, h } of rows) {
    const baseline = ry + 26;
    s += text(inv.id, {
      x: x + IPAD, y: baseline, 'font-family': tokens.fontMono, 'font-size': 17,
      fill: color(tokens, idColor(inv)), 'font-weight': 700, 'text-anchor': 'start'
    });
    const bodyColor = inv.status === 'fail' ? color(tokens, 'fail') : color(tokens, 'ink');
    lines.forEach((line, i) => {
      s += text(line, {
        x: textX, y: baseline + i * LINE_H, 'font-family': tokens.fontSans, 'font-size': 17,
        fill: bodyColor, 'font-weight': 400, 'text-anchor': 'start'
      });
    });
    ry += h;
  }

  return { h: panelH, svg: s };
}

export function renderInvariants(model, { tokens }) {
  const invariants = model.invariants;
  if (!Array.isArray(invariants) || invariants.length === 0) {
    throw new Error('invariants diagram: model.invariants is required and must be non-empty');
  }
  const meta = model.meta ?? {};
  const kicker = meta.kicker ?? model.machine?.kicker ?? 'WHAT GETS CHECKED';
  const title = meta.title ?? model.machine?.title ?? 'The must-nevers';
  const brand = meta.brand ?? 'COGNITIVE FAB · POLYGRAPH';
  const footer = meta.footer ?? "verify, don't review";

  const top = contentTop();
  const built = invariantsPanel(tokens, { x: PAD, y: top, w: WIDTH - PAD * 2, invariants });
  const height = top + built.h + FOOTER_RESERVE;

  let s = chrome(tokens, { width: WIDTH, height, kicker, title, brand, footer });
  s += built.svg;

  return { id: 'invariants', width: WIDTH, height, svg: svg({ width: WIDTH, height }, s) };
}
