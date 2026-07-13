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

// ── v2 (SAM strict-profile) renderers ───────────────────────────────────────
// These derive the v2 module declarations — modelShape, per-intent schema,
// per-intent domain, named rejections — from the SAME contract fields the
// legacy renderers above read. No schema change: stateKeys/initState feed
// modelShape, actions[].dataFields feed intent schemas, dataDomain feeds
// intent domains, specialRules feed reject(reason) requirements. The legacy
// renderers stay untouched (the --legacy-bare-next path still uses them).

const V2_TYPES = ['string', 'number', 'boolean', 'object', 'array'];

/** Infer a v2 schema/shape type from a concrete JS value; null when unknowable. */
function typeOfValue(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return V2_TYPES.includes(t) ? t : null;
}

/** Infer a v2 type from a human-readable type note (e.g. "number — coins"). */
function typeOfNote(note) {
  if (!note || typeof note !== 'string') return null;
  const n = note.toLowerCase();
  if (/\bnumber\b|\bint(eger)?\b|\bfloat\b/.test(n)) return 'number';
  if (/\bbool(ean)?\b/.test(n)) return 'boolean';
  if (/\barray\b|\blist\b|\[\]/.test(n)) return 'array';
  if (/\bobject\b|\bmap\b|\brecord\b|\bdict\b/.test(n)) return 'object';
  if (/\bstring\b|'[^']*'|"[^"]*"/.test(n)) return 'string';
  return null;
}

/**
 * Render the v2 `modelShape` declaration from stateKeys + initState.
 * Types are inferred from the initState values; a key whose initState value is
 * null renders `nullable: true` with the type taken from the stateKey's type
 * note (default string). Returns a JS object-literal snippet.
 */
export function renderModelShape(contract) {
  const init = contract.initState || {};
  const entries = contract.stateKeys.map((k) => {
    const name = typeof k === 'string' ? k : k.name;
    const note = typeof k === 'string' ? '' : k.type;
    const value = init[name];
    const nullable = Object.prototype.hasOwnProperty.call(init, name) && value === null;
    const type = typeOfValue(value) || typeOfNote(note) || 'string';
    return `  ${name}: { type: '${type}'${nullable ? ', nullable: true' : ''} },`;
  });
  return `{\n${entries.join('\n')}\n}`;
}

/**
 * Render per-intent payload schemas from actions[].dataFields. Field types are
 * inferred from contract.dataDomain values where declared, then from observed
 * trace windows (optional second argument), then from the dataFields type
 * note; default string. All declared fields are `required: true`.
 * Returns a JS object-literal snippet mapping ACTION -> schema.
 */
export function renderIntentSchemas(contract, windows = []) {
  const observed = {}; // action -> field -> first observed value
  for (const w of windows) {
    if (!w || typeof w.action !== 'string') continue;
    const bucket = (observed[w.action] = observed[w.action] || {});
    for (const [f, v] of Object.entries(w.data || {})) if (!(f in bucket)) bucket[f] = v;
  }
  const blocks = Object.entries(contract.actions).map(([name, spec]) => {
    const fields = dataFieldsOf(spec);
    const names = Object.keys(fields);
    if (!names.length) return `  ${name}: {},`;
    const body = names
      .map((f) => {
        const domainVals = contract.dataDomain?.[name]?.[f];
        const type =
          (Array.isArray(domainVals) && domainVals.length && typeOfValue(domainVals[0])) ||
          typeOfValue(observed[name]?.[f]) ||
          typeOfNote(fields[f]) ||
          'string';
        return `${f}: { type: '${type}', required: true }`;
      })
      .join(', ');
    return `  ${name}: { ${body} },`;
  });
  return `{\n${blocks.join('\n')}\n}`;
}

/**
 * Render per-intent input domains from contract.dataDomain as lists of payload
 * objects (the cartesian product over the action's declared fields — the same
 * enumeration the checker explores). An action with no data fields gets the
 * single empty payload [{}]. An action WITH data fields but no complete
 * dataDomain is a hard error: in the v2 pipeline the domain is also the
 * exploration and transpilation domain, so a missing domain would silently
 * exclude the action (the exact failure class v2 exists to close).
 * Returns a JS object-literal snippet mapping ACTION -> [payload, ...].
 */
export function renderIntentDomains(contract) {
  const blocks = Object.entries(contract.actions).map(([name, spec]) => {
    const fields = Object.keys(dataFieldsOf(spec));
    if (!fields.length) return `  ${name}: [{}],`;
    const perField = fields.map((f) => {
      const vals = contract.dataDomain?.[name]?.[f];
      if (!Array.isArray(vals) || !vals.length) {
        throw new Error(
          `contract error: action '${name}' declares data field '${f}' but has no dataDomain.${name}.${f} — ` +
            `the v2 pipeline requires a finite domain for every data field (it drives generation, exploration, and transpilation). ` +
            `Add "dataDomain": { "${name}": { "${f}": [ ...representative values... ] } } to the contract.`
        );
      }
      return vals;
    });
    let combos = [{}];
    fields.forEach((f, i) => {
      const nxt = [];
      for (const c of combos) for (const v of perField[i]) nxt.push({ ...c, [f]: v });
      combos = nxt;
    });
    return `  ${name}: [${combos.map((c) => JSON.stringify(c)).join(', ')}],`;
  });
  return `{\n${blocks.join('\n')}\n}`;
}

/**
 * Render specialRules as REQUIRED reject(reason) cases: each rule must be a
 * named rejection in the generated acceptor, so the replayer's rejection
 * column has a contract-anchored reason string to check.
 */
export function renderSpecialRulesAsRejections(contract) {
  const rules = contract.specialRules || [];
  if (!rules.length) {
    return (
      '  (none declared — still call reject(reason) for every action the\n' +
      '  implementation ignores in a given state; never fall through silently)'
    );
  }
  return rules
    .map((r) => {
      const where = [r.whenState ? `the primary state is \`${r.whenState}\`` : null, r.whenAction ? `the action is \`${r.whenAction}\`` : null]
        .filter(Boolean)
        .join(' and ');
      const note = r.note ? ` ${r.note}` : '';
      return `  - **${r.name}**: when ${where || 'this rule applies'}, the acceptor MUST call \`reject('${r.name}')\` (do not fall through silently).${note}`;
    })
    .join('\n');
}
