// D1 layout: the machine graph via elkjs' layered algorithm (spec §4.4).
// Deterministic — elk 'layered' uses no randomized tie-breaks; we verify by
// rendering twice in the determinism test. Returns geometry only; the renderer
// draws it. Node sizes come from the same width function nodeBox() uses, so the
// layout and the drawn boxes agree exactly.

import { nodeBoxWidth } from '../render/components.mjs';

// elkjs is an OPTIONAL dependency, loaded only when a state-machine graph is
// actually laid out — so the core SVG diagrams (invariants, counterexample,
// compat) render with no graph-layout dependency at all.
let ELKClass = null;
async function getELK() {
  if (!ELKClass) {
    try { ELKClass = (await import('elkjs')).default; }
    catch { throw new Error('the state-machine / model-card diagram needs the optional dependency elkjs — install it with:  npm i elkjs'); }
  }
  return ELKClass;
}

const BOX_H = 58;

const LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '52',
  'elk.spacing.nodeNode': '34',
  'elk.spacing.edgeNode': '20',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.spacing.edgeEdge': '12',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES'
};

// The label a transition shows on the graph: prefer the note, else the effect.
export function transitionLabel(t) {
  return t.note || t.effect || '';
}

/**
 * Lay out the machine. Returns { width, height, nodes, edges } in local coords
 * (origin 0,0); the renderer translates into the frame.
 *   nodes: { id, x, y, w, h, state }
 *   edges: { id, points:[{x,y}...], label:{x,y,w,h,text}|null, trans }
 */
export async function layoutMachine(machine) {
  const stateById = new Map(machine.states.map((s) => [s.id, s]));
  const transById = new Map();

  const children = machine.states.map((s) => ({
    id: s.id,
    width: nodeBoxWidth(s.label ?? s.id),
    height: BOX_H
  }));

  // elk 'layered' does not place free edge labels (returns 0,0), so we don't
  // feed labels to elk — the renderer positions them at the edge midpoint.
  const edges = machine.transitions.map((t, i) => {
    const id = `e${i}`;
    transById.set(id, t);
    return { id, sources: [t.from], targets: [t.to] };
  });

  const graph = { id: 'root', layoutOptions: LAYOUT_OPTIONS, children, edges };
  const ELK = await getELK();
  const out = await new ELK().layout(graph);

  const nodes = out.children.map((c) => ({
    id: c.id, x: c.x, y: c.y, w: c.width, h: c.height, state: stateById.get(c.id)
  }));

  const outEdges = out.edges.map((e) => {
    const trans = transById.get(e.id);
    const sec = e.sections?.[0];
    const points = sec ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint] : [];
    return { id: e.id, points, label: transitionLabel(trans) || null, trans };
  });

  return { width: out.width, height: out.height, nodes, edges: outEdges };
}
