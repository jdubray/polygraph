// Shared contract -> prompt-text renderers. ONE source of truth for how a
// contract's state keys / init state / action alphabet are shown to a model,
// so build_prompt.mjs (audit mode) and polygen_prompts.mjs (author mode)
// never drift into describing the same contract differently.
import { dataFieldsOf, stable } from './load-spec.mjs';

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
 * Classify one union arm as a runtime type — PURE type tokens only. An arm
 * that is prose ("array of enum: 'pending'", "3-letter code", "nullable
 * string") returns null and contributes NOTHING: a note-derived union is
 * only believed when the arms are unambiguous type expressions, because a
 * false union silently strips shape checking from a single-runtime-type key
 * (review finding: the polygraph-oms-go contract's "array of enum: 'a' |
 * 'b'" note split into a bogus array|string union — the container prefix
 * rides only on the first arm while every later enum member classifies
 * standalone).
 */
function runtimeTypeOfArm(arm) {
  if (/^'[^']*'$/.test(arm) || /^"[^"]*"$/.test(arm)) return 'string';
  if (/^-?\d+(\.\d+)?$/.test(arm)) return 'number';
  if (/^(true|false)$/.test(arm)) return 'boolean';
  if (/^\{.*\}$/.test(arm)) return 'object';
  if (/^\[.*\]$/.test(arm) || /^[A-Za-z_$][\w<>,.\s]*\[\]$/.test(arm) || /^Array\s*<.*>$/.test(arm)) return 'array';
  if (/^(Record|Map)\s*<.*>$/.test(arm)) return 'object';
  if (/^(string|str)$/i.test(arm)) return 'string';
  if (/^(number|int|integer|float)$/i.test(arm)) return 'number';
  if (/^(bool|boolean)$/i.test(arm)) return 'boolean';
  if (/^object$/i.test(arm)) return 'object';
  if (/^array$/i.test(arm)) return 'array';
  return null;
}

/**
 * Split a type note on TOP-LEVEL '|' (respecting quotes/braces/brackets) and
 * classify each arm. "'LOCKED' | 'UNLOCKED'" is two string literals — one
 * runtime type; "string | {red: string}" is two runtime types. Returns
 * { types: sorted distinct runtime types (prose arms skipped),
 *   sawNull: a null/undefined arm was declared }.
 * Under-detection is the designed failure direction: prose apostrophes and
 * stray closers suppress splitting/classification, never invent a union.
 */
function runtimeTypesOfNote(note) {
  if (!note || typeof note !== 'string') return { types: [], sawNull: false };
  const arms = [];
  let depth = 0, quote = null, cur = '';
  for (const ch of note) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if ((ch === '}' || ch === ']' || ch === ')') && depth > 0) depth--;
    if (ch === '|' && depth === 0) { arms.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  arms.push(cur.trim());
  if (arms.length < 2) return { types: [], sawNull: false }; // not a union note — single-arm inference stays with typeOfNote
  const types = new Set();
  let sawNull = false;
  for (const arm of arms) {
    if (/^(null|undefined)$/.test(arm)) { sawNull = true; continue; }
    const t = runtimeTypeOfArm(arm);
    if (t) types.add(t);
  }
  return { types: [...types].sort(), sawNull };
}

/**
 * Render the v2 `modelShape` declaration from stateKeys + initState (+ the
 * trace corpus when available). Types are inferred from the initState values;
 * a key whose initState value is null renders `nullable: true` with the type
 * taken from the stateKey's type note (default string).
 *
 * UNION KEYS (xstate field study, eval/FINDING-xstate-union-schema.md): a key
 * whose runtime type is a union — declared in the type note ("string |
 * {red: string}", the literal shape of xstate's state.value) or OBSERVED
 * across the captured windows' pre/post values — must render `{}` with no
 * `type` at all. The strict profile's checker validates single runtime types
 * only, so any single choice throws the moment the other arm is assigned;
 * rendering `type: '<init's type>'` here trapped every one of 5 independent
 * generations identically. The comment ships INTO the prompt so a generation
 * cannot "helpfully" tighten it back. Returns a JS object-literal snippet.
 */
export function renderModelShape(contract, windows = []) {
  const init = contract.initState || {};
  const entries = contract.stateKeys.map((k) => {
    const name = typeof k === 'string' ? k : k.name;
    const note = typeof k === 'string' ? '' : k.type;
    const value = init[name];
    // Distinct runtime types, strongest source first: real captured shapes
    // (windows' pre/post), then the init value, then the union-parsed note.
    // Nullability is tracked from ALL the same sources — the strict checker
    // tests null BEFORE type, so a union or window-observed null key rendered
    // without `nullable: true` would throw on every null write (the exact
    // all-generations trap class this renderer exists to close).
    const seen = new Set();
    let sawNull = Object.prototype.hasOwnProperty.call(init, name) && value === null;
    for (const w of windows) {
      for (const side of [w?.pre, w?.post]) {
        if (!side || !(name in side)) continue;
        if (side[name] === null) { sawNull = true; continue; }
        const t = typeOfValue(side[name]);
        if (t) seen.add(t);
      }
    }
    const initT = typeOfValue(value);
    if (initT) seen.add(initT);
    const noteTypes = runtimeTypesOfNote(note);
    if (noteTypes.sawNull) sawNull = true;
    // A union must be established WITHIN one source: real evidence
    // (windows + init) observing two runtime types, or the note ITSELF
    // declaring two pure type arms. Merging across sources would fabricate
    // unions from the common "container of enum: 'a' | 'b'" note shape —
    // the enum members are pure string LITERALS (values of the element
    // type), while init contributes the container type ('array'), and the
    // cross product read as array|string strips checking from a
    // single-runtime-type key.
    const isUnion = seen.size > 1 || noteTypes.types.length > 1;
    const nullable = sawNull ? ', nullable: true' : '';
    if (isUnion) {
      for (const t of noteTypes.types) seen.add(t);
      // sam-pattern ≥2.2 (#35): a type ARRAY declares the union outright —
      // shape checking stays live on every arm (the pre-2.2 escape was an
      // untyped `{}`, which gave up checking entirely).
      const arms = [...seen].sort();
      return `  ${name}: { type: [${arms.map((t) => `'${t}'`).join(', ')}]${nullable} },  // union — takes ${arms.join(' | ')}${sawNull ? ' | null' : ''} at runtime; keep the ARRAY exactly (collapsing it to one type makes the strict checker throw on the other arm)`;
    }
    // Single runtime type: real evidence (windows/init) beats the note; a
    // union-shaped note that classified to ONE pure type (an enum of string
    // literals) is next; the fuzzy whole-note keyword match is last.
    const type = (seen.size === 1 ? [...seen][0] : null)
      || (noteTypes.types.length === 1 ? noteTypes.types[0] : null)
      || typeOfNote(note) || 'string';
    return `  ${name}: { type: '${type}'${nullable} },`;
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
// windows: the trace corpus, when available. Field data (n8n study,
// eval/FINDING-n8n-reject-no-write.md) isolated the trigger for the 5/5
// reject-on-every-named-branch failure: generations reject ANY branch that
// maps to a named specialRules entry, independent of whether the rule
// describes a no-op — and this renderer used to COMMAND exactly that
// ("the acceptor MUST call reject(name)") for every rule. The corpus knows
// the truth: a rule whose matching windows all show post == pre (projection
// basis) is a genuine rejection; one whose windows show observable change
// names a BEHAVIORAL branch — the acceptor must perform the transition, and
// the name is only the why. Without a corpus (polygen's authoring path) the
// old must-reject reading is kept: there, specialRules are authored no-op
// declarations by construction.
export function renderSpecialRulesAsRejections(contract, windows = []) {
  const rules = contract.specialRules || [];
  if (!rules.length) {
    return (
      '  (none declared — still call reject(reason) for every action the\n' +
      '  implementation ignores in a given state; never fall through silently)'
    );
  }
  const primaryKey = contract.stateKeys && contract.stateKeys[0]
    ? (typeof contract.stateKeys[0] === 'string' ? contract.stateKeys[0] : contract.stateKeys[0].name)
    : null;
  // stable(): the SAME canonical equality the replayer and the
  // rejectedActedWindows detector use — raw JSON.stringify is key-order
  // sensitive and would let a rebuilt-object trace misclassify a rule.
  const changed = (w) => Object.keys(w.post || {}).some((k) => stable(w.pre?.[k]) !== stable(w.post[k]));
  // In-repo contracts write whenState in several idioms: a bare value, the
  // "<key> == VALUE" / "<key> == 'VALUE'" form, or the wildcard 'any'.
  // Normalize before matching so those rules classify from evidence instead
  // of silently falling into the decide-from-source bucket.
  const normState = (s) => String(s).replace(/^\s*[\w.]+\s*==\s*/, '').replace(/^['"]|['"]$/g, '').trim();
  const isWildcard = (s) => /^(any|\*)$/i.test(normState(s));
  return rules
    .map((r) => {
      const where = [r.whenState ? `the primary state is \`${r.whenState}\`` : null, r.whenAction ? `the action is \`${r.whenAction}\`` : null]
        .filter(Boolean)
        .join(' and ');
      const note = r.note ? ` ${r.note}` : '';
      // A rule with NEITHER whenState nor whenAction would match every
      // window — a name-only doc note must never become a blanket command
      // in either direction.
      if (!r.whenState && !r.whenAction) {
        return `  - **${r.name}** (name-only rule — documentation): decide reject-vs-transition per branch by the observable-change test; the name is a reason string, not an instruction.${note}`;
      }
      const matching = windows.filter((w) =>
        (!r.whenAction || w.action === r.whenAction)
        && (!r.whenState || isWildcard(r.whenState) || !primaryKey || String(w.pre?.[primaryKey]) === normState(r.whenState)));
      if (!windows.length || !matching.length) {
        // Unclassifiable (no corpus, or no window exercises the rule): the
        // authored-intent reading for polygen; a decide-from-source order for
        // the audit path where a corpus exists but never hits the rule.
        return windows.length
          ? `  - **${r.name}** (NOT exercised by any captured window): when ${where || 'this rule applies'}, decide from the SOURCE — call \`reject('${r.name}')\` ONLY if the code observably does nothing there; if the code acts, perform the transition and treat the name as documentation.${note}`
          : `  - **${r.name}**: when ${where || 'this rule applies'}, the acceptor MUST call \`reject('${r.name}')\` (do not fall through silently).${note}`;
      }
      const actedW = matching.filter(changed);
      const noopW = matching.filter((w) => !changed(w));
      if (actedW.length === 0) {
        return `  - **${r.name}** [REJECTION — every captured window here is a no-op]: when ${where || 'this rule applies'}, the acceptor MUST call \`reject('${r.name}')\` (do not fall through silently).${note}`;
      }
      if (noopW.length === 0) {
        return `  - **${r.name}** [BEHAVIORAL — the captured windows here CHANGE state (${actedW.length}/${matching.length})]: when ${where || 'this rule applies'}, the acceptor MUST perform the real transition via \`next.*\` writes and MUST NOT call reject() — this rule's name/note only documents WHY the transition looks the way it does.${note}`;
      }
      // MIXED rule: both arms exist in the corpus. Split by pre-state when
      // the arms are disjoint on the primary key (the common guard shape);
      // otherwise the branch is data-dependent and the instruction is the
      // decision TEST, never an absolute in either direction — an absolute
      // here would manufacture the inverse trap (act-instead-of-reject) on
      // one of the arms.
      const statesOf = (ws) => [...new Set(ws.map((w) => stable(w.pre?.[primaryKey])))];
      const actedStates = primaryKey ? statesOf(actedW) : [];
      const noopStates = primaryKey ? statesOf(noopW) : [];
      const disjoint = primaryKey && !actedStates.some((s) => noopStates.includes(s));
      if (disjoint) {
        const fmt = (arr) => arr.map((s) => `\`${JSON.parse(s)}\``).join(', ');
        return `  - **${r.name}** [MIXED — ${actedW.length}/${matching.length} captured windows change state]: when ${where || 'this rule applies'} — from ${primaryKey} ${fmt(actedStates)} the code TRANSITIONS (the acceptor MUST write \`next.*\`, MUST NOT reject); from ${primaryKey} ${fmt(noopStates)} the code does NOTHING (the acceptor MUST call \`reject('${r.name}')\`).${note}`;
      }
      return `  - **${r.name}** [MIXED, data-dependent — ${actedW.length}/${matching.length} captured windows change state]: when ${where || 'this rule applies'}, apply the observable-change test PER BRANCH: write \`next.*\` where the code acts, \`reject('${r.name}')\` where it observably does nothing — never one absolute for the whole rule.${note}`;
    })
    .join('\n');
}
