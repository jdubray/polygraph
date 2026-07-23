// Prompt builders for polygen (author mode): write NEW verifiable code
// out of the box, instead of deriving a spec from existing code.
//
// Mirrors build_prompt.mjs's placeholder discipline: function-form
// replaceAll is unnecessary here (template literals, no placeholder passes),
// but the same LAST-substitution rule holds in spirit — free-form text
// (intent, prior code, violation detail) is interpolated directly and never
// re-scanned for placeholders.
//
// Artifact modes (mirrors build_prompt.mjs):
//   'sam'    (default) — the authored artifact is a SAM v2 strict-profile
//            module ({ instance, init, actions, getState, setState }) with
//            declared modelShape / intent schemas / intent domains and
//            reject(reason) for everything the design ignores.
//   'legacy' — the bare next(state, action, data) module (--legacy-bare-next).
import {
  renderStateKeys, renderInitState, renderActions, renderSpecialRules, renderTerminalStates,
  renderModelShape, renderIntentSchemas, renderIntentDomains, renderSpecialRulesAsRejections,
} from './contract_render.mjs';

const LANG_FENCE = { javascript: 'javascript', typescript: 'typescript', js: 'javascript', ts: 'typescript' };
const fenceFor = (lang) => LANG_FENCE[lang] || 'javascript';

/**
 * The discipline sentence, verbatim from the SysMoBench v2 study prompt (the
 * control arm showed this sentence — not structure — carries robustness).
 * Rendered into every v2 authoring/repair prompt.
 */
export const DISCIPLINE_SENTENCE =
  'Acceptors must guard against invalid proposals (an action that the\n' +
  'implementation does not act on in the current state must be a no-op via\n' +
  '`reject(reason)`, NOT a throw)';

/** Indent a multi-line renderer snippet. */
const indent = (snippet, pad = '    ') => snippet.split('\n').map((l) => pad + l).join('\n');

/** The v2 export-surface line, shared by every v2 builder. */
const V2_EXPORTS = 'module.exports = { instance, init, actions, getState, setState };';

/** The shared v2 module-contract block (author + repair prompts). */
function v2ModuleContract(contract) {
  return `You MUST export exactly this shape:

    ${V2_EXPORTS}

- \`instance\` — the SAM instance, created with:
  \`const instance = createInstance({ strict: true, hasAsyncActions: false });\`
  (\`strict: true\` and \`hasAsyncActions: false\` are REQUIRED)
- Component declaration (v2 strict form):
  - \`modelShape\` — declare EXACTLY the observable keys:

${indent(renderModelShape(contract))}

    Copy this modelShape EXACTLY. A key rendered \`{}\` is a UNION (more than
    one runtime type) and MUST stay untyped — the strict checker validates
    single types and would throw on the other arm; conversely never loosen a
    typed key to \`{}\`.

  - \`actions\` — an OBJECT keyed by the action names. Each entry is the full
    form \`{ action, schema, domain }\` with \`action: (data = {}) => ({ ...data })\`
    (the proposal is the data payload). Use EXACTLY these payload schemas:

${indent(renderIntentSchemas(contract))}

    and EXACTLY these input domains (payload objects, one per entry — this is
    the pinned exploration domain; the model checker fires these intents in
    all combinations from the initial state, so the code must behave safely
    for EVERY payload below in ANY state it can reach):

${indent(renderIntentDomains(contract))}

  - \`acceptors\` — an OBJECT keyed by the same action names (the framework
    binds proposals to acceptors; do NOT write flag guards or a dispatch
    switch). Each acceptor is
    \`(model) => (proposal, { reject, next, unchanged }) => { ... }\` — a
    NEXT-STATE relation (sam-pattern 2.1 prime semantics): \`model\` is the
    FROZEN pre-state (read-only; writing \`model.x\` throws \`SamShapeError\`),
    and every write goes to the \`next\` draft.
  - COMMIT RULE (next-state form): for a FLAT state key, assign
    \`next.someKey = value\` — the right-hand side reads the PRE-state
    (\`next.count = model.count + 1\`). For a state key holding a NESTED
    map/object, assign the key WHOLE:
    \`next.<key> = { ...model.<key>, [k]: updated };\` — do NOT mutate
    \`model.<key>[k].field\` or \`next.<key>[k].field\` in place.
  - FRAME RULE: on every ACCEPTED path, every declared modelShape key must be
    either assigned via \`next.<key> = …\` or explicitly named unchanged:
    \`unchanged('keyA', 'keyB')\` — otherwise the step throws \`SamFrameError\`.
    A rejected step (\`return reject(reason)\`) needs NO framing. Never assign
    the same key twice in one step, and never read a value back from \`next\` —
    thread computed values through local consts.
  - WIRING — register everything with EXACTLY this idiom (the component
    members MUST be nested under the \`component\` key of a SINGLE
    \`instance({...})\` call; \`instance(component)\` or top-level members
    register NOTHING and the module fails validate()):

        const control = instance({
          initialState: { ...INITIAL_STATE },
          component: { modelShape, actions, acceptors, reactors: [] },
        });
        const { intents } = control;
- \`init()\` — resets to the initial state: EXACTLY \`setState(INITIAL_STATE)\`
  and nothing else. Do NOT call \`instance({}).state()\` anywhere —
  \`getState()\` is the safe snapshot accessor (a model data key like 'state'
  returns data, not the method; sam-lib #29).
- \`getState()\` — \`instance({}).getState()\`.
- \`setState(snapshot)\` — \`instance({}).setState(snapshot)\`.
- \`actions\` (export) — the named intents:
  \`{ ACTION: (data = {}) => intents.ACTION(data), ... }\`.

The initial state is:

    ${renderInitState(contract)}

## DETERMINISM RULES (violations are detected and fail the verification)

- No I/O, no timers, no Date/clock access, no Math.random, no async actions
- ${DISCIPLINE_SENTENCE.split('\n').join('\n  ')}
- No hidden state: every piece of state lives under the declared modelShape keys
- Do NOT include component \`safety\` conditions or a \`render\` function —
  invariants are verified in a separate phase
- The component MUST be anonymous: never set a \`name:\` key on it. A named
  component binds its acceptors to a LOCAL component state tree, so every
  guard reads undefined and the machine is dead at init (this is gated and
  will fail the build)`;
}

/** Render optional replay/determinism triage evidence for a repair prompt. */
function renderTriage(triage) {
  if (!triage) return '';
  const L = [];
  if (triage.nondeterministic) {
    L.push(`## Determinism flag

Two identical explorations of this module produced DIFFERENT state graphs —
the code is nondeterministic (Math.random / Date.now / retained mutable module
state). Remove the nondeterminism; every transition must depend only on
(state, action, data).`);
  }
  const replay = Array.isArray(triage.replay) ? triage.replay : [];
  if (replay.length) {
    const rows = replay.map((r) => {
      const whereBits = [r.scenario, r.index !== undefined ? `#${r.index}` : null].filter((x) => x !== null && x !== undefined && x !== '');
      const where = whereBits.length ? ` (${whereBits.join(' ')})` : '';
      const cls = r.classification ? ` classified '${r.classification}'` : '';
      const reason = r.rejectionReason !== undefined ? ` reason: ${JSON.stringify(r.rejectionReason)}` : '';
      const err = r.error ? ` error: ${r.error}` : '';
      return `- ${r.action}${where}: status ${r.status || 'fail'}${cls}${reason}${err}`;
    });
    L.push(`## Trace-replay triage (sam-tv classification of the failing windows)

'rejected' and 'identity-by-mutation' are the two GOOD no-op classes;
'unhandled' means the acceptor neither acted nor rejected — add an explicit
\`reject(reason)\` guard for that case. A 'rejected' window that still fails
disagrees with the trace: the guard fires when the implementation would act.

${rows.join('\n')}`);
  }
  return L.length ? `\n${L.join('\n\n')}\n` : '';
}

/** Stage 0: draft a contract.json from a free-form feature description. */
export function buildContractDraftPrompt(intent, { lang = 'javascript' } = {}) {
  return `You are drafting a Polygraph verification contract for a NEW piece of
stateful ${lang} code, before any of it is written. The contract is the design
spec: observable state, the action alphabet, and the rules a reader would need
to reproduce the behavior.

## Feature intent

${intent}

## What to produce

A single JSON object matching this shape:

{
  "lang": "${lang}",
  "stateKeys": [{ "name": "...", "type": "..." }, ...],
  "initState": { ... },
  "actions": { "ACTION_NAME": { "dataFields": { "field": "type note" } }, ... },
  "dataDomain": { "ACTION_NAME": { "field": ["concrete", "enumerable", "values"] } },
  "terminalStates": ["..."],
  "specialRules": [{ "name": "...", "note": "...", "whenState": "...", "whenAction": "..." }],
  "noOpRule": "An action that does not apply in the current state yields post == pre."
}

Rules:
  - stateKeys: the MINIMAL set of fields the behavior depends on. No display
    strings, timestamps, or IDs that don't drive transitions. The FIRST key is
    the primary control state (a small enum).
  - actions: the discrete events that step the machine. Model time and any
    external result (e.g. a payment processor's response) as fields in the
    action's data, never as something the code reads from a clock or an API.
  - dataDomain: EVERY data field declared in "actions" MUST have a matching
    entry here with its full set of concrete values (e.g. a result field with
    values 'ok'/'declined'/'error' -> ["ok","declined","error"]). This is not
    optional, twice over: (1) the model checker explores exactly this domain,
    and any action field missing from dataDomain is silently EXCLUDED from
    exploration — which would make bugs in that action's handling unreachable
    to find; (2) these domains are ALSO the generated module's declared intent
    domains — the exploration and transpilation sets rendered directly into
    the code's own manifest — so a missing entry blocks generation outright.
    Keep domains small and finite (booleans, small enums, 2-3 representative
    numbers), never open-ended.
  - specialRules: guards, rewrites, or special cases that live outside the
    main state table — the cases a careless implementation is most likely to
    get wrong or omit. Name every one you can think of; each becomes a target
    for extra test coverage later, and each becomes a REQUIRED named
    reject(reason) case in the generated code. "note" may be a full sentence,
    but "whenState"/"whenAction" MUST be a single EXACT value already declared
    above — the bare primary-state value (e.g. "pending", not
    "status == 'pending'") and the bare action name (e.g. "ATTEMPT", not
    "ATTEMPT (expired == true)"). A rule that only applies for a specific data
    value belongs in the "note" text, not encoded into whenState/whenAction —
    coverage tooling matches these two fields by exact string equality, so
    anything else silently reports the rule as zero-coverage even when it is
    well-covered.
  - terminalStates: values of the primary state key where the scenario ends.

## Output

Output EXACTLY ONE fenced \`\`\`json code block containing the contract object,
and nothing else (no prose).`;
}

/** Stage 1: author the machine module satisfying a (possibly just-drafted) contract. */
export function buildAuthorPrompt(contract, intent, { lang = 'javascript', mode = 'sam' } = {}) {
  const fence = fenceFor(lang);
  if (mode === 'legacy') {
    return `Write a NEW plain ${lang} transition function implementing the feature
below — NO libraries, NO frameworks, NO I/O. Just a pure function over the
observable state, built to satisfy the contract exactly.

## Feature intent

${intent}

## Observable state (EXACTLY these keys)

The state is a plain object with EXACTLY these keys — declare no others:

${renderStateKeys(contract)}

Do NOT add any other keys.

## Module contract (hard requirements)

You MUST export exactly:

    module.exports = { init, next };

  - \`init()\` returns the initial state:
    ${renderInitState(contract)}
  - \`next(state, action, data)\` is a PURE function returning the NEW state
    (same keys) after applying ONE action:
      * \`state\`  — the current state object.
      * \`action\` — one of the strings, with its data shape:
${renderActions(contract)}
    Do NOT mutate \`state\`; return a new object. No I/O, timers, randomness, or
    external state — model an ambiguous/transient result (e.g. a network
    timeout) as an explicit data value on the action, handled the same way
    everywhere it can occur.

## Terminal states

${renderTerminalStates(contract)}

## Special rules (apply ALL of these — do not omit any)

${renderSpecialRules(contract)}

## The no-op rule

An action that does not apply in the current state must return the state
UNCHANGED (post == pre), never throw and never silently do nothing-but-differ.

## Output

Output EXACTLY ONE fenced \`\`\`${fence} code block containing the module, and
nothing else (no prose).`;
  }
  return `You are an expert in the SAM pattern (State-Action-Model,
https://sam.js.org) — a JavaScript software engineering pattern grounded in
TLA+ semantics: actions compute proposals, the model accepts or rejects them
in a synchronized step, and state is a pure function of the model.

Write a NEW ${lang} state machine implementing the feature below as a SAM
module using the @cognitive-fab/sam-pattern library, version 2 STRICT
PROFILE — NO other libraries, NO frameworks, NO I/O. Build it to satisfy the
contract exactly.

## Feature intent

${intent}

## Observable state (EXACTLY these keys)

${renderStateKeys(contract)}

Do NOT add any other keys and do NOT keep any hidden bookkeeping state — the
strict profile THROWS on any write to an undeclared model key. Model time and
any external result (e.g. a payment processor's response) as explicit data
values on actions, handled the same way everywhere they can occur.

## Mandatory module contract (v2 strict profile — hard requirements)

${v2ModuleContract(contract)}

## Terminal states

${renderTerminalStates(contract)}

## Special rules (REQUIRED reject(reason) cases — apply ALL, omit none)

Each rule below must be an OBSERVABLE rejection in the matching acceptor —
never a silent fall-through:

${renderSpecialRulesAsRejections(contract)}

## The no-op rule

An action that does not apply in the current state must be an observable
no-op via \`reject(reason)\`: post == pre, never a throw and never a silent
fall-through.

## Output

Output EXACTLY ONE fenced \`\`\`${fence} code block containing the complete,
self-contained CommonJS module following the v2 strict contract above, and
nothing else (no prose).`;
}

/** Stage 2: propose invariants.mjs given the authored code + the original intent. */
export function buildInvariantsPrompt(contract, code, intent, { lang = 'javascript', mode = 'sam' } = {}) {
  const machineNote = mode === 'legacy'
    ? 'The transition function under review'
    : `The SAM v2 module under review (invariant predicates receive its
getState() snapshot — a plain object with exactly the contract's state keys)`;
  return `Given the feature intent and the code below, propose
invariants — rules encoding what the code SHOULD do (intent), independent of
what it happens to do. These will be model-checked by exhaustively exploring
every reachable state from init(), so word them as properties that must ALWAYS
hold, not as descriptions of one path.

## Feature intent

${intent}

## Special rules named in the contract (target these)

${renderSpecialRules(contract)}

## ${machineNote}

\`\`\`${fenceFor(lang)}
${code}
\`\`\`

## What to produce

An ES module matching this exact shape:

\`\`\`javascript
export const stateInvariants = [
  { name: 'kebab-case-name', pred: (state) => /* true if the rule HOLDS */ },
];
export const transitionInvariants = [
  { name: 'kebab-case-name', pred: (pre, action, data, post) => /* true if it HOLDS */ },
];
\`\`\`

Focus on the safety properties the feature exists to enforce (e.g. "a payment
is never recorded twice", "a lock only releases via an explicit unlock",
"a terminal state never re-opens") and on the special rules named in the
contract above — those are exactly the cases a subtly wrong implementation
gets wrong. Propose 2-6 invariants; fewer, sharper rules beat many vague ones.

## Output

Output EXACTLY ONE fenced \`\`\`javascript code block containing the module, and
nothing else (no prose).`;
}

/**
 * Stage 3 (repair loop): given a reachable invariant violation, ask the model
 * to patch the code — the code is wrong, not the invariant. The counterexample
 * path is rendered compactly (init -> action(data) -> ... -> violating state).
 * `triage` (v2) optionally carries { nondeterministic, replay: [...] } — the
 * sam-tv window classifications (rejected/unhandled + reasons) and the
 * determinism double-pass flag, so the repair sees WHY a window failed, not
 * only that it did.
 */
export function buildRepairPrompt(contract, code, violation, { lang = 'javascript', mode = 'sam', triage = null } = {}) {
  const pathStr = violation.path
    .map((s, i) => (i === 0 ? 'init' : `${s.action}(${JSON.stringify(s.data)})`))
    .join(' -> ');
  if (mode === 'legacy') {
    return `The transition function below was model-checked (every reachable state
from init(), explored exhaustively) against its own stated invariants. It
reaches a state that VIOLATES one. Fix the CODE — the invariant is correct by
definition; do not weaken or remove it.

## Violated invariant

**${violation.invariant}** [${violation.kind}] — ${violation.detail}

Counterexample (shortest reachable path from init):
${pathStr}

## Current code

\`\`\`${fenceFor(lang)}
${code}
\`\`\`

## Observable state (EXACTLY these keys — unchanged)

${renderStateKeys(contract)}

## Special rules (apply ALL of these — do not omit any)

${renderSpecialRules(contract)}

## Output

Output EXACTLY ONE fenced \`\`\`${fenceFor(lang)} code block containing the
CORRECTED module (still \`module.exports = { init, next }\`), and nothing else
(no prose).`;
  }
  return `The SAM v2 strict-profile module below was model-checked (every
reachable state from init(), explored exhaustively over its own declared
intent domains) against its own stated invariants. It reaches a state that
VIOLATES one. Fix the CODE — the invariant is correct by definition; do not
weaken or remove it, and do not change the declared modelShape, schemas, or
domains.

## Violated invariant

**${violation.invariant}** [${violation.kind}] — ${violation.detail}

Counterexample (shortest reachable path from init):
${pathStr}
${renderTriage(triage)}
## Current code

\`\`\`${fenceFor(lang)}
${code}
\`\`\`

## Observable state (EXACTLY these keys — unchanged)

${renderStateKeys(contract)}

## Special rules (REQUIRED reject(reason) cases — apply ALL, omit none)

${renderSpecialRulesAsRejections(contract)}

## Discipline

${DISCIPLINE_SENTENCE}. init() stays EXACTLY \`setState(INITIAL_STATE)\` (never
call \`instance({}).state()\`; \`getState()\` is the safe accessor). Commit nested-map
mutations with the top-level write \`model.<key> = { ...model.<key>, [k]: updated }\`;
flat keys may be assigned directly.

## Output

Output EXACTLY ONE fenced \`\`\`${fenceFor(lang)} code block containing the
COMPLETE corrected module (still \`${V2_EXPORTS}\`),
and nothing else (no prose).`;
}

/**
 * Syntax-retry: LLM output occasionally has a genuine syntax slip (e.g. a
 * stray `;` where a `,` belongs inside an object literal). Feed the load
 * error back and ask for a corrected FULL module, preserving semantics and
 * exports exactly — this is a mechanical fix, not a design change.
 */
export function buildSyntaxFixPrompt(source, errorMessage, { lang = 'javascript' } = {}) {
  return `The ${lang} module below fails to load with a SYNTAX error. Fix ONLY the
syntax — preserve every export, every rule, and all behavior exactly as
written; do not redesign anything.

## Load error

${errorMessage}

## Module

\`\`\`${fenceFor(lang)}
${source}
\`\`\`

## Output

Output EXACTLY ONE fenced \`\`\`${fenceFor(lang)} code block containing the
CORRECTED module, and nothing else (no prose).`;
}

/**
 * Domain-gap repair: the contract's dataDomain and the authored code come
 * from TWO INDEPENDENT model calls, so nothing guarantees they agree on enum
 * spelling (contract says 'all_ok', code checks 'success'). A value declared
 * in dataDomain but never referenced in the code means the model checker can
 * never explore whatever transition that value should gate — a coverage
 * collapse that looks like a clean "converged: true" for the wrong reason.
 */
export function buildDomainGapRepairPrompt(contract, code, gaps, { lang = 'javascript', mode = 'sam' } = {}) {
  const exportsLine = mode === 'legacy' ? 'module.exports = { init, next }' : V2_EXPORTS.replace(/;$/, '');
  const rules = mode === 'legacy'
    ? `## Special rules (apply ALL of these — do not omit any)

${renderSpecialRules(contract)}`
    : `## Special rules (REQUIRED reject(reason) cases — apply ALL, omit none)

${renderSpecialRulesAsRejections(contract)}

## Discipline

${DISCIPLINE_SENTENCE}. Do not change the declared modelShape, schemas, or
domains — fix the ACCEPTOR logic to handle every declared value.`;
  return `The code below was cross-checked against its own contract's
declared \`dataDomain\` values. Some declared values are NEVER referenced in the
code — meaning whatever behavior they're supposed to trigger is unreachable.
This is usually a naming mismatch (the code checks a different string than the
contract declares for the same concept). Fix the CODE to handle EVERY declared
value explicitly, using the contract's EXACT spelling — do not rename the
contract's values instead.

## Unreferenced dataDomain values

${gaps.map((g) => `- ${g}`).join('\n')}

## Current code

\`\`\`${fenceFor(lang)}
${code}
\`\`\`

## Observable state (EXACTLY these keys — unchanged)

${renderStateKeys(contract)}

${rules}

## Output

Output EXACTLY ONE fenced \`\`\`${fenceFor(lang)} code block containing the
COMPLETE corrected module (still \`${exportsLine}\`), and nothing else
(no prose).`;
}

/**
 * Stage 4: propose a scenario list (JSON) to drive the FINAL code through a
 * demo/regression trace corpus. polygen.mjs executes these locally against the
 * generated machine to produce ground-truth NDJSON — the model never writes
 * the driver itself, only the action sequences.
 */
export function buildScenariosPrompt(contract, code, { lang = 'javascript', mode = 'sam' } = {}) {
  const noOpNote = mode === 'legacy'
    ? 'no-op actions (an action that does not apply in the current state)'
    : `no-op actions (an action the machine REJECTS in the current state —
these replay as observable \`reject(reason)\` no-ops: post == pre)`;
  return `Given the state machine below, propose a set of named scenarios —
sequences of (action, data) steps — that exercise it as a regression/demo trace
corpus. Cover: the normal path, each special rule named below (at least 3
windows each), dunning/retry-style loops if present, and ${noOpNote}. Every
scenario MUST end by driving the machine to one of the declared terminal
states, if any are declared. Every data payload MUST use values from the
contract's declared dataDomain (the machine's schemas reject anything else).

## The state machine

\`\`\`${fenceFor(lang)}
${code}
\`\`\`

## Terminal states

${renderTerminalStates(contract)}

## Special rules (each needs >= 3 covering windows)

${renderSpecialRules(contract)}

## Output

A single JSON object: { "scenario_name": [["ACTION", {data}], ...], ... }.
Output EXACTLY ONE fenced \`\`\`json code block, and nothing else (no prose).`;
}
