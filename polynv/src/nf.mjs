// polynv normal form — the SAM-tuned property grammar (plan §2, §10.2):
// the ONE vocabulary that templates and miners both emit, so implication
// pruning and question dedup operate on structure, not on JS text. Tuned to
// SAM strict-profile machines deliberately: the model is sealed (so
// key-presence properties are vacuous by construction and do not appear),
// control flow lives in a declared control key (so implications condition on
// it), and rejects are identity edges (so temporal "occurrence" means an
// effective, state-changing edge).
//
// Each nf has a `kind` and params. Two consumers:
//   compile(nf)  → { target, pred }  — a live predicate for the pre-check
//   renderJs(nf) → JS source string  — embedded in the generated invariants.mjs
// The two MUST agree; every kind below defines both from the same shape.
//
// target: 'state' (pred(s)), 'transition' (pred(pre, action, data, post)),
// 'emission' (effect-path invariant — check-effects territory), or
// 'temporal' (precedence over action occurrences — checked against the
// reachable graph by consequences.mjs, not compilable into invariants.mjs).
// Non-compilable targets are carried as questions and reported as such,
// never silently dropped.
//
// Grammar kinds: range · nonneg · in-domain · ordering · implication ·
// set-once · monotone · terminal-absorbing · reject-in-state ·
// emission-at-most-once · precedence · js (free-form escape hatch).
'use strict';

// Canonical stringify (key-order-insensitive) — the same equality convention
// as stable() in scripts/load-spec.mjs, duplicated here ONLY because the
// generated invariants.mjs must be self-contained (the artifact convention:
// invariants files import nothing). HELPERS_SRC below embeds the same code.
export const canon = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object')
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v) ?? 'undefined';
};
export const sameOn = (keys) => (a, b) => keys.every((k) => canon(a[k]) === canon(b[k]));

// The helper block embedded verbatim at the top of every generated
// invariants.mjs — keep in sync with canon/sameOn above.
export const HELPERS_SRC = `const canon = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object')
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v) ?? 'undefined';
};
const sameOn = (keys) => (a, b) => keys.every((k) => canon(a[k]) === canon(b[k]));`;

const q = JSON.stringify;

// Comparison vocabulary shared by 'implication' and 'ordering'. 'in'
// compares canonically so object/array domain values work.
const OPS = {
  eq: (a, b) => canon(a) === canon(b),
  ne: (a, b) => canon(a) !== canon(b),
  ge: (a, b) => a >= b,
  le: (a, b) => a <= b,
  gt: (a, b) => a > b,
  lt: (a, b) => a < b,
  in: (a, b) => b.some((v) => canon(v) === canon(a)),
  nonempty: (a) => a !== '' && a !== null && a !== undefined,
  empty: (a) => a === '' || a === null || a === undefined,
};
const OPS_SRC = {
  eq: (a, b) => `canon(${a}) === canon(${b})`,
  ne: (a, b) => `canon(${a}) !== canon(${b})`,
  ge: (a, b) => `${a} >= ${b}`,
  le: (a, b) => `${a} <= ${b}`,
  gt: (a, b) => `${a} > ${b}`,
  lt: (a, b) => `${a} < ${b}`,
  in: (a, b) => `${b}.some((v) => canon(v) === canon(${a}))`,
  nonempty: (a) => `(${a} !== '' && ${a} !== null && ${a} !== undefined)`,
  empty: (a) => `(${a} === '' || ${a} === null || ${a} === undefined)`,
};
const opCheck = (op) => { if (!OPS[op]) throw new Error(`unknown op '${op}' (${Object.keys(OPS).join('|')})`); };

// Compile a free-form JS predicate string. Used for kind 'js' (domain priors,
// designer modifications). SECURITY BOUNDARY, stated plainly: this executes
// the string as code, exactly as `import(invariants.mjs)` executes that
// artifact everywhere else in the pipeline. The only sources of these strings
// are the designer's own CLI input (`polynv add/record --js`) and the
// git-tracked intent-ledger.json — the same human-reviewed trust tier as
// invariants.mjs itself. Nothing network-derived or model-generated reaches
// here without the designer typing/reviewing it first; do not wire this to
// any such source without adding a review gate.
export function compileJs(js) {
  let fn;
  try {
    fn = new Function(`return (${js})`)();
  } catch (e) {
    throw new Error(`predicate does not parse as a JS expression: ${e && e.message}`);
  }
  if (typeof fn !== 'function') throw new Error('predicate must be a function expression');
  return fn;
}

export function compile(nf) {
  switch (nf.kind) {
    case 'terminal-absorbing': {
      const { key, value, stateKeys } = nf;
      const same = sameOn(stateKeys);
      return { target: 'transition', pred: (pre, action, data, post) => pre[key] !== value || same(pre, post) };
    }
    case 'range': {
      const { field, min, max } = nf;
      return { target: 'state', pred: (s) => typeof s[field] === 'number' && s[field] >= min && s[field] <= max };
    }
    case 'nonneg': {
      const { field } = nf;
      return { target: 'state', pred: (s) => typeof s[field] === 'number' && s[field] >= 0 };
    }
    case 'set-once': {
      const { field, empty } = nf;
      return { target: 'transition', pred: (pre, action, data, post) => pre[field] === empty || post[field] === pre[field] };
    }
    case 'monotone': {
      const { field } = nf;
      return { target: 'transition', pred: (pre, action, data, post) => post[field] >= pre[field] };
    }
    case 'reject-in-state': {
      const { actions, key, value, stateKeys } = nf;
      const same = sameOn(stateKeys);
      return { target: 'transition', pred: (pre, action, data, post) => !(actions.includes(action) && pre[key] === value) || same(pre, post) };
    }
    case 'in-domain': {
      const { field, values } = nf;
      return { target: 'state', pred: (s) => OPS.in(s[field], values) };
    }
    case 'ordering': {
      const { a, op, b } = nf;
      opCheck(op);
      return { target: 'state', pred: (s) => OPS[op](s[a], s[b]) };
    }
    case 'implication': {
      // when the control condition holds, the consequent must: s[when.field]
      // == when.value  ⇒  OPS[then.op](s[then.field], then.value)
      const { when, then } = nf;
      opCheck(then.op);
      return { target: 'state', pred: (s) => canon(s[when.field]) !== canon(when.value) || OPS[then.op](s[then.field], then.value) };
    }
    case 'js':
      return { target: nf.target, pred: compileJs(nf.js) };
    case 'emission-at-most-once':
      return { target: 'emission', pred: null };
    case 'precedence':
      // temporal safety — checked against the reachable graph
      // (consequences.mjs checkPrecedence), not compilable to a pointwise pred
      return { target: 'temporal', pred: null };
    default:
      throw new Error(`unknown normal-form kind '${nf.kind}'`);
  }
}

export function renderJs(nf) {
  switch (nf.kind) {
    case 'terminal-absorbing':
      return `(pre, action, data, post) => pre[${q(nf.key)}] !== ${q(nf.value)} || sameOn(${q(nf.stateKeys)})(pre, post)`;
    case 'range':
      return `(s) => typeof s[${q(nf.field)}] === 'number' && s[${q(nf.field)}] >= ${q(nf.min)} && s[${q(nf.field)}] <= ${q(nf.max)}`;
    case 'nonneg':
      return `(s) => typeof s[${q(nf.field)}] === 'number' && s[${q(nf.field)}] >= 0`;
    case 'set-once':
      return `(pre, action, data, post) => pre[${q(nf.field)}] === ${q(nf.empty)} || post[${q(nf.field)}] === pre[${q(nf.field)}]`;
    case 'monotone':
      return `(pre, action, data, post) => post[${q(nf.field)}] >= pre[${q(nf.field)}]`;
    case 'reject-in-state':
      return `(pre, action, data, post) => !(${q(nf.actions)}.includes(action) && pre[${q(nf.key)}] === ${q(nf.value)}) || sameOn(${q(nf.stateKeys)})(pre, post)`;
    case 'in-domain':
      return `(s) => ${OPS_SRC.in(`s[${q(nf.field)}]`, q(nf.values))}`;
    case 'ordering':
      return `(s) => ${OPS_SRC[nf.op](`s[${q(nf.a)}]`, `s[${q(nf.b)}]`)}`;
    case 'implication':
      return `(s) => canon(s[${q(nf.when.field)}]) !== canon(${q(nf.when.value)}) || ${OPS_SRC[nf.then.op](`s[${q(nf.then.field)}]`, q(nf.then.value))}`;
    case 'js':
      return nf.js;
    case 'emission-at-most-once':
    case 'precedence':
      return null; // not compilable — carried as a question, reported on confirm
    default:
      throw new Error(`unknown normal-form kind '${nf.kind}'`);
  }
}
