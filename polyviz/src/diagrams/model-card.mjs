// model-card — the composition of D1 (state-machine) and D2 (invariants) in one
// frame. Source sections: `machine` + `invariants`. Reference: fig2.
//
// Machine graph on top; a caption derived from the liveness invariants; the
// safety invariants as the "must-nevers" panel below. Async (elk-backed).

import { svg, text } from '../render/svg.mjs';
import { color } from '../render/theme.mjs';
import { chrome, contentTop, wrapText, PAD } from '../render/components.mjs';
import { layoutMachine } from '../layout/graph.mjs';
import { placeGraph } from './state-machine.mjs';
import { invariantsPanel } from './invariants.mjs';

const WIDTH = 1200;
const FOOTER_RESERVE = 70;

// Lowercase the first character so joined liveness texts read as a caption.
function lcFirst(str) {
  return str ? str[0].toLowerCase() + str.slice(1) : str;
}

export async function renderModelCard(model, { tokens, log }) {
  const machine = model.machine;
  const invariants = model.invariants;
  if (!machine || !Array.isArray(machine.states) || machine.states.length === 0) {
    throw new Error('model-card: model.machine.states is required and must be non-empty');
  }
  if (!Array.isArray(invariants) || invariants.length === 0) {
    throw new Error('model-card: model.invariants is required and must be non-empty');
  }
  const meta = model.meta ?? {};
  const kicker = meta.kicker ?? machine.kicker ?? 'WHAT GETS CHECKED';
  const title = meta.title ?? machine.title ?? 'The machine, and what it must never do';
  const brand = meta.brand ?? 'COGNITIVE FAB · POLYGRAPH';
  const footer = meta.footer ?? "verify, don't review";
  const subtitleLines = machine.subtitle
    ? wrapText(machine.subtitle, { size: 17, maxWidth: WIDTH - PAD * 2 })
    : [];

  const layout = await layoutMachine(machine);

  const safety = invariants.filter((i) => i.kind !== 'liveness');
  const liveness = invariants.filter((i) => i.kind === 'liveness');
  const caption = liveness.map((i) => lcFirst(i.text)).join('  ·  ');

  const top = contentTop(subtitleLines.length) + 20;
  const placed = placeGraph(tokens, layout, { x: PAD, y: top, maxWidth: WIDTH - PAD * 2, log });
  const graphBottom = top + placed.height;
  const captionY = graphBottom + 30;
  const panelY = graphBottom + (caption ? 56 : 24);

  // Measure the panel to size the canvas (render after height is known).
  const built = invariantsPanel(tokens, {
    x: PAD, y: panelY, w: WIDTH - PAD * 2,
    invariants: safety.length ? safety : invariants,
    headerLabel: `${safety.length || invariants.length} MUST-NEVERS`
  });
  const height = panelY + built.h + FOOTER_RESERVE;

  let s = chrome(tokens, { width: WIDTH, height, kicker, title, subtitleLines, brand, footer });
  s += placed.svg;
  if (caption) {
    s += text(caption, {
      x: PAD, y: captionY, 'font-family': tokens.fontSans, 'font-size': 15,
      fill: color(tokens, 'muted'), 'font-weight': 400, 'text-anchor': 'start'
    });
  }
  s += built.svg;

  return { id: 'model-card', width: WIDTH, height, svg: svg({ width: WIDTH, height }, s) };
}
