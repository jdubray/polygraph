// Shared contract -> prompt-text renderers. ONE source of truth for how a
// contract's state keys / init state / action alphabet are shown to a model,
// so build_prompt.mjs (audit mode) and polygen_prompts.mjs (author mode)
// never drift into describing the same contract differently.
import { dataFieldsOf } from './load-spec.mjs';

/** Render the observable-state key list from the contract. */
export function renderStateKeys(contract) {
  return contract.stateKeys
    .map((k) => {
      const name = typeof k === 'string' ? k : k.name;
      const type = typeof k === 'string' ? '' : (k.type ? ` — ${k.type}` : '');
      return `  - \`${name}\`${type}`;
    })
    .join('\n');
}

/** Render the initial-state object literal. */
export function renderInitState(contract) {
  if (contract.initState) return JSON.stringify(contract.initState);
  // Fall back to a null-filled object over the declared keys.
  const obj = {};
  for (const k of contract.stateKeys) obj[typeof k === 'string' ? k : k.name] = null;
  return JSON.stringify(obj);
}

/** Render the action alphabet with data shapes. */
export function renderActions(contract) {
  return Object.entries(contract.actions)
    .map(([name, spec]) => {
      const fields = dataFieldsOf(spec);
      const shape =
        fields && Object.keys(fields).length
          ? `{ ${Object.entries(fields).map(([f, t]) => `${f}: ${t}`).join(', ')} }`
          : '{ }';
      return `          '${name}'  data: ${shape}`;
    })
    .join('\n');
}

/** Render specialRules as a bullet list, or a one-line "none declared". */
export function renderSpecialRules(contract) {
  const rules = contract.specialRules || [];
  if (!rules.length) return '  (none declared)';
  return rules
    .map((r) => {
      const where = [r.whenState ? `state=${r.whenState}` : null, r.whenAction ? `action=${r.whenAction}` : null]
        .filter(Boolean)
        .join(', ');
      return `  - **${r.name}**${where ? ` (${where})` : ''}: ${r.note || ''}`;
    })
    .join('\n');
}

/** Render terminalStates as a bullet list, or a one-line "none declared". */
export function renderTerminalStates(contract) {
  const terms = contract.terminalStates || [];
  return terms.length ? terms.map((t) => `  - \`${t}\``).join('\n') : '  (none declared)';
}
