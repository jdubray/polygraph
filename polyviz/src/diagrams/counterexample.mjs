// D3 — counterexample: the ordered violating trace + violated-invariant banner
// + "the gate generated this" callout. Source section: `trace`. Reference: fig3.
//
// Renders both faces of the bug-and-fix story from the same data:
//   • trace.violation present  → the bug (red banner).
//   • trace.violation absent    → the fix / clean pass (green banner).
// The callout's cleanPasses line ("point the same check at the clean build → it
// passes") renders in either case.

import { svg, el, text } from '../render/svg.mjs';
import { color } from '../render/theme.mjs';
import {
  chrome, panel, nodeBox, hArrow, banner, contentTop, measureText, wrapText, PAD
} from '../render/components.mjs';

const WIDTH = 1200;
const BOX_H = 58;
const STEP_GAP = 22;
const FOOTER_RESERVE = 70;

// Convention for a counterexample: an annotation above a redelivered step is a
// neutral tag (step color); an annotation below any other step is violation
// evidence (fail color, with a connector stub).
function renderSteps(tokens, steps, topY) {
  let s = '';
  let x = PAD;
  const cy = topY + BOX_H / 2;
  const boxes = [];
  let hasBelow = false;

  steps.forEach((step, i) => {
    if (i > 0) s += hArrow(tokens, { x1: x + 2, x2: x + STEP_GAP - 4, y: cy });
    if (i > 0) x += STEP_GAP;
    // Widen the box to contain its (centered) annotation so adjacent
    // annotations cannot overlap across the gap between boxes.
    const annoSize = step.kind === 'redelivered' ? 12.5 : 13.5;
    const annoW = step.annotation ? measureText(step.annotation, { size: annoSize, mono: true }) + 16 : 0;
    const box = nodeBox(tokens, { x, y: topY, label: step.label, kind: step.kind ?? 'normal', minW: Math.max(140, Math.ceil(annoW)) });
    s += box.svg;
    boxes.push(box);

    if (step.annotation) {
      if (step.kind === 'redelivered') {
        s += text(step.annotation, {
          x: box.cx, y: topY - 14, 'font-family': tokens.fontMono, 'font-size': 12.5,
          fill: color(tokens, 'warn'), 'font-weight': 400, 'text-anchor': 'middle'
        });
      } else {
        hasBelow = true;
        s += el('line', {
          x1: box.cx, y1: topY + BOX_H + 4, x2: box.cx, y2: topY + BOX_H + 18,
          stroke: color(tokens, 'fail'), 'stroke-width': 1.4, 'stroke-linecap': 'round'
        });
        s += text(step.annotation, {
          x: box.cx, y: topY + BOX_H + 34, 'font-family': tokens.fontMono, 'font-size': 13.5,
          fill: color(tokens, 'fail'), 'font-weight': 700, 'text-anchor': 'middle'
        });
      }
    }
    x += box.w;
  });

  const bottom = topY + BOX_H + (hasBelow ? 44 : 0);
  const overflow = x - PAD > WIDTH - PAD * 2;
  return { svg: s, bottom, overflow, rightEdge: x };
}

export function renderCounterexample(model, { tokens, log = () => {} }) {
  const trace = model.trace;
  if (!trace || !Array.isArray(trace.steps) || trace.steps.length === 0) {
    throw new Error('counterexample diagram: model.trace.steps is required and must be non-empty');
  }
  const meta = model.meta ?? {};
  const kicker = trace.kicker ?? 'THE BUG IT CAUGHT';
  const title = trace.title ?? 'The gate wrote its own reproduction';
  const brand = meta.brand ?? 'COGNITIVE FAB · POLYGRAPH';
  const footer = meta.footer ?? "verify, don't review";
  const subtitleLines = trace.subtitle
    ? wrapText(trace.subtitle, { size: 17, maxWidth: WIDTH - PAD * 2 })
    : [];

  const innerW = WIDTH - PAD * 2;
  const top = contentTop(subtitleLines.length);
  const stepsTop = top + 22; // headroom for above-annotations

  const steps = renderSteps(tokens, trace.steps, stepsTop);
  if (steps.overflow) {
    log(`polyviz: counterexample trace is wider than the frame (${steps.rightEdge}px) — rendering single-row; wrap-to-rows lands later`);
  }

  // Banner: bug (red) if a violation is present, else clean-pass (green).
  const isBug = !!trace.violation;
  let bannerBlock = { h: 0, svg: '' };
  const bannerY = steps.bottom + 52;
  if (isBug) {
    const v = trace.violation;
    bannerBlock = banner(tokens, {
      x: PAD, y: bannerY, w: innerW,
      title: `✗  ${v.title ?? `${v.invariantId ?? ''} violated`.trim()}`,
      titleColor: 'fail', fill: 'failBg', stroke: 'fail',
      detailLines: v.detail ? wrapText(v.detail, { size: 16, maxWidth: innerW - 52 }) : []
    });
  } else {
    bannerBlock = banner(tokens, {
      x: PAD, y: bannerY, w: innerW,
      title: '✓  CHECK PASSES — no reachable violation',
      titleColor: 'ok', fill: 'okBg', stroke: 'ok',
      detailLines: wrapText('The gate explored every reachable state from this trace and found no path to a violated invariant.', { size: 16, maxWidth: innerW - 52 })
    });
  }

  // Callout (optional).
  let calloutH = 0;
  let calloutSvg = '';
  const calloutY = bannerY + bannerBlock.h + 28;
  if (trace.callout) {
    const c = trace.callout;
    const pad = 26;
    const bodyLines = c.body ? wrapText(c.body, { size: 15.5, maxWidth: innerW - pad * 2 }) : [];
    let inner = '';
    inner += text(c.title ?? '', {
      x: PAD + pad, y: calloutY + 44, 'font-family': tokens.fontSans, 'font-size': 18,
      fill: color(tokens, 'ok'), 'font-weight': 700, 'text-anchor': 'start'
    });
    let by = calloutY + 82;
    for (const line of bodyLines) {
      inner += text(line, {
        x: PAD + pad, y: by, 'font-family': tokens.fontSans, 'font-size': 15.5,
        fill: color(tokens, 'muted'), 'font-weight': 400, 'text-anchor': 'start'
      });
      by += 24;
    }
    let cleanY = by + 16;
    if (c.cleanPasses) {
      const seg1 = 'Point the same check at the clean build';
      inner += text(seg1, {
        x: PAD + pad, y: cleanY, 'font-family': tokens.fontMono, 'font-size': 15.5,
        fill: color(tokens, 'ink'), 'font-weight': 400, 'text-anchor': 'start'
      });
      const x2 = PAD + pad + measureText(seg1, { size: 15.5, mono: true }) + 30;
      inner += text('→  it passes.  ✓', {
        x: x2, y: cleanY, 'font-family': tokens.fontMono, 'font-size': 15.5,
        fill: color(tokens, 'ok'), 'font-weight': 700, 'text-anchor': 'start'
      });
      cleanY += 8;
    } else {
      cleanY = by - 8;
    }
    calloutH = (cleanY - calloutY) + 28;
    calloutSvg = panel(tokens, { x: PAD, y: calloutY, w: innerW, h: calloutH, radius: 14 }) + inner;
  }

  const contentBottom = trace.callout ? calloutY + calloutH : bannerY + bannerBlock.h;
  const height = contentBottom + FOOTER_RESERVE;

  let s = chrome(tokens, { width: WIDTH, height, kicker, title, subtitleLines, brand, footer });
  s += steps.svg;
  s += bannerBlock.svg;
  s += calloutSvg;

  return { id: 'counterexample', width: WIDTH, height, svg: svg({ width: WIDTH, height }, s) };
}
