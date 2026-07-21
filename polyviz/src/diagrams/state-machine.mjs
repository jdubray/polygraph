// D1 — state-machine: the lifecycle graph (states, transitions, guards/effects,
// highlighted states) laid out by elkjs. Source section: `machine`. Reference:
// fig2 (top). Async: elk.layout is promise-based.

import { svg, el, text, num, node } from '../render/svg.mjs';
import { color } from '../render/theme.mjs';
import { chrome, nodeBox, arrowHead, contentTop, wrapText, PAD } from '../render/components.mjs';
import { layoutMachine } from '../layout/graph.mjs';

const WIDTH = 1200;
const FOOTER_RESERVE = 70;
const EDGE = 'muted';

// Round a scale factor to a fixed, diff-stable precision.
function scaleFactor(n) {
  return Number(n.toFixed(4));
}

/**
 * Place a laid-out graph at (x, y), scaled down uniformly if it is wider than
 * maxWidth (spec §4.12: scale rather than clip, and log the choice). Wrapping in
 * one <g transform> keeps the emitted coordinates the raw deterministic elk
 * values. Returns { svg, height, scale }.
 */
export function placeGraph(tokens, layout, { x, y, maxWidth, log = () => {} }) {
  const scale = layout.width > maxWidth ? scaleFactor(maxWidth / layout.width) : 1;
  if (scale < 1) {
    log(`polyviz: state-machine (${Math.round(layout.width)}px, ${layout.nodes.length} states) scaled to ${scale} to fit`);
  }
  const inner = renderGraph(tokens, layout, 0, 0).svg;
  const g = node('g', { transform: `translate(${num(x)} ${num(y)}) scale(${scale})` }, inner);
  return { svg: g, height: Math.round(layout.height * scale), scale };
}

// Emphasis (and whether the target is a highlighted state) drive the label color.
function labelColor(trans, targetHighlight) {
  if (targetHighlight) return 'ok';
  if (trans?.emphasis === 'violation') return 'fail';
  if (trans?.emphasis === 'accent') return 'accentA';
  return 'muted';
}

// Render the laid-out graph translated by (ox, oy). Returns { svg, height }.
export function renderGraph(tokens, layout, ox, oy) {
  let s = '';
  const highlightIds = new Set(layout.nodes.filter((n) => n.state?.kind === 'highlight').map((n) => n.id));

  // Edges first (under the boxes).
  for (const edge of layout.edges) {
    const pts = edge.points;
    if (pts.length < 2) continue;
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${num(p.x + ox)} ${num(p.y + oy)}`).join(' ');
    s += el('path', { d, fill: 'none', stroke: color(tokens, EDGE), 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    const end = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    s += arrowHead(tokens, { x: end.x + ox, y: end.y + oy, dx: end.x - prev.x, dy: end.y - prev.y, fill: EDGE });
  }

  // Nodes.
  for (const n of layout.nodes) {
    const box = nodeBox(tokens, {
      x: ox + n.x, y: oy + n.y, w: n.w, h: n.h,
      label: n.state?.label ?? n.id, kind: n.state?.kind ?? 'normal'
    });
    s += box.svg;
  }

  // Edge labels, placed at the edge midpoint just above the edge, colored by
  // emphasis / highlighted target. A short stub ties the label to the edge.
  for (const edge of layout.edges) {
    if (!edge.label || edge.points.length < 2) continue;
    const a = edge.points[0];
    const b = edge.points[edge.points.length - 1];
    const mx = (a.x + b.x) / 2 + ox;
    const edgeY = (a.y + b.y) / 2 + oy;
    const boxTop = edgeY - 29;        // edge runs through the box centre (h=58)
    const labelY = boxTop - 14;       // sit the label above the box row
    const targetHighlight = highlightIds.has(edge.trans?.to);
    const col = color(tokens, labelColor(edge.trans, targetHighlight));
    s += el('line', { x1: mx, y1: labelY + 6, x2: mx, y2: boxTop, stroke: col, 'stroke-width': 1.4, 'stroke-linecap': 'round' });
    s += text(edge.label, {
      x: mx, y: labelY, 'font-family': tokens.fontMono, 'font-size': 13,
      fill: col, 'font-weight': edge.trans?.emphasis === 'accent' ? 700 : 400, 'text-anchor': 'middle'
    });
  }

  return { svg: s, height: layout.height };
}

export async function renderStateMachine(model, { tokens, log }) {
  const machine = model.machine;
  if (!machine || !Array.isArray(machine.states) || machine.states.length === 0) {
    throw new Error('state-machine diagram: model.machine.states is required and must be non-empty');
  }
  const meta = model.meta ?? {};
  const kicker = meta.kicker ?? machine.kicker ?? 'THE MACHINE';
  const title = meta.title ?? machine.title ?? 'The lifecycle';
  const brand = meta.brand ?? 'COGNITIVE FAB · POLYGRAPH';
  const footer = meta.footer ?? "verify, don't review";
  const subtitleLines = machine.subtitle
    ? wrapText(machine.subtitle, { size: 17, maxWidth: WIDTH - PAD * 2 })
    : [];

  const layout = await layoutMachine(machine);

  const top = contentTop(subtitleLines.length) + 20; // headroom for above-edge labels
  const placed = placeGraph(tokens, layout, { x: PAD, y: top, maxWidth: WIDTH - PAD * 2, log });
  const height = top + placed.height + FOOTER_RESERVE;

  let s = chrome(tokens, { width: WIDTH, height, kicker, title, subtitleLines, brand, footer });
  s += placed.svg;

  return { id: 'state-machine', width: WIDTH, height, svg: svg({ width: WIDTH, height }, s) };
}
