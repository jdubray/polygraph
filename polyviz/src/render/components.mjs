// Reusable, token-driven SVG components (spec §4.5). No hard-coded colors.
// Geometry mirrors the reference figures without copying their coordinates:
// callers measure content and pass sizes in.

import { el, node, text, num } from './svg.mjs';
import { color } from './theme.mjs';
import { measureText, wrapText, ellipsize } from '../layout/measure.mjs';

// Shared layout constants (px), calibrated against reference/fig*.svg.
export const PAD = 48; // page margin
export const RULE_H = 6; // top accent bar
export const TITLE_Y = 96; // title baseline
export const KICKER_Y = 58; // kicker baseline
export const CONTENT_GAP = 34; // gap below header block to content
const FOOTER_Y_FROM_BOTTOM = 30;

export function roundRect({ x, y, w, h, r = 12, fill, stroke, strokeWidth = 1.5, dash = null }) {
  return el('rect', {
    x, y, width: w, height: h, rx: r, fill, stroke,
    'stroke-width': stroke ? strokeWidth : null,
    'stroke-dasharray': dash
  });
}

export function panel(tokens, { x, y, w, h, fill = 'panel', stroke = 'border', radius }) {
  return roundRect({
    x, y, w, h, r: radius ?? tokens.radius,
    fill: color(tokens, fill), stroke: color(tokens, stroke)
  });
}

// Color roles for emphasis kinds shared across step/state/transition marks.
export const KIND = {
  normal: { stroke: 'border', ink: 'ink' },
  accent: { stroke: 'accentA', ink: 'accentA' },
  violation: { stroke: 'fail', ink: 'fail' },
  redelivered: { stroke: 'warn', ink: 'warn' },
  approved: { stroke: 'accentA', ink: 'accentA' },
  highlight: { stroke: 'ok', ink: 'ok' },
  terminal: { stroke: 'border', ink: 'muted' }
};

/**
 * A content-sized node/step box with centered (mono) label. Auto-widths to the
 * text — no magic coordinates. Returns { x, y, w, h, cx, cy, svg }.
 */
export function nodeBox(tokens, { x, y, label, kind = 'normal', size = 15.5, mono = true, minW = 140, w: fixedW, h = 58, padX = 26, strokeWidth = 2, radius = 10 }) {
  const role = KIND[kind] ?? KIND.normal;
  const font = mono ? tokens.fontMono : tokens.fontSans;
  const w = fixedW ?? Math.max(minW, Math.round(measureText(label, { size, mono, bold: true }) + padX * 2));
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dash = kind === 'terminal' ? '5 4' : null;
  const rect = roundRect({ x, y, w, h, r: radius, fill: color(tokens, 'panel'), stroke: color(tokens, role.stroke), strokeWidth, dash });
  const t = text(label, {
    x: cx, y: cy + size * 0.36, 'font-family': font, 'font-size': size,
    fill: color(tokens, role.ink), 'font-weight': 700, 'text-anchor': 'middle'
  });
  return { x, y, w, h, cx, cy, svg: rect + t };
}

// The content width nodeBox() will choose for a label — so layout and render agree.
export function nodeBoxWidth(label, { size = 15.5, mono = true, minW = 140, padX = 26 } = {}) {
  return Math.max(minW, Math.round(measureText(label, { size, mono, bold: true }) + padX * 2));
}

// An arrowhead triangle at point (x,y), pointing along direction (dx,dy).
export function arrowHead(tokens, { x, y, dx, dy, size = 9, fill = 'muted' }) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;            // unit along direction
  const px = -uy, py = ux;                        // perpendicular
  const bx = x - ux * size, by = y - uy * size;   // base center
  const pt = (a, b) => `${num(a)},${num(b)}`;
  const points = [
    pt(x, y),
    pt(bx + px * (size * 0.6), by + py * (size * 0.6)),
    pt(bx - px * (size * 0.6), by - py * (size * 0.6))
  ].join(' ');
  return node('polygon', { points, fill: color(tokens, fill) });
}

// Horizontal arrow from x1 to x2 at height y (points right).
export function hArrow(tokens, { x1, x2, y, stroke = 'muted' }) {
  const c = color(tokens, stroke);
  const line = el('line', { x1, y1: y, x2, y2: y, stroke: c, 'stroke-width': 2.2, 'stroke-linecap': 'round' });
  const head = node('polygon', { points: `${x2},${y} ${x2 - 9},${y - 5} ${x2 - 9},${y + 5}`, fill: c });
  return line + head;
}

/**
 * A titled banner (tinted panel). detailLines is a pre-wrapped array. Returns
 * { h, svg } so callers can stack. `fill`/`stroke`/`titleColor` are token names.
 */
export function banner(tokens, { x, y, w, title, titleColor = 'fail', titleSize = 22, detailLines = [], fill = 'failBg', stroke = 'fail', pad = 26 }) {
  const titleLead = Math.round(titleSize * 1.3);
  const lineH = 24;
  // Wrap the title too — a long violation title must not overflow the frame.
  const titleLines = wrapText(title, { size: titleSize, bold: true, maxWidth: w - pad * 2 });
  const titleBlockH = titleLines.length * titleLead;
  const detailBlockH = detailLines.length ? detailLines.length * lineH + 6 : 0;
  const h = pad + titleBlockH + detailBlockH + pad - 8;

  let s = roundRect({ x, y, w, h, r: 14, fill: color(tokens, fill), stroke: color(tokens, stroke), strokeWidth: 2 });
  let ty = y + pad + Math.round(titleSize * 0.72);
  for (const line of titleLines) {
    s += text(line, {
      x: x + pad, y: ty, 'font-family': tokens.fontSans, 'font-size': titleSize,
      fill: color(tokens, titleColor), 'font-weight': 800, 'text-anchor': 'start'
    });
    ty += titleLead;
  }
  let ly = y + pad + titleBlockH + 20;
  for (const line of detailLines) {
    s += text(line, {
      x: x + pad, y: ly, 'font-family': tokens.fontSans, 'font-size': 16,
      fill: color(tokens, 'ink'), 'font-weight': 400, 'text-anchor': 'start'
    });
    ly += lineH;
  }
  return { h, svg: s };
}

// A short rounded label chip with centered text.
export function pill(tokens, { x, y, label, fill = 'panel2', stroke = 'border', ink = 'ink', size = 15, mono = false, bold = true, padX = 14, h = 32 }) {
  const font = mono ? tokens.fontMono : tokens.fontSans;
  const w = measureText(label, { size, mono, bold }) + padX * 2;
  const t = text(label, {
    x: x + w / 2, y: y + h / 2 + size * 0.34,
    'font-family': font, 'font-size': size, fill: color(tokens, ink),
    'font-weight': bold ? 700 : 400, 'text-anchor': 'middle'
  });
  return { w, h, svg: roundRect({ x, y, w, h, r: 10, fill: color(tokens, fill), stroke: color(tokens, stroke) }) + t };
}

/**
 * How far below the top the content should start, given an optional wrapped
 * subtitle. Pure — diagrams call this to size the canvas.
 */
export function contentTop(subtitleLines = 0, subtitleLead = 30) {
  if (!subtitleLines) return 130;
  return 128 + subtitleLines * subtitleLead + CONTENT_GAP - 10;
}

/**
 * Full page chrome: bg, top rule, header (kicker/title/subtitle), footer.
 * `subtitleLines` is a pre-wrapped array of strings (may be empty).
 */
export function chrome(tokens, { width, height, kicker, title, subtitleLines = [], brand, footer }) {
  let s = '';
  s += el('rect', { width, height, fill: color(tokens, 'bg') });
  s += el('rect', { x: 0, y: 0, width, height: RULE_H, fill: color(tokens, 'rule') });

  if (kicker) {
    s += text(kicker, {
      x: PAD, y: KICKER_Y, 'font-family': tokens.fontMono, 'font-size': 14,
      fill: color(tokens, 'rule'), 'font-weight': 700, 'text-anchor': 'start', 'letter-spacing': 3
    });
  }
  if (title) {
    s += text(title, {
      x: PAD, y: TITLE_Y, 'font-family': tokens.fontSans, 'font-size': 30,
      fill: color(tokens, 'ink'), 'font-weight': 700, 'text-anchor': 'start'
    });
  }
  let sy = 128;
  for (const line of subtitleLines) {
    s += text(line, {
      x: PAD, y: sy, 'font-family': tokens.fontSans, 'font-size': 17,
      fill: color(tokens, 'muted'), 'font-weight': 400, 'text-anchor': 'start'
    });
    sy += 30;
  }

  const fy = height - FOOTER_Y_FROM_BOTTOM;
  if (brand) {
    s += text(brand, {
      x: PAD, y: fy, 'font-family': tokens.fontMono, 'font-size': 13,
      fill: color(tokens, 'muted'), 'font-weight': 700, 'text-anchor': 'start', 'letter-spacing': 3
    });
  }
  if (footer) {
    s += text(footer, {
      x: width - PAD, y: fy, 'font-family': tokens.fontSans, 'font-size': 15,
      fill: color(tokens, 'muted'), 'font-style': 'italic', 'text-anchor': 'end'
    });
  }
  return s;
}

export { measureText, wrapText, ellipsize, num };
