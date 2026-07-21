// D4 — compat-gate: a version delta + the live fleet + the blocked/clear verdict
// with named offenders. Source section: `compat`. Reference: fig4 (portrait).
//
// Bug-and-fix, like D3: verdict.status 'blocked' → red banner with offenders;
// 'clear' → green "safe to deploy" banner. A narrow (760px) vertical layout —
// version cards, the seeded fleet, the gate, then the verdict.

import { svg, el, text } from '../render/svg.mjs';
import { color } from '../render/theme.mjs';
import { chrome, panel, roundRect, banner, arrowHead, contentTop, wrapText, ellipsize, PAD } from '../render/components.mjs';

const WIDTH = 760;
const INNER = WIDTH - PAD * 2;      // 664
const VER_H = 64;
const VER_GAP = 64;                 // gap between the two version cards
const FLEET_IPAD = 26;
const FLEET_CARD_GAP = 18;
const FLEET_CARD_H = 72;
const FLEET_HEADER_H = 54;
const FLEET_PAD_BOTTOM = 24;
const GATE_H = 60;
const FOOTER_RESERVE = 70;

// A version card (RULE v1 / v2). accent is the stroke+label token.
function versionCard(tokens, { x, y, w, card, accent }) {
  const maxW = w - 48; // 24px inner padding each side
  let s = roundRect({ x, y, w, h: VER_H, r: 12, fill: color(tokens, 'panel'), stroke: color(tokens, accent), strokeWidth: 1.8 });
  s += text(ellipsize(card.label, { size: 13, mono: true, bold: true, maxWidth: maxW }), {
    x: x + 24, y: y + 30, 'font-family': tokens.fontMono, 'font-size': 13,
    fill: color(tokens, accent), 'font-weight': 700, 'text-anchor': 'start'
  });
  if (card.detail) {
    s += text(ellipsize(card.detail, { size: 18, bold: true, maxWidth: maxW }), {
      x: x + 24, y: y + 52, 'font-family': tokens.fontSans, 'font-size': 18,
      fill: color(tokens, 'ink'), 'font-weight': 700, 'text-anchor': 'start'
    });
  }
  return s;
}

// A fleet order card. flagged entries are amber-bordered offenders.
function fleetCard(tokens, { x, y, w, entry }) {
  const flagged = !!entry.flagged;
  const stateColor = flagged ? 'warn' : 'muted';
  let s = roundRect({
    x, y, w, h: FLEET_CARD_H, r: 10, fill: color(tokens, 'panel'),
    stroke: color(tokens, flagged ? 'warn' : 'border'), strokeWidth: flagged ? 2 : 1.5
  });
  s += text(`#${entry.id}`, {
    x: x + 16, y: y + 26, 'font-family': tokens.fontMono, 'font-size': 14,
    fill: color(tokens, 'muted'), 'font-weight': 700, 'text-anchor': 'start'
  });
  s += text(ellipsize(entry.state, { size: 14, mono: true, bold: true, maxWidth: w - 62 - 12 }), {
    x: x + 62, y: y + 26, 'font-family': tokens.fontMono, 'font-size': 14,
    fill: color(tokens, stateColor), 'font-weight': 700, 'text-anchor': 'start'
  });
  if (entry.note) {
    s += text(ellipsize(entry.note, { size: 12.5, maxWidth: w - 32 }), {
      x: x + 16, y: y + 52, 'font-family': tokens.fontSans, 'font-size': 12.5,
      fill: color(tokens, 'muted'), 'font-weight': 400, 'text-anchor': 'start'
    });
  }
  return s;
}

export function renderCompat(model, { tokens }) {
  const compat = model.compat;
  if (!compat || !compat.verdict) {
    throw new Error('compat-gate diagram: model.compat with a verdict is required');
  }
  const meta = model.meta ?? {};
  const kicker = compat.kicker ?? 'THE HARD PART';
  const title = compat.title ?? 'State outlives its code';
  const brand = meta.brand ?? 'COGNITIVE FAB · POLYGRAPH';
  const footer = meta.footer ?? "verify, don't review";
  const subtitleLines = compat.subtitle
    ? wrapText(compat.subtitle, { size: 16, maxWidth: INNER })
    : [];

  const fleet = compat.fleet ?? [];
  const blocked = compat.verdict.status === 'blocked';

  // Vertical flow.
  const verY = contentTop(subtitleLines.length);
  const fleetY = verY + VER_H + 40;
  const fleetPanelH = FLEET_HEADER_H + (fleet.length ? FLEET_CARD_H + FLEET_PAD_BOTTOM : FLEET_PAD_BOTTOM);
  const gateArrowTop = fleetY + fleetPanelH;
  const gateY = gateArrowTop + 34;
  const verdictY = gateY + GATE_H + 32;

  const verdictTitle = compat.verdict.title ?? (blocked ? 'DEPLOY BLOCKED' : 'SAFE TO DEPLOY');
  const detailLines = compat.verdict.detail
    ? wrapText(compat.verdict.detail, { size: 15.5, maxWidth: INNER - 52 })
    : [];
  const built = banner(tokens, {
    x: PAD, y: verdictY, w: INNER,
    title: `${blocked ? '✗' : '✓'}  ${verdictTitle}`,
    titleColor: blocked ? 'fail' : 'ok',
    fill: blocked ? 'failBg' : 'okBg',
    stroke: blocked ? 'fail' : 'ok',
    detailLines
  });
  const height = verdictY + built.h + FOOTER_RESERVE;

  let s = chrome(tokens, { width: WIDTH, height, kicker, title, subtitleLines, brand, footer });

  // Version delta: from → to.
  if (compat.from && compat.to) {
    const cardW = (INNER - VER_GAP) / 2;
    s += versionCard(tokens, { x: PAD, y: verY, w: cardW, card: compat.from, accent: 'border' });
    const arrowY = verY + VER_H / 2;
    const ax1 = PAD + cardW + 12;
    const ax2 = PAD + cardW + VER_GAP - 12;
    s += el('line', { x1: ax1, y1: arrowY, x2: ax2, y2: arrowY, stroke: color(tokens, 'muted'), 'stroke-width': 2.4, 'stroke-linecap': 'round' });
    s += arrowHead(tokens, { x: ax2, y: arrowY, dx: 1, dy: 0, fill: 'muted' });
    s += versionCard(tokens, { x: PAD + cardW + VER_GAP, y: verY, w: cardW, card: compat.to, accent: 'accentB' });
  }

  // Live fleet panel.
  s += panel(tokens, { x: PAD, y: fleetY, w: INNER, h: fleetPanelH, fill: 'panel2', radius: 14 });
  s += text(compat.fleetLabel ?? 'LIVE FLEET — orders already in flight', {
    x: PAD + FLEET_IPAD, y: fleetY + 34, 'font-family': tokens.fontMono, 'font-size': 13,
    fill: color(tokens, 'accentA'), 'font-weight': 700, 'text-anchor': 'start', 'letter-spacing': 1
  });
  if (fleet.length) {
    const availW = INNER - FLEET_IPAD * 2;
    const cardW = (availW - (fleet.length - 1) * FLEET_CARD_GAP) / fleet.length;
    const cardsY = fleetY + FLEET_HEADER_H;
    fleet.forEach((entry, i) => {
      const x = PAD + FLEET_IPAD + i * (cardW + FLEET_CARD_GAP);
      s += fleetCard(tokens, { x, y: cardsY, w: cardW, entry });
    });
  }

  // Gate connector + gate bar (only when there is a gate label).
  const midX = WIDTH / 2;
  s += el('line', { x1: midX, y1: gateArrowTop, x2: midX, y2: gateY - 4, stroke: color(tokens, 'border'), 'stroke-width': 2, 'stroke-linecap': 'round' });
  s += arrowHead(tokens, { x: midX, y: gateY - 4, dx: 0, dy: 1, fill: 'border' });
  s += roundRect({ x: PAD, y: gateY, w: INNER, h: GATE_H, r: 12, fill: color(tokens, 'panel'), stroke: color(tokens, 'accentB'), strokeWidth: 1.8 });
  s += text(compat.gate ?? 'polyvers · seed the check with the live states', {
    x: midX, y: gateY + GATE_H / 2 + 6, 'font-family': tokens.fontMono, 'font-size': 16,
    fill: color(tokens, 'accentB'), 'font-weight': 700, 'text-anchor': 'middle'
  });

  // Verdict banner.
  s += built.svg;

  return { id: 'compat-gate', width: WIDTH, height, svg: svg({ width: WIDTH, height }, s) };
}
