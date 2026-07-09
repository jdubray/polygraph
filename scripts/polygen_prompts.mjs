// Prompt builders for polygen (author mode): write NEW verifiable code
// out of the box, instead of deriving a spec from existing code.
//
// Mirrors build_prompt.mjs's placeholder discipline: function-form
// replaceAll (avoids $-pattern mangling) and any embedded free-form text
// (intent, prior code, violation detail) substituted LAST so nothing in it
// can be reinterpreted as a later placeholder.
import { renderStateKeys, renderInitState, renderActions, renderSpecialRules, renderTerminalStates } from './contract_render.mjs';

const LANG_FENCE = { javascript: 'javascript', typescript: 'typescript', js: 'javascript', ts: 'typescript' };
const fenceFor = (lang) => LANG_FENCE[lang] || 'javascript';

/** Stage 0: draft a contract.json from a free-form feature description. */
export function buildContractDraftPrompt(intent, { lang = 'javascript' } = {}) {
  return `You are drafting a bare-next() verification contract for a NEW piece of
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
    action's data, never as something next() reads from a clock or an API.
  - dataDomain: EVERY data field declared in "actions" MUST have a matching
    entry here with its full set of concrete values (e.g. a result field with
    values 'ok'/'declined'/'error' -> ["ok","declined","error"]). This is not
    optional: the model checker explores exactly this domain, and any action
    field missing from dataDomain is silently EXCLUDED from exploration —
    which would make bugs in that action's handling unreachable to find. Keep
    domains small and finite (booleans, small enums, 2-3 representative
    numbers), never open-ended.
  - specialRules: guards, rewrites, or special cases that live outside the
    main state table — the cases a careless implementation is most likely to
    get wrong or omit. Name every one you can think of; each becomes a target
    for extra test coverage later.
  - terminalStates: values of the primary state key where the scenario ends.

## Output

Output EXACTLY ONE fenced \`\`\`json code block containing the contract object,
and nothing else (no prose).`;
}

/** Stage 1: author init()/next() satisfying a (possibly just-drafted) contract. */
export function buildAuthorPrompt(contract, intent, { lang = 'javascript' } = {}) {
  const fence = fenceFor(lang);
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

/** Stage 2: propose invariants.mjs given the authored code + the original intent. */
export function buildInvariantsPrompt(contract, code, intent, { lang = 'javascript' } = {}) {
  return `Given the feature intent and the transition function below, propose
invariants — rules encoding what the code SHOULD do (intent), independent of
what it happens to do. These will be model-checked by exhaustively exploring
every reachable state from init(), so word them as properties that must ALWAYS
hold, not as descriptions of one path.

## Feature intent

${intent}

## Special rules named in the contract (target these)

${renderSpecialRules(contract)}

## The transition function under review

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
 * to patch next() — the code is wrong, not the invariant. The counterexample
 * path is rendered compactly (init -> action(data) -> ... -> violating state).
 */
export function buildRepairPrompt(contract, code, violation, { lang = 'javascript' } = {}) {
  const pathStr = violation.path
    .map((s, i) => (i === 0 ? 'init' : `${s.action}(${JSON.stringify(s.data)})`))
    .join(' -> ');
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
 * Stage 4: propose a scenario list (JSON) to drive the FINAL code through a
 * demo/regression trace corpus. polygen.mjs executes these locally against the
 * generated next() to produce ground-truth NDJSON — the model never writes
 * the driver itself, only the action sequences.
 */
export function buildScenariosPrompt(contract, code, { lang = 'javascript' } = {}) {
  return `Given the transition function below, propose a set of named scenarios —
sequences of (action, data) steps — that exercise it as a regression/demo trace
corpus. Cover: the normal path, each special rule named below (at least 3
windows each), dunning/retry-style loops if present, and no-op actions (an
action that does not apply in the current state). Every scenario MUST end by
driving the machine to one of the declared terminal states, if any are
declared.

## The transition function

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
