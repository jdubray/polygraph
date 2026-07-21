// Diagram registry. Each entry: id -> render(model, { tokens }) -> { id, width, height, svg }.
// The catalog grows here as milestones land (D3 counterexample, D1 machine,
// model-card, D4 compat). M1 ships D2 invariants.

import { renderInvariants } from './invariants.mjs';
import { renderCounterexample } from './counterexample.mjs';
import { renderStateMachine } from './state-machine.mjs';
import { renderModelCard } from './model-card.mjs';
import { renderCompat } from './compat.mjs';

// Renderers may be sync or async (elk-backed ones return a promise); callers await.
export const DIAGRAMS = {
  'state-machine': renderStateMachine,
  invariants: renderInvariants,
  counterexample: renderCounterexample,
  'compat-gate': renderCompat,
  'model-card': renderModelCard
};

export const DIAGRAM_IDS = Object.keys(DIAGRAMS);

const hasMachine = (m) => m.machine && Array.isArray(m.machine.states) && m.machine.states.length;
const hasInvariants = (m) => Array.isArray(m.invariants) && m.invariants.length;

// Which diagrams a given viz-model can actually produce (has the source section).
export function availableFor(model) {
  const ok = [];
  if (hasMachine(model)) ok.push('state-machine');
  if (hasInvariants(model)) ok.push('invariants');
  if (model.trace && Array.isArray(model.trace.steps) && model.trace.steps.length) ok.push('counterexample');
  if (model.compat && model.compat.verdict) ok.push('compat-gate');
  if (hasMachine(model) && hasInvariants(model)) ok.push('model-card');
  return ok;
}
