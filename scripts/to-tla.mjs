#!/usr/bin/env node
// to-tla.mjs — mechanical JS-SAM -> TLA+ transpiler (Polygraph TLC tier).
//
// Ported from SysMoBench's tools/js-sam/to-tla.mjs (the v2 keyed-acceptor
// front end that transpiled 20/20 generated v2 specs), with its two
// etcd-specific hardcodings generalized:
//   (a) the invariant pack is no longer built in: state invariants are read
//       as JS predicate sources from the Polygraph contract's invariants
//       file ({ stateInvariants: [{ name, pred: (state) => bool }] }) and
//       mechanically translated to TLA+ where the predicate stays inside a
//       small translatable subset; anything outside it is REFUSED loudly
//       with the offending construct named. transitionInvariants
//       (predicates over (pre, action, data, post)) are action properties,
//       not state predicates — they are out of scope for the TLC INVARIANT
//       tier as a category and are reported as skipped by kind (check.mjs
//       still checks them in JS).
//   (b) the state shape is still a map of flat records under ONE top-level
//       key, but the key name and the record fields are read from the
//       spec's init state (and cross-checked against the contract's
//       stateKeys when --contract is given) instead of assuming 'nodes'.
//
// Reads a JS-SAM spec module (contract: { instance, init, actions, getState,
// setState[, checkerIntents] }; payload domains come from checkerIntents or,
// for v2 strict-profile specs, from instance({}).manifest()) and emits a
// TLA+ module plus a TLC .cfg:
//
//   - each SAM acceptor        -> one TLA+ action
//       early-return guards      -> negated conjunct preconditions
//       sequential mutations     -> a single primed EXCEPT update, computed by
//                                   symbolic execution (later reads see earlier
//                                   writes, matching JS sequential semantics)
//   - checkerIntents payloads  -> finite payload-record sets; each action is
//                                 existentially quantified over its set
//   - init()/getState()        -> Init (the initial-state assignment)
//
// Acceptor bodies must stay inside a restricted "transpilable subset":
//   * a leading flag guard `if (!p.<actionFlag>) return;` (binds the acceptor
//     to its action; dropped, since the payload domain satisfies it)
//   * further top-level early returns `if (cond) return;` BEFORE any mutation
//   * one alias binding `const n = model.<stateVar>[p.<key>];`
//   * `const x = <expr>;` locals
//   * plain / compound assignment (`=`, `+=`, `-=`) and `++`/`--` on alias
//     fields
//   * `if (cond) { ... } [else { ... }]` blocks (no returns inside)
//   * expressions over: literals, p.<field>, alias fields, locals,
//     + - * === !== == != < <= > >= && || !, Math.max/Math.min,
//     String(x) on string-typed x, and ternaries
// Anything else fails loudly with a named diagnostic — transpilability is a
// checkable property of the spec, not a best-effort guess.
//
// E1 front-end extensions (noted; mechanically equivalent sugar, no new
// semantics):
//   * binding guard may also dispatch on any discriminator key whose string
//     literals are distinct across actions (`if (p.kind !== 'X') return;`,
//     `__name`/`type`/`kind`/...); leading `!p ||` disjuncts are dropped;
//     non-binding early-return guards before the binder are kept as guards
//   * `const { a, b } = p;` payload destructuring == `const a = p.a; ...`
//   * JS truthiness in test positions (str /= "", num /= 0), value-semantics
//     `a || b` / `a && b`, and constant-folded comparisons with `undefined`
//   * direct state reads `model.<sv>[e]` (domain check) and
//     `model.<sv>[e].<field>` (before any mutation only)
// Parse errors in the input now yield a graceful diagnostic instead of an
// unhandled acorn exception (robustness fix).
//
// E1-v2 front end (sam-lib 2.0.0-alpha strict profile; same back end):
//   * `acceptors` may be an OBJECT keyed by intent name — binding is
//     structural (the key IS the action name), so no flag/discriminator
//     guard inference is needed at all
//   * acceptor signature (model) => (p, { reject }) => { ... };
//     `return reject('reason')` is treated exactly like a bare-return guard
//   * the v2 commit idiom `model.<sv> = { ...model.<sv>, [key]: rec }` is the
//     state write; `rec` is either an inline record literal (`{ ...n, f: e }`
//     spread-with-overrides or a full field list) or a local record object
//     (`const up = { ...n }; up.f = e; ...`) built by the same symbolic
//     execution and committed at the end
//   * `let` locals with (guarded) reassignment; record-object locals; helper
//     calls with inline record arguments
//   * alias reads are SNAPSHOT reads (`const n = model.<sv>[k]` captures the
//     pre-state record; the spread commit replaces the map, it never mutates
//     the captured record), so reads after a commit see the pre-state —
//     matching JS reference semantics exactly
//   * in-place writes through the alias (`n.f = e`) are nested writes that
//     bypass the strict-profile write tracker — rejected, not guessed at
//
// E1-v2.1 front end (sam-lib 2.1 strict profile; next-state acceptors):
//   * acceptor signature (model) => (p, { reject, next, unchanged }) => {...}
//     — any subset of { reject, next, unchanged }, any order. The bare
//     { reject } 2.0 form is still accepted (legacy specs transpile), but a
//     body that destructures `next`/`unchanged` is a 2.1 body: writing
//     model.* there is a runtime SamShapeError and is refused loudly.
//   * `next.<var> = expr` is THE write form; `model.*` on the RHS is ALWAYS
//     the pre-state (unprimed) — even after a next-write. There is no
//     sequential-mutation fold in 2.1 bodies.
//   * `unchanged('a','b')` (statement or `return unchanged(...)`) is an
//     explicit frame declaration: validated (unknown names and frames that
//     contradict an unconditional next-write are refused loudly), then a
//     no-op — UNCHANGED emission derives from the unwritten-variable
//     analysis.
//   * a second state shape joins the map-of-flat-records one: FLAT SCALAR
//     state (every top-level key is num/str/bool). Each key becomes its own
//     TLA+ VARIABLE; per action, written vars get primed assignments and the
//     rest one UNCHANGED <<...>> conjunct. The map shape keeps its EXCEPT
//     commit (written `next.<sv> = { ...model.<sv>, [k]: rec }` in 2.1).
//
// A bare { init, next } module has no acceptors: its guards are implicit in
// arbitrary control flow (loops, dispatch on the action string, object
// spreads), so there is nothing mechanical to lift into preconditions. The
// transpiler detects that shape and reports the first offending construct.
//
// Usage:
//   node to-tla.mjs <spec.js> --out <path/Module.tla> [--bound N]
//                   [--invariants <invariants.mjs>] [--contract <contract.json>]
// The module name is derived from the output file's basename; a matching
// <Module>.cfg (INIT/NEXT/INVARIANT/CONSTRAINT) is written alongside.
//
// Invariants source resolution order:
//   1. --invariants <path>
//   2. the contract's "invariants" field (resolved relative to the contract)
//   3. an invariants.mjs sibling of the contract file
// With no source found, the module is emitted with NO INVARIANT lines (TLC
// then only explores + deadlock-checks) and a loud warning is printed.
//
// Module API (used by verify.mjs): transpile(specPath, opts) below.
'use strict';

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acorn from 'acorn';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let SRC = '';
let FILE = '';

/** Loud, named transpiler refusal — thrown, so module callers can catch it. */
export class TranspileError extends Error {}

async function main() {
  const args = process.argv.slice(2);
  let specPath = null;
  let outPath = null;
  let bound = 3;
  let invariantsPath = null;
  let contractPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outPath = args[++i];
    else if (args[i] === '--bound') bound = Number(args[++i]);
    else if (args[i] === '--invariants') invariantsPath = args[++i];
    else if (args[i] === '--contract') contractPath = args[++i];
    else if (!specPath) specPath = args[i];
    else die(`unexpected argument '${args[i]}'`);
  }
  if (!specPath || !outPath) {
    die(
      'usage: node to-tla.mjs <spec.js> --out <Module.tla> [--bound N] ' +
        '[--invariants <invariants.mjs>] [--contract <contract.json>]'
    );
  }
  const res = await transpile(specPath, { outPath, bound, invariantsPath, contractPath });
  console.log(`to-tla: wrote ${res.tlaPath}`);
  console.log(`to-tla: wrote ${res.cfgPath}`);
  console.log(
    `to-tla: ${res.actions.length} actions: ` +
      res.actions.map((a) => `${a.name}(${a.payloadCount})`).join(', ')
  );
  console.log(
    `to-tla: ${res.invariants.length} invariant(s) translated: ` +
      (res.invariants.join(', ') || '(none)')
  );
  for (const s of res.skippedInvariants) {
    console.log(`to-tla: SKIPPED (by kind) ${s.kind} invariant '${s.name}': ${s.reason}`);
  }
}

/**
 * Transpile a JS-SAM spec module to TLA+ (module function for verify.mjs).
 *
 * @param {string} specPath   path to the spec module (CommonJS)
 * @param {object} opts
 * @param {string} opts.outPath          output .tla path (module name = basename)
 * @param {number} [opts.bound]          numeric-counter state constraint (default 3)
 * @param {string} [opts.invariantsPath] invariants.mjs path (overrides contract)
 * @param {string} [opts.contractPath]   Polygraph contract.json (state-shape
 *                                       cross-check + invariants auto-detect)
 * @returns {Promise<{tlaPath, cfgPath, moduleName, stateVar, actions,
 *                    invariants, skippedInvariants}>}
 * @throws {TranspileError} on any construct outside the transpilable subset
 */
export async function transpile(specPath, opts) {
  const { outPath, bound = 3, invariantsPath = null, contractPath = null } = opts;

  FILE = path.resolve(specPath);
  SRC = readFileSync(FILE, 'utf8');
  let ast;
  try {
    ast = acorn.parse(SRC, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      locations: true,
    });
  } catch (err) {
    const loc = err.loc ? `${FILE}:${err.loc.line}:${err.loc.column}` : FILE;
    die(`spec is not parseable JavaScript\n  at ${loc}\n    ${err.message}`);
  }

  // --- static shape check: is this a SAM spec at all? ----------------------
  // v1: acceptors is an ARRAY (binding via flag/discriminator guards).
  // v2 (strict profile): acceptors is an OBJECT keyed by intent name.
  const acceptors = findArrayProperty(ast, 'acceptors');
  const acceptorsV2 = acceptors ? null : findAcceptorsObject(ast);
  if (!acceptors && !acceptorsV2) {
    bareNextDiagnostic(ast);
    die('no SAM acceptors found — not a transpilable SAM spec (see diagnostic above)');
  }
  let flagToName = {}, actionNames = new Set(), discToName = {}, dataKeys = new Set();
  if (acceptors) {
    ({ flagToName, actionNames, discToName, dataKeys } = collectActionFlags(ast));
    if (actionNames.size === 0) {
      die('found an acceptors array but no SAM actions array with ' +
          "'{ __name, ... }' proposal shapes — cannot bind acceptors " +
          'to action names');
    }
  }

  // --- dynamic extraction: initial state + payload domains -----------------
  // The behaviour is translated statically from the AST; the *data* (initial
  // state and the finite payload domains) is plain JSON that the spec module
  // can just hand us.
  const { state, intents } = probeSpec(FILE);
  const stateKeys = Object.keys(state);
  // Two supported shapes:
  //   'scalar' — every top-level state key holds a scalar (num/str/bool);
  //              each key becomes its own TLA+ VARIABLE, acceptors write
  //              them via the 2.1 next-state form (next.<var> = expr) and
  //              unwritten variables become UNCHANGED conjuncts per action.
  //   'map'    — exactly one top-level key holding a map of flat records
  //              (the original shape; one VARIABLE updated with EXCEPT).
  const mode =
    stateKeys.length > 0 && stateKeys.every((k) => jsType(state[k]) !== 'unknown')
      ? 'scalar'
      : 'map';
  let stateVar = null;
  let nodesObj = null;
  let fieldNames = [];
  let fieldTypes = {};
  let scalarVars = [];
  const scalarTypes = {};
  if (mode === 'scalar') {
    scalarVars = stateKeys;
    for (const k of stateKeys) scalarTypes[k] = jsType(state[k]);
  } else {
    if (stateKeys.length !== 1) {
      die(`unsupported state shape: expected either all-scalar top-level state ` +
          `keys or exactly one top-level key holding a map of flat records, ` +
          `got [${stateKeys.join(', ')}]`);
    }
    stateVar = stateKeys[0];
    nodesObj = state[stateVar];
    if (!nodesObj || typeof nodesObj !== 'object' || Array.isArray(nodesObj)) {
      die(`unsupported state shape: '${stateVar}' is not a map of records`);
    }
    const nodeIds = Object.keys(nodesObj);
    if (nodeIds.length === 0) {
      die(`unsupported state shape: '${stateVar}' has no entries in the init state`);
    }
    fieldNames = Object.keys(nodesObj[nodeIds[0]]);
    fieldTypes = {};
    for (const f of fieldNames) fieldTypes[f] = jsType(nodesObj[nodeIds[0]][f]);
    for (const id of nodeIds) {
      const rec = nodesObj[id];
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        die(`unsupported state shape: '${stateVar}["${id}"]' is not a flat record`);
      }
      const fields = Object.keys(rec);
      if (
        fields.length !== fieldNames.length ||
        fields.some((f) => !fieldNames.includes(f))
      ) {
        die(
          `unsupported state shape: records under '${stateVar}' do not share ` +
            `one field set ("${id}" has [${fields.join(', ')}], ` +
            `"${nodeIds[0]}" has [${fieldNames.join(', ')}])`
        );
      }
      for (const f of fields) {
        if (jsType(rec[f]) === 'unknown') {
          die(
            `unsupported state shape: field '${f}' of '${stateVar}["${id}"]' is ` +
              `not a scalar (num/str/bool) — nested structures are outside the ` +
              'map-of-flat-records subset'
          );
        }
      }
    }
  }

  // --- contract cross-check (generalization (b)) ---------------------------
  // The contract (when given) names the observable state keys; the transpiler
  // requires exactly one, and it must be the same top-level key the spec's
  // init state exposes.
  let contract = null;
  if (contractPath) {
    contract = JSON.parse(readFileSync(path.resolve(contractPath), 'utf8'));
    const names = (contract.stateKeys || []).map((k) =>
      typeof k === 'string' ? k : k.name
    );
    if (mode === 'scalar') {
      const missing = scalarVars.filter((v) => !names.includes(v));
      const extra = names.filter((n) => !scalarVars.includes(n));
      if (missing.length || extra.length) {
        die(
          `contract state keys [${names.join(', ')}] do not match the spec's ` +
            `top-level scalar state keys [${scalarVars.join(', ')}]`
        );
      }
    } else {
      if (names.length !== 1) {
        die(
          `contract declares ${names.length} state keys [${names.join(', ')}] — ` +
            'the map-of-records TLC tier supports exactly one top-level key ' +
            'holding a map of flat records'
        );
      }
      if (names[0] !== stateVar) {
        die(
          `contract state key '${names[0]}' does not match the spec's ` +
            `top-level state key '${stateVar}'`
        );
      }
    }
  }

  const intentsByName = {};
  for (const it of intents) {
    intentsByName[it.name] = it.values.map((argv) => argv[0]);
  }

  // --- translate each acceptor ---------------------------------------------
  const spec = {
    flagToName, actionNames, discToName, dataKeys, intentsByName, stateVar,
    fieldNames, fieldTypes, mode, scalarVars, scalarTypes,
    helpers: collectHelpers(ast),
    constArrays: collectConstArrays(ast),
  };
  const actionsOut = [];
  if (acceptors) {
    if (mode === 'scalar') {
      die(
        'a v1 acceptors ARRAY over a flat scalar state is not supported — ' +
          'scalar state keys require the v2.1 strict profile (an acceptors ' +
          'OBJECT keyed by intent name, next-state writes)'
      );
    }
    for (const el of acceptors) {
      actionsOut.push(translateAcceptor(el, spec));
    }
  } else {
    for (const prop of acceptorsV2) {
      const name = prop.key.name ?? prop.key.value;
      actionsOut.push(translateAcceptorV2(name, prop.value, spec));
    }
  }

  // --- invariants (generalization (a)) --------------------------------------
  const invSource = resolveInvariantsSource(invariantsPath, contractPath, contract);
  let translatedInvariants = [];
  const skippedInvariants = [];
  if (invSource) {
    const loaded = await loadInvariants(invSource);
    const shape = { mode, stateVar, fieldNames, fieldTypes, scalarVars, scalarTypes };
    for (const inv of loaded.stateInvariants) {
      translatedInvariants.push(translateInvariant(inv, shape));
    }
    for (const inv of loaded.transitionInvariants) {
      skippedInvariants.push({
        name: inv.name,
        kind: 'transition',
        reason:
          'a transition invariant is a predicate over (pre, action, data, ' +
          'post) — an action property, not a state predicate; TLC INVARIANT ' +
          'cannot express it (check.mjs still checks it in JS)',
      });
    }
    if (loaded.stateInvariants.length === 0) {
      console.error(
        `to-tla: WARNING: ${invSource} exports no stateInvariants — the TLC ` +
          'run will only explore and deadlock-check'
      );
    }
  } else {
    console.error(
      'to-tla: WARNING: no invariants source found (--invariants, the ' +
        "contract's \"invariants\" field, or a sibling invariants.mjs) — the " +
        'TLC run will only explore and deadlock-check'
    );
  }

  // --- emit ----------------------------------------------------------------
  const moduleName = path.basename(outPath).replace(/\.tla$/i, '');
  const tla = emitModule({
    moduleName, specPath: FILE, mode, stateVar, nodesObj, fieldNames, fieldTypes,
    scalarVars, scalarTypes, scalarInit: state,
    actions: actionsOut, bound, invariants: translatedInvariants,
  });
  const cfg = emitCfg(translatedInvariants.map((iv) => iv.name));

  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  writeFileSync(outPath, tla);
  const cfgPath = outPath.replace(/\.tla$/i, '.cfg');
  writeFileSync(cfgPath, cfg);
  return {
    tlaPath: path.resolve(outPath),
    cfgPath: path.resolve(cfgPath),
    moduleName,
    stateVar,
    actions: actionsOut.map((a) => ({ name: a.name, payloadCount: a.payloads.length })),
    invariants: translatedInvariants.map((iv) => iv.name),
    skippedInvariants,
  };
}

// ---------------------------------------------------------------------------
// Invariants: load JS predicate sources, translate the translatable subset
// ---------------------------------------------------------------------------

// Resolution order: explicit --invariants path; the contract's "invariants"
// field (relative to the contract file); an invariants.mjs sibling of the
// contract. Returns an absolute path or null.
function resolveInvariantsSource(invariantsPath, contractPath, contract) {
  if (invariantsPath) {
    const p = path.resolve(invariantsPath);
    if (!existsSync(p)) die(`invariants file not found: ${p}`);
    return p;
  }
  if (contractPath) {
    const dir = path.dirname(path.resolve(contractPath));
    if (contract && typeof contract.invariants === 'string') {
      const p = path.resolve(dir, contract.invariants);
      if (!existsSync(p)) {
        die(`contract's invariants file not found: ${p}`);
      }
      return p;
    }
    const sibling = path.join(dir, 'invariants.mjs');
    if (existsSync(sibling)) return sibling;
  }
  return null;
}

// Import the invariants module and normalize to
// { stateInvariants: [{name, pred}], transitionInvariants: [{name, pred}] }.
async function loadInvariants(file) {
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    die(`could not load invariants module ${file}:\n  ${err.message}`);
  }
  const norm = (arr, what) => {
    if (arr == null) return [];
    if (!Array.isArray(arr)) die(`${what} in ${file} is not an array`);
    return arr.map((inv, i) => {
      if (!inv || typeof inv.name !== 'string' || typeof inv.pred !== 'function') {
        die(`${what}[${i}] in ${file} is not a { name, pred } record`);
      }
      return { name: inv.name, pred: inv.pred };
    });
  };
  return {
    stateInvariants: norm(mod.stateInvariants, 'stateInvariants'),
    transitionInvariants: norm(mod.transitionInvariants, 'transitionInvariants'),
  };
}

// Translate one state-invariant predicate `(state) => bool` to a TLA+
// definition. The predicate must stay inside the invariant subset:
//   * quantification:  Object.values(state.<sv>).every((n) => ...)
//                      Object.keys(state.<sv>).every((k) => ...)
//                      Object.entries(state.<sv>).every(([k, n]) => ...)
//                      (and .some(...) for \E); nesting allowed
//   * membership:      <literal array>.includes(e)   -> e \in {..}
//                      Object.keys(state.<sv>).includes(e) -> e \in DOMAIN sv
//                      truthiness of state.<sv>[e]         -> e \in DOMAIN sv
//   * record reads:    n.<field> for a quantified record, state.<sv>[e].<field>
//   * scalars:         literals, === !== == != < <= > >= + - *, && || !,
//                      ternaries, Math.max/Math.min
// Anything else is refused with the construct named — the same refuse-loudly
// contract as the acceptor translator.
function translateInvariant(inv, shape) {
  const name = sanitizeTlaName(inv.name);
  const src = String(inv.pred);
  let ast;
  try {
    ast = acorn.parse(`(${src})`, { ecmaVersion: 'latest' });
  } catch (err) {
    die(
      `invariant '${inv.name}': predicate source is not parseable ` +
        `JavaScript (${err.message})\n  ${src}`
    );
  }
  const fn = ast.body[0].expression;
  if (
    (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') ||
    fn.params.length !== 1 ||
    fn.params[0].type !== 'Identifier'
  ) {
    die(
      `invariant '${inv.name}': pred must be a one-parameter function ` +
        `(state) => bool\n  ${src}`
    );
  }
  const ictx = {
    invName: inv.name,
    src,
    stateName: fn.params[0].name,
    mode: shape.mode ?? 'map',
    stateVar: shape.stateVar,
    fieldNames: shape.fieldNames,
    fieldTypes: shape.fieldTypes,
    scalarVars: shape.scalarVars ?? [],
    scalarTypes: shape.scalarTypes ?? {},
    // quantified bindings: name -> { kind: 'record'|'key', keyTla }
    bindings: new Map(),
    fresh: 0,
  };
  let body = fn.body;
  if (body.type === 'BlockStatement') {
    if (
      body.body.length !== 1 || body.body[0].type !== 'ReturnStatement' ||
      !body.body[0].argument
    ) {
      invDie(ictx, 'pred body must be a single return expression', body);
    }
    body = body.body[0].argument;
  }
  const tla = invBool(body, ictx);
  return { name, jsSource: src, tla };
}

function sanitizeTlaName(name) {
  const clean = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!clean || !/^[A-Za-z]/.test(clean)) return `Inv_${clean || 'unnamed'}`;
  return clean;
}

function invDie(ictx, msg, node) {
  const at =
    node && typeof node.start === 'number'
      ? `\n  in: ${ictx.src.slice(Math.max(0, node.start - 1), node.end - 1)}`
      : '';
  die(
    `invariant '${ictx.invName}': ${msg} — outside the translatable ` +
      `invariant subset${at}\n  pred: ${ictx.src}`
  );
}

// `state.<sv>` (or `state['<sv>']`) — the state-map reference
function isStateMapRef(node, ictx) {
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' && node.object.name === ictx.stateName &&
    ((!node.computed && node.property.type === 'Identifier' &&
      node.property.name === ictx.stateVar) ||
      (node.computed && node.property.type === 'Literal' &&
        node.property.value === ictx.stateVar))
  );
}

// `Object.values|keys|entries(state.<sv>)` -> method name, or null
function matchObjectOverState(node, ictx) {
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' && !node.callee.computed &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'Object' &&
    node.callee.property.type === 'Identifier' &&
    ['values', 'keys', 'entries'].includes(node.callee.property.name) &&
    node.arguments.length === 1 &&
    isStateMapRef(node.arguments[0], ictx)
  ) {
    return node.callee.property.name;
  }
  return null;
}

// Quantifier: Object.<m>(state.<sv>).every|some((...) => body)
function matchQuantifier(node, ictx) {
  if (
    node.type !== 'CallExpression' ||
    node.callee.type !== 'MemberExpression' || node.callee.computed ||
    node.callee.property.type !== 'Identifier' ||
    !['every', 'some'].includes(node.callee.property.name)
  ) {
    return null;
  }
  const method = matchObjectOverState(node.callee.object, ictx);
  if (!method) {
    invDie(
      ictx,
      `'.${node.callee.property.name}(...)' on something other than ` +
        `Object.values/keys/entries(${ictx.stateName}.${ictx.stateVar})`,
      node
    );
  }
  if (node.arguments.length !== 1) {
    invDie(ictx, `.${node.callee.property.name} with != 1 argument`, node);
  }
  const cb = node.arguments[0];
  if (
    (cb.type !== 'ArrowFunctionExpression' && cb.type !== 'FunctionExpression') ||
    cb.params.length !== 1
  ) {
    invDie(ictx, 'quantifier callback must be a one-parameter function', cb);
  }
  return { quant: node.callee.property.name, method, cb };
}

function invBool(node, ictx) {
  const q = node.type === 'CallExpression' ? matchQuantifier(node, ictx) : null;
  if (q) {
    const { quant, method, cb } = q;
    const v = `qi${++ictx.fresh}`;
    const saved = new Map(ictx.bindings);
    const param = cb.params[0];
    if (method === 'entries') {
      if (
        param.type !== 'ArrayPattern' || param.elements.length !== 2 ||
        !param.elements.every((el) => el && el.type === 'Identifier')
      ) {
        invDie(ictx, 'Object.entries callback must destructure ([key, rec])', param);
      }
      ictx.bindings.set(param.elements[0].name, { kind: 'key', keyTla: v });
      ictx.bindings.set(param.elements[1].name, { kind: 'record', keyTla: v });
    } else if (param.type === 'Identifier') {
      ictx.bindings.set(param.name, {
        kind: method === 'keys' ? 'key' : 'record',
        keyTla: v,
      });
    } else {
      invDie(ictx, 'quantifier callback parameter must be an identifier', param);
    }
    let body = cb.body;
    if (body.type === 'BlockStatement') {
      if (
        body.body.length !== 1 || body.body[0].type !== 'ReturnStatement' ||
        !body.body[0].argument
      ) {
        invDie(ictx, 'quantifier callback must be a single return expression', body);
      }
      body = body.body[0].argument;
    }
    const inner = invBool(body, ictx);
    ictx.bindings = saved;
    const op = quant === 'every' ? '\\A' : '\\E';
    return `(${op} ${v} \\in DOMAIN ${ictx.stateVar} : ${inner})`;
  }
  if (node.type === 'LogicalExpression' && ['&&', '||'].includes(node.operator)) {
    const a = invBool(node.left, ictx);
    const b = invBool(node.right, ictx);
    return node.operator === '&&' ? `(${a} /\\ ${b})` : `(${a} \\/ ${b})`;
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    return `~${invBool(node.argument, ictx)}`;
  }
  const r = invExpr(node, ictx);
  if (r.type === 'bool') return r.tla;
  if (r.type === 'domaincheck') return r.tla; // truthiness of state.<sv>[e]
  if (r.type === 'str') return `(${r.tla} /= "")`;
  if (r.type === 'num') return `(${r.tla} /= 0)`;
  invDie(ictx, `cannot use a value of type '${r.type}' as a boolean`, node);
}

function invExpr(node, ictx) {
  switch (node.type) {
    case 'Literal': {
      if (typeof node.value === 'number') {
        if (!Number.isInteger(node.value)) {
          invDie(ictx, 'non-integer numeric literal', node);
        }
        return { tla: String(node.value), type: 'num' };
      }
      if (typeof node.value === 'string') return { tla: `"${node.value}"`, type: 'str' };
      if (typeof node.value === 'boolean') {
        return { tla: node.value ? 'TRUE' : 'FALSE', type: 'bool' };
      }
      invDie(ictx, `literal ${node.raw}`, node);
      break;
    }
    case 'Identifier': {
      const b = ictx.bindings.get(node.name);
      if (!b) invDie(ictx, `unknown identifier '${node.name}'`, node);
      if (b.kind === 'key') return { tla: b.keyTla, type: 'str' };
      invDie(
        ictx,
        `a quantified record ('${node.name}') used as a value (only its ` +
          'fields are readable)',
        node
      );
      break;
    }
    case 'MemberExpression': {
      // scalar mode: state.<var> -> the (unprimed) TLA+ variable
      if (
        ictx.mode === 'scalar' && !node.computed &&
        node.object.type === 'Identifier' && node.object.name === ictx.stateName &&
        node.property.type === 'Identifier'
      ) {
        const sv = node.property.name;
        if (!ictx.scalarVars.includes(sv)) {
          invDie(ictx, `read of unknown state variable '${sv}' — state keys ` +
            `are [${ictx.scalarVars.join(', ')}]`, node);
        }
        return { tla: sv, type: ictx.scalarTypes[sv] ?? 'unknown' };
      }
      // <record>.<field>
      if (
        !node.computed &&
        node.object.type === 'Identifier' &&
        ictx.bindings.get(node.object.name)?.kind === 'record' &&
        node.property.type === 'Identifier'
      ) {
        const f = node.property.name;
        if (!ictx.fieldNames.includes(f)) {
          invDie(ictx, `read of unknown state field '${f}'`, node);
        }
        const b = ictx.bindings.get(node.object.name);
        return {
          tla: `${ictx.stateVar}[${b.keyTla}].${f}`,
          type: ictx.fieldTypes[f] ?? 'unknown',
        };
      }
      // state.<sv>[e]  (truthiness -> domain membership)
      if (node.computed && isStateMapRef(node.object, ictx)) {
        const k = invExpr(node.property, ictx);
        return {
          tla: `(${k.tla} \\in DOMAIN ${ictx.stateVar})`,
          type: 'domaincheck',
          keyTla: k.tla,
        };
      }
      // state.<sv>[e].<field>
      if (
        !node.computed && node.property.type === 'Identifier' &&
        node.object.type === 'MemberExpression' && node.object.computed &&
        isStateMapRef(node.object.object, ictx)
      ) {
        const f = node.property.name;
        if (!ictx.fieldNames.includes(f)) {
          invDie(ictx, `read of unknown state field '${f}'`, node);
        }
        const k = invExpr(node.object.property, ictx);
        return {
          tla: `${ictx.stateVar}[${k.tla}].${f}`,
          type: ictx.fieldTypes[f] ?? 'unknown',
        };
      }
      invDie(ictx, `member expression '${ictx.src.slice(node.start - 1, node.end - 1)}'`, node);
      break;
    }
    case 'UnaryExpression': {
      if (node.operator === '!') {
        return { tla: `~${invBool(node.argument, ictx)}`, type: 'bool' };
      }
      if (node.operator === '-') {
        const a = invExpr(node.argument, ictx);
        return { tla: `(-${a.tla})`, type: 'num' };
      }
      invDie(ictx, `unary operator '${node.operator}'`, node);
      break;
    }
    case 'BinaryExpression': {
      const map = {
        '===': '=', '==': '=', '!==': '/=', '!=': '/=',
        '<': '<', '<=': '<=', '>': '>', '>=': '>=',
        '+': '+', '-': '-', '*': '*',
      };
      const op = map[node.operator];
      if (!op) invDie(ictx, `operator '${node.operator}'`, node);
      const a = invExpr(node.left, ictx);
      const b = invExpr(node.right, ictx);
      const isCmp = ['=', '/=', '<', '<=', '>', '>='].includes(op);
      if (!isCmp && (a.type === 'str' || b.type === 'str')) {
        invDie(ictx, 'string arithmetic', node);
      }
      return { tla: `(${a.tla} ${op} ${b.tla})`, type: isCmp ? 'bool' : 'num' };
    }
    case 'LogicalExpression':
    case 'CallExpression': {
      // <literal array>.includes(e) / Object.keys(state.<sv>).includes(e)
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' && !node.callee.computed &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === 'includes' &&
        node.arguments.length === 1
      ) {
        const arg = invExpr(node.arguments[0], ictx);
        if (node.callee.object.type === 'ArrayExpression') {
          const els = node.callee.object.elements;
          if (
            !els.every(
              (el) => el && el.type === 'Literal' &&
                (typeof el.value === 'string' || typeof el.value === 'number')
            )
          ) {
            invDie(ictx, 'includes() on a non-literal array', node);
          }
          const set = els
            .map((el) => (typeof el.value === 'string' ? `"${el.value}"` : String(el.value)))
            .join(', ');
          return { tla: `(${arg.tla} \\in {${set}})`, type: 'bool' };
        }
        if (matchObjectOverState(node.callee.object, ictx) === 'keys') {
          return { tla: `(${arg.tla} \\in DOMAIN ${ictx.stateVar})`, type: 'bool' };
        }
        invDie(
          ictx,
          "includes() on something other than a literal array or " +
            `Object.keys(${ictx.stateName}.${ictx.stateVar})`,
          node
        );
      }
      // Number.isInteger / Number.isFinite on an already-numeric value: TRUE
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' && !node.callee.computed &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'Number' &&
        ['isInteger', 'isFinite'].includes(node.callee.property.name) &&
        node.arguments.length === 1
      ) {
        const a = invExpr(node.arguments[0], ictx);
        if (a.type === 'num') return { tla: 'TRUE', type: 'bool' };
        invDie(
          ictx,
          `Number.${node.callee.property.name} on a non-numeric value`,
          node
        );
      }
      // Math.max / Math.min
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' && !node.callee.computed &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'Math' &&
        ['max', 'min'].includes(node.callee.property.name) &&
        node.arguments.length === 2
      ) {
        const a = invExpr(node.arguments[0], ictx);
        const b = invExpr(node.arguments[1], ictx);
        const fn = node.callee.property.name === 'max' ? 'Max' : 'Min';
        return { tla: `${fn}(${a.tla}, ${b.tla})`, type: 'num' };
      }
      if (node.type === 'CallExpression' && matchQuantifier(node, ictx)) {
        return { tla: invBool(node, ictx), type: 'bool' };
      }
      if (node.type === 'LogicalExpression') {
        return { tla: invBool(node, ictx), type: 'bool' };
      }
      invDie(
        ictx,
        `call '${ictx.src.slice(node.start - 1, node.end - 1)}'`,
        node
      );
      break;
    }
    case 'ConditionalExpression': {
      const c = invBool(node.test, ictx);
      const a = invExpr(node.consequent, ictx);
      const b = invExpr(node.alternate, ictx);
      return {
        tla: `(IF ${c} THEN ${a.tla} ELSE ${b.tla})`,
        type: a.type === b.type ? a.type : 'unknown',
      };
    }
    default:
      invDie(ictx, `expression '${node.type}' (${friendlyName(node.type)})`, node);
  }
}

function die(msg) {
  throw new TranspileError(`to-tla: TRANSPILE ERROR: ${msg}`);
}

function failAt(msg, node) {
  const line = node && node.loc ? node.loc.start.line : '?';
  const snippet =
    node && node.loc ? (SRC.split('\n')[node.loc.start.line - 1] || '').trim() : '';
  die(`${msg}\n  at ${FILE}:${line}\n    ${snippet}`);
}

// ---------------------------------------------------------------------------
// Dynamic probe: run the spec once to read init state + checkerIntents data
// ---------------------------------------------------------------------------

function probeSpec(specPath) {
  const probe = `
    const spec = require(process.argv[1]);
    spec.init();
    const state = spec.getState();
    // Payload domains: prefer the explicit checkerIntents export; fall back
    // to the v2 strict profile's manifest() (domains are declared per intent).
    let intents = (spec.checkerIntents || []).map((ci) => ({
      name: ci.name, values: ci.values,
    }));
    if (intents.length === 0 && spec.instance) {
      const m = spec.instance({}).manifest();
      intents = Object.entries(m.intents || {}).map(([name, meta]) => ({
        name,
        values: (meta.domain || []).map((payload) => [payload]),
      }));
    }
    console.log(JSON.stringify({ state, intents }));
  `;
  // Module resolution: the spec resolves its own require()s relative to its
  // location as usual; NODE_PATH adds the plugin's node_modules plus (env
  // POLYGRAPH_SAM_NODE_PATH) an extra directory for a pinned sam-pattern v2.
  const nmPaths = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'),
  ];
  if (process.env.POLYGRAPH_SAM_NODE_PATH) {
    nmPaths.unshift(process.env.POLYGRAPH_SAM_NODE_PATH);
  }
  const r = spawnSync(process.execPath, ['-e', probe, specPath], {
    env: { ...process.env, NODE_PATH: nmPaths.join(path.delimiter) },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    die(`could not load the spec to read init state / payload domains:\n${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

function jsType(v) {
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function* walkAst(node) {
  if (!node || typeof node.type !== 'string') return;
  yield node;
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) yield* walkAst(c);
    } else if (v && typeof v.type === 'string') {
      yield* walkAst(v);
    }
  }
}

function findArrayProperty(ast, name) {
  for (const n of walkAst(ast)) {
    if (
      n.type === 'Property' &&
      ((n.key.type === 'Identifier' && n.key.name === name) ||
        (n.key.type === 'Literal' && n.key.value === name)) &&
      n.value.type === 'ArrayExpression'
    ) {
      return n.value.elements;
    }
  }
  return null;
}

// v2 strict profile: acceptors: { IntentName: (model) => (p, {reject}) => ...,
// ... } — an object whose every property value is a function. Returns the
// property list (name -> acceptor arrow) or null.
function findAcceptorsObject(ast) {
  for (const n of walkAst(ast)) {
    if (
      n.type === 'Property' &&
      ((n.key.type === 'Identifier' && n.key.name === 'acceptors') ||
        (n.key.type === 'Literal' && n.key.value === 'acceptors')) &&
      n.value.type === 'ObjectExpression'
    ) {
      const props = n.value.properties.filter((p) => p.type === 'Property');
      if (
        props.length > 0 &&
        props.length === n.value.properties.length &&
        props.every(
          (p) =>
            p.value.type === 'ArrowFunctionExpression' ||
            p.value.type === 'FunctionExpression'
        )
      ) {
        return props;
      }
    }
  }
  return null;
}

// actions: [ (data) => ({ __name: 'X', someFlag: true, ...data }), ... ]
// Also accepts flagless '{ __name: "X", ... }' builders (binding then happens
// via an '__name' dispatch guard in the acceptor) — a noted front-end
// extension over the original flag-only shape.
function collectActionFlags(ast) {
  const flagToName = {};
  const actionNames = new Set();
  // discKeyLiterals: key -> Map(stringLiteral -> actionName), for every
  // property of an action object whose value is a string literal. A key is a
  // usable discriminator iff its literals are distinct across actions.
  const discKeyLiterals = {};
  // dataKeys: proposal properties that carry the builder's payload argument
  // wholesale (`(data = {}) => ({ __name, type, data })`) — reading
  // p.<dataKey> then means "the payload record" (extension).
  const dataKeys = new Set();
  const actions = findArrayProperty(ast, 'actions');
  if (!actions) return { flagToName, actionNames, discToName: {}, dataKeys };
  for (const el of actions) {
    if (!el || el.type !== 'ArrowFunctionExpression') continue;
    let body = el.body;
    if (body.type !== 'ObjectExpression') continue;
    let paramName = null;
    if (el.params.length === 1) {
      if (el.params[0].type === 'Identifier') paramName = el.params[0].name;
      else if (
        el.params[0].type === 'AssignmentPattern' &&
        el.params[0].left.type === 'Identifier'
      ) {
        paramName = el.params[0].left.name;
      }
    }
    let name = null;
    const flags = [];
    const strProps = {};
    for (const prop of body.properties) {
      if (prop.type !== 'Property') continue;
      const key = prop.key.name || prop.key.value;
      if (key === '__name' && prop.value.type === 'Literal') name = prop.value.value;
      if (prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
        strProps[key] = prop.value.value;
      }
      if (prop.value.type === 'Literal' && prop.value.value === true) flags.push(key);
      if (
        paramName &&
        prop.value.type === 'Identifier' && prop.value.name === paramName
      ) {
        dataKeys.add(key);
      }
    }
    if (name) {
      actionNames.add(name);
      for (const f of flags) flagToName[f] = name;
      for (const [k, v] of Object.entries(strProps)) {
        if (!discKeyLiterals[k]) discKeyLiterals[k] = new Map();
        // duplicate literal under the same key -> not a discriminator
        if (discKeyLiterals[k].has(v) && discKeyLiterals[k].get(v) !== name) {
          discKeyLiterals[k].set(v, null);
        } else {
          discKeyLiterals[k].set(v, name);
        }
      }
    }
  }
  const discToName = {};
  for (const [k, m] of Object.entries(discKeyLiterals)) {
    const obj = {};
    let ok = true;
    for (const [v, n] of m) {
      if (n === null) { ok = false; break; }
      obj[v] = n;
    }
    if (ok) discToName[k] = obj;
  }
  return { flagToName, actionNames, discToName, dataKeys };
}

// Top-level `const X = ['a', 'b', ...]` literal-array constants, usable via
// `X.includes(e)` -> set membership (extension).
function collectConstArrays(ast) {
  const arrays = new Map();
  for (const st of ast.body) {
    if (st.type !== 'VariableDeclaration' || st.kind !== 'const') continue;
    for (const d of st.declarations) {
      if (
        d.id.type === 'Identifier' && d.init &&
        d.init.type === 'ArrayExpression' &&
        d.init.elements.every(
          (e) => e && e.type === 'Literal' &&
            (typeof e.value === 'string' || typeof e.value === 'number')
        )
      ) {
        arrays.set(d.id.name, d.init.elements.map((e) => e.value));
      }
    }
  }
  return arrays;
}

// Top-level pure helper functions, candidates for inlining (extension):
// `function f(a, b) {...}` / `const f = (a, b) => ...`
function collectHelpers(ast) {
  const helpers = new Map();
  const add = (name, fn) => {
    if (!fn.params.every((p) => p.type === 'Identifier')) return;
    helpers.set(name, { params: fn.params.map((p) => p.name), body: fn.body });
  };
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration' && st.id) add(st.id.name, st);
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        if (
          d.id.type === 'Identifier' && d.init &&
          (d.init.type === 'ArrowFunctionExpression' ||
            d.init.type === 'FunctionExpression')
        ) {
          add(d.id.name, d.init);
        }
      }
    }
  }
  return helpers;
}

// Inline a call to a pure helper (extension). Scalar arguments are bound as
// locals; an argument that is the primary/secondary alias makes the parameter
// an alias synonym; `model` itself may be passed through. The body must be
// side-effect free: const locals plus guard-return chains folding to one
// expression.
function buildHelperSub(node, ctx) {
  const name = node.callee.name;
  const h = ctx.helpers.get(name);
  if (ctx.inlineDepth >= 4) failAt(`helper '${name}' inlining too deep (recursion?)`, node);
  if (node.arguments.length > h.params.length) {
    failAt(`helper '${name}' called with more arguments than parameters`, node);
  }
  const sub = Object.assign({}, ctx, {
    inlineDepth: ctx.inlineDepth + 1,
    pName: '<no-proposal>',
    env: {
      alias: null,
      fields: ctx.env.fields, // shared: reads see pending symbolic writes
      locals: new Map(),
      roAliases: new Map(),
      letNames: new Set(),
    },
  });
  for (let i = 0; i < h.params.length; i++) {
    const param = h.params[i];
    const arg = node.arguments[i];
    if (!arg) failAt(`helper '${name}': missing argument for '${param}'`, node);
    if (arg.type === 'Identifier' && ctx.env.alias && arg.name === ctx.env.alias.name) {
      sub.env.alias = { name: param, keyTla: ctx.env.alias.keyTla };
    } else if (arg.type === 'Identifier' && ctx.env.roAliases.has(arg.name)) {
      sub.env.roAliases.set(param, ctx.env.roAliases.get(arg.name));
    } else if (arg.type === 'Identifier' && arg.name === ctx.modelName) {
      sub.modelName = param;
    } else {
      sub.env.locals.set(param, txExpr(arg, ctx));
    }
  }
  return { sub, h, name };
}

function inlineHelper(node, ctx) {
  const { sub, h, name } = buildHelperSub(node, ctx);
  if (h.body.type !== 'BlockStatement') {
    return txExpr(h.body, sub); // expression-bodied arrow
  }
  return foldReturnBody(h.body.body, sub, node, name);
}

// Statement-position helper call: inline a *mutating* helper (extension).
// The body is walked under the caller's path guard; returns are not allowed
// (they would exit only the helper, which the acceptor walker cannot model).
function inlineHelperStmt(node, ctx, branchCond) {
  const { sub, h, name } = buildHelperSub(node, ctx);
  if (h.body.type !== 'BlockStatement') {
    txExpr(h.body, sub); // expression body: no statements, nothing to do
    return;
  }
  for (const st of walkAst(h.body)) {
    if (st.type === 'ReturnStatement') {
      failAt(
        `mutating helper '${name}' contains a return — not inlinable in ` +
          'statement position',
        st
      );
    }
  }
  walkStmts(h.body.body, sub, false, branchCond);
  ctx.hasMutated = sub.hasMutated || ctx.hasMutated;
}

// Fold `const ...; if (c) return e; ...; return e;` into one expression.
function foldReturnBody(stmts, sctx, callNode, name) {
  const arms = []; // { cond, res }
  let finalRes = null;
  for (const st of stmts) {
    if (st.type === 'VariableDeclaration' && st.kind === 'const') {
      for (const d of st.declarations) {
        if (d.id.type !== 'Identifier' || !d.init) {
          failAt(`helper '${name}': only simple const locals are inlinable`, d);
        }
        sctx.env.locals.set(d.id.name, txExpr(d.init, sctx));
      }
      continue;
    }
    if (st.type === 'ReturnStatement') {
      if (!st.argument) failAt(`helper '${name}': bare return is not inlinable`, st);
      finalRes = txExpr(st.argument, sctx);
      break; // nothing after an unconditional return executes
    }
    if (st.type === 'IfStatement' && !st.alternate) {
      const ret = singleReturn(st.consequent);
      if (!ret || !ret.argument) {
        failAt(
          `helper '${name}': only 'if (c) return <expr>;' branches are inlinable`,
          st
        );
      }
      const cond = txBool(st.test, sctx);
      arms.push({ cond, res: txExpr(ret.argument, sctx) });
      continue;
    }
    if (st.type === 'IfStatement' && st.alternate) {
      const r1 = singleReturn(st.consequent);
      const r2 = singleReturn(st.alternate);
      if (r1 && r2 && r1.argument && r2.argument) {
        const cond = txBool(st.test, sctx);
        const a = txExpr(r1.argument, sctx);
        const b = txExpr(r2.argument, sctx);
        finalRes = {
          tla: `(IF ${cond} THEN ${a.tla} ELSE ${b.tla})`,
          type: a.type === b.type ? a.type : 'unknown',
        };
        break;
      }
      failAt(`helper '${name}': if/else must return in both branches to inline`, st);
    }
    failAt(
      `helper '${name}': statement '${st.type}' is not inlinable (helpers must ` +
        'be pure guard-return chains)',
      st
    );
  }
  if (!finalRes) {
    failAt(`helper '${name}' can fall off the end (implicit undefined return)`, callNode);
  }
  let acc = finalRes;
  for (let i = arms.length - 1; i >= 0; i--) {
    acc = {
      tla: `(IF ${arms[i].cond} THEN ${arms[i].res.tla} ELSE ${acc.tla})`,
      type: arms[i].res.type === acc.type ? acc.type : 'unknown',
    };
  }
  return acc;
}

function singleReturn(s) {
  if (!s) return null;
  if (s.type === 'ReturnStatement') return s;
  if (s.type === 'BlockStatement' && s.body.length === 1) return singleReturn(s.body[0]);
  return null;
}

// ---------------------------------------------------------------------------
// Acceptor translation (symbolic execution of the transpilable subset)
// ---------------------------------------------------------------------------

function translateAcceptor(el, spec) {
  if (
    !el ||
    el.type !== 'ArrowFunctionExpression' ||
    el.body.type !== 'ArrowFunctionExpression' ||
    el.params.length !== 1 ||
    el.params[0].type !== 'Identifier' ||
    el.body.params.length !== 1 ||
    el.body.params[0].type !== 'Identifier'
  ) {
    failAt(
      'acceptor is not of the shape (model) => (p) => { ... } — outside the subset',
      el
    );
  }
  const modelName = el.params[0].name;
  const pName = el.body.params[0].name;
  const body = el.body.body;
  if (body.type !== 'BlockStatement') {
    failAt('acceptor body must be a block statement', el.body);
  }
  const stmts = body.body;

  // A leading guard must bind this acceptor to an action: either the flag
  // form 'if (!p.<flag>) return;' or (extension) a discriminator dispatch
  // "if (p.<key> !== 'Lit') return;" where <key>'s string literals are
  // distinct across the actions array. Leading '!p ||' disjuncts are dropped
  // (the proposal is always an object). Non-binding early-return guards
  // before the binder are kept and translated as ordinary guards.
  let bound = null;
  let bindIdx = -1;
  const preGuards = [];
  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i];
    if (!(st.type === 'IfStatement' && isBareReturn(st.consequent) && !st.alternate)) {
      break;
    }
    bound = matchBindingGuard(st, pName, spec.flagToName, spec.discToName);
    if (bound) { bindIdx = i; break; }
    preGuards.push(st);
  }
  if (!bound) {
    failAt(
      `no leading binding guard found ` +
        `('if (!${pName}.<actionFlag>) return;' or ` +
        `'if (${pName}.<discriminatorKey> !== \\'<literal>\\') return;') — ` +
        `cannot bind this acceptor to an action`,
      stmts[0] || el
    );
  }
  const { flag, actionName } = bound;
  // literal values the payload's discriminator keys take for this action
  const discFields = {};
  for (const [k, m] of Object.entries(spec.discToName)) {
    for (const [lit, n] of Object.entries(m)) {
      if (n === actionName) discFields[k] = lit;
    }
  }
  const payloads = spec.intentsByName[actionName];
  if (!payloads || payloads.length === 0) {
    failAt(
      `no checkerIntents payloads found for action '${actionName}' — ` +
        'cannot derive a finite parameter domain',
      el
    );
  }
  const payloadTypes = {};
  for (const [k, v] of Object.entries(payloads[0])) payloadTypes[k] = jsType(v);

  const ctx = {
    modelName,
    pName,
    actionFlag: flag,
    actionName,
    discFields,
    dataKeys: spec.dataKeys,
    allFlags: new Set(Object.keys(spec.flagToName)),
    payloadTypes,
    stateVar: spec.stateVar,
    fieldNames: spec.fieldNames,
    fieldTypes: spec.fieldTypes,
    env: {
      alias: null, fields: new Map(), locals: new Map(), roAliases: new Map(),
      letNames: new Set(),
    },
    guards: [],
    hasMutated: false,
    alive: 'TRUE',
    helpers: spec.helpers,
    constArrays: spec.constArrays,
    inlineDepth: 0,
  };

  walkStmts([...preGuards, ...stmts.slice(bindIdx + 1)], ctx, true);

  if (!ctx.env.alias) {
    failAt(
      `acceptor for '${actionName}' never binds ` +
        `'const n = ${modelName}.${spec.stateVar}[${pName}.<key>];' — ` +
        'no mutation target',
      el
    );
  }

  return {
    name: actionName,
    keyTla: ctx.env.alias.keyTla,
    guards: ctx.guards,
    fields: ctx.env.fields, // Map field -> final symbolic TLA+ expression
    payloads,
  };
}

// v2 strict-profile acceptor: the object key IS the action name, so there is
// no binding-guard inference at all. Signature (model) => (p[, { reject }]) =>
// { ... }; `return reject('reason')` == a bare-return guard. Alias reads are
// snapshot (pre-state) reads; the only state write is the top-level spread
// commit `model.<sv> = { ...model.<sv>, [key]: rec }`.
function translateAcceptorV2(actionName, el, spec) {
  if (
    !el ||
    (el.type !== 'ArrowFunctionExpression' && el.type !== 'FunctionExpression') ||
    el.params.length !== 1 ||
    el.params[0].type !== 'Identifier' ||
    !el.body ||
    el.body.type !== 'ArrowFunctionExpression'
  ) {
    failAt(
      `acceptor '${actionName}' is not of the shape ` +
        '(model) => (p[, { reject }]) => { ... } — outside the subset',
      el
    );
  }
  const modelName = el.params[0].name;
  const inner = el.body;
  if (inner.params.length < 1 || inner.params[0].type !== 'Identifier') {
    failAt(
      `acceptor '${actionName}': first inner parameter must be the proposal ` +
        'identifier',
      inner
    );
  }
  const pName = inner.params[0].name;
  // sam-pattern 2.1 STRICT-profile acceptor context: any subset of
  // { reject, next, unchanged }, in any order. The bare { reject } form (the
  // 2.0 contract, commits via `model.<sv> = {...}`) is still accepted for
  // legacy specs; destructuring `next` or `unchanged` switches the body to
  // the 2.1 next-state form (writes via next.*, model.* always pre-state).
  let rejectName = null;
  let nextName = null;
  let unchangedName = null;
  if (inner.params.length === 2) {
    const meta = inner.params[1];
    if (meta.type !== 'ObjectPattern') {
      failAt(
        `acceptor '${actionName}': second inner parameter must be a ` +
          '{ reject, next, unchanged } pattern — outside the subset',
        meta
      );
    }
    for (const prop of meta.properties) {
      if (
        prop.type !== 'Property' || prop.computed ||
        prop.key.type !== 'Identifier' || prop.value.type !== 'Identifier'
      ) {
        failAt(
          `acceptor '${actionName}': second parameter must destructure plain ` +
            '{ reject, next, unchanged } names (no defaults/rest/computed ' +
            'keys) — outside the subset',
          prop
        );
      }
      if (prop.key.name === 'reject') rejectName = prop.value.name;
      else if (prop.key.name === 'next') nextName = prop.value.name;
      else if (prop.key.name === 'unchanged') unchangedName = prop.value.name;
      else {
        failAt(
          `acceptor '${actionName}': unknown acceptor-context key ` +
            `'${prop.key.name}' — sam-pattern 2.1 provides only ` +
            '{ reject, next, unchanged }',
          prop
        );
      }
    }
    if (!rejectName && !nextName && !unchangedName) {
      failAt(
        `acceptor '${actionName}': second parameter destructures none of ` +
          "'reject', 'next', 'unchanged' — outside the subset",
        meta
      );
    }
  } else if (inner.params.length > 2) {
    failAt(
      `acceptor '${actionName}' takes more than ` +
        '(proposal, { reject, next, unchanged })',
      inner
    );
  }
  const nextForm = !!(nextName || unchangedName);
  if (spec.mode === 'scalar' && !nextForm) {
    failAt(
      `acceptor '${actionName}' over a flat scalar state does not destructure ` +
        "'next' (or 'unchanged') — sam-pattern 2.1 next-state form required: " +
        '(model) => (p, { reject, next, unchanged }) => { next.<var> = ...; }',
      inner
    );
  }
  if (inner.body.type !== 'BlockStatement') {
    failAt(`acceptor '${actionName}' body must be a block statement`, inner);
  }

  const payloads = spec.intentsByName[actionName];
  if (!payloads || payloads.length === 0) {
    failAt(
      `no payload domain found for intent '${actionName}' — the actions ` +
        "entry's 'domain' (surfaced through checkerIntents) is empty or missing",
      el
    );
  }
  const payloadTypes = {};
  for (const [k, v] of Object.entries(payloads[0])) payloadTypes[k] = jsType(v);

  const ctx = {
    modelName,
    pName,
    isV2: true,
    snapshotAlias: true,
    rejectName,
    nextName,
    unchangedName,
    nextForm,
    mode: spec.mode ?? 'map',
    scalarVars: spec.scalarVars ?? [],
    scalarTypes: spec.scalarTypes ?? {},
    actionFlag: null,
    actionName,
    discFields: {},
    dataKeys: new Set(),
    allFlags: new Set(),
    payloadTypes,
    stateVar: spec.stateVar,
    fieldNames: spec.fieldNames,
    fieldTypes: spec.fieldTypes,
    env: {
      alias: null, fields: new Map(), locals: new Map(), roAliases: new Map(),
      letNames: new Set(),
    },
    guards: [],
    hasMutated: false,
    unconditionalWrites: new Set(),
    alive: 'TRUE',
    helpers: spec.helpers,
    constArrays: spec.constArrays,
    inlineDepth: 0,
  };

  walkStmts(inner.body.body, ctx, true);

  if (ctx.mode !== 'scalar' && !ctx.env.alias) {
    failAt(
      `acceptor for '${actionName}' never binds ` +
        `'const n = ${modelName}.${spec.stateVar}[${pName}.<key>];' — ` +
        'no commit target',
      el
    );
  }

  return {
    name: actionName,
    keyTla: ctx.mode === 'scalar' ? null : ctx.env.alias.keyTla,
    guards: ctx.guards,
    fields: ctx.env.fields,
    payloads,
  };
}

// `if (!p.FLAG) return;` -> { flag, actionName }
// `if (p.<key> !== 'Lit') return;` -> { flag: null, actionName } (extension,
//   for any discriminator key whose literals are distinct across actions)
// A leading `!p ||` disjunct is dropped (the proposal is always an object).
function matchBindingGuard(st, pName, flagToName, discToName) {
  if (!st || st.type !== 'IfStatement' || st.alternate) return null;
  if (!isBareReturn(st.consequent)) return null;
  let t = st.test;
  // strip `!p || ...` prefixes
  while (
    t.type === 'LogicalExpression' && t.operator === '||' &&
    t.left.type === 'UnaryExpression' && t.left.operator === '!' &&
    t.left.argument.type === 'Identifier' && t.left.argument.name === pName
  ) {
    t = t.right;
  }
  if (t.type === 'UnaryExpression' && t.operator === '!') {
    const m = t.argument;
    if (
      m.type === 'MemberExpression' && !m.computed &&
      m.object.type === 'Identifier' && m.object.name === pName &&
      m.property.type === 'Identifier' && flagToName[m.property.name]
    ) {
      return { flag: m.property.name, actionName: flagToName[m.property.name] };
    }
    return null;
  }
  if (
    t.type === 'BinaryExpression' && (t.operator === '!==' || t.operator === '!=')
  ) {
    const sides = [t.left, t.right];
    const mem = sides.find(
      (s) =>
        s.type === 'MemberExpression' && !s.computed &&
        s.object.type === 'Identifier' && s.object.name === pName &&
        s.property.type === 'Identifier' && discToName[s.property.name]
    );
    const lit = sides.find((s) => s.type === 'Literal' && typeof s.value === 'string');
    if (mem && lit) {
      const name = discToName[mem.property.name][lit.value];
      if (name) return { flag: null, actionName: name };
    }
  }
  return null;
}

function isBareReturn(s) {
  if (!s) return false;
  if (s.type === 'ReturnStatement') return !s.argument;
  if (s.type === 'BlockStatement' && s.body.length === 1) return isBareReturn(s.body[0]);
  return false;
}

function andTla(a, b) {
  if (a === 'TRUE') return b;
  if (b === 'TRUE') return a;
  if (a === 'FALSE' || b === 'FALSE') return 'FALSE';
  return `(${a} /\\ ${b})`;
}

// Guarded (if-converted) symbolic execution — E1 subset widening (noted).
// Every statement runs under a path guard `branchCond`; a mutable ctx.alive
// tracks "the function has not returned yet". Writes become conditional
// field updates `IF guard THEN v ELSE old`, and a `return` (bare, or a
// `if (cond) return;` after mutation / inside a branch) just strengthens
// ctx.alive instead of being rejected. Pre-mutation top-level early returns
// are still lifted to action preconditions exactly as before.
function walkStmts(stmts, ctx, topLevel, branchCond = 'TRUE') {
  // Names declared at THIS statement-list level; the caller (a conditional
  // block) restores them on branch exit, while guarded REASSIGNMENTS of
  // outer `let` locals persist (they carry their own path condition).
  const declared = new Set();
  for (const st of stmts) {
    switch (st.type) {
      case 'ReturnStatement': {
        if (st.argument && isUnchangedCall(st.argument, ctx)) {
          // `return unchanged(...)`: an accepted no-op path — same control
          // flow as a bare return; the frame declaration is cross-checked.
          checkUnchangedArgs(st.argument, ctx);
        } else if (st.argument && !isRejectCall(st.argument, ctx)) {
          failAt(
            'acceptors must not return values (only bare `return`, ' +
              '`return reject(...)`, or `return unchanged(...)`)',
            st
          );
        }
        if (topLevel && branchCond === 'TRUE') {
          ctx.alive = 'FALSE';
          return declared; // nothing after it executes on this (only) path
        }
        ctx.alive = andTla(ctx.alive, notTla(branchCond));
        break;
      }

      case 'IfStatement':
        if (isReturnLike(st.consequent, ctx) && !st.alternate) {
          // early-return guard (bare return, `return reject(...)`, or
          // `return unchanged(...)` — an accepted no-op exit)
          const retStmt = singleReturn(st.consequent);
          if (retStmt && retStmt.argument && isUnchangedCall(retStmt.argument, ctx)) {
            checkUnchangedArgs(retStmt.argument, ctx);
          }
          const cond = txBool(st.test, ctx);
          if (
            topLevel && !ctx.hasMutated &&
            branchCond === 'TRUE' && ctx.alive === 'TRUE'
          ) {
            // still a pure precondition
            const g = notTla(cond);
            if (g !== 'TRUE') ctx.guards.push(g);
          } else {
            // abort on a live path: strengthen the alive condition (widening)
            ctx.alive = andTla(ctx.alive, notTla(andTla(branchCond, cond)));
          }
          break;
        } else {
          // conditional block: walk both branches under strengthened guards.
          // Writes are guarded, so the shared fields env stays correct;
          // branch-DECLARED locals are discarded afterwards while guarded
          // reassignments of pre-existing `let` locals persist.
          const cond = txBool(st.test, ctx);
          const savedLocals = new Map(ctx.env.locals);
          const savedLets = new Set(ctx.env.letNames);
          const savedAlias = ctx.env.alias;
          const savedRoAliases = new Map(ctx.env.roAliases);
          const restoreDeclared = (names) => {
            for (const k of names) {
              if (savedLocals.has(k)) ctx.env.locals.set(k, savedLocals.get(k));
              else ctx.env.locals.delete(k);
            }
            ctx.env.letNames = new Set(savedLets);
            // Alias bindings are block-scoped consts too: letting one leak
            // out of its branch would translate a JS ReferenceError (crash)
            // as normal behavior.
            ctx.env.alias = savedAlias;
            ctx.env.roAliases = new Map(savedRoAliases);
          };
          const d1 = walkStmts(
            blockBody(st.consequent), ctx, false, andTla(branchCond, cond)
          );
          restoreDeclared(d1);
          if (st.alternate) {
            const d2 = walkStmts(
              blockBody(st.alternate), ctx, false, andTla(branchCond, notTla(cond))
            );
            restoreDeclared(d2);
          }
          break;
        }

      case 'VariableDeclaration': {
        if (st.kind !== 'const' && st.kind !== 'let') {
          failAt(`'${st.kind}' declarations are outside the subset (use const/let)`, st);
        }
        for (const d of st.declarations) {
          if (d.id.type === 'Identifier') declared.add(d.id.name);
          if (st.kind === 'let') {
            if (d.id.type !== 'Identifier') {
              failAt('let destructuring is outside the subset', d);
            }
            ctx.env.letNames.add(d.id.name);
            if (!d.init) {
              // `let x;` — must be unconditionally assigned before any read
              ctx.env.locals.set(d.id.name, { tla: null, type: 'uninit' });
              continue;
            }
          }
          // Extension: `const { a, b } = p;` is sugar for
          // `const a = p.a; const b = p.b;` (payload destructuring only).
          if (
            d.id.type === 'ObjectPattern' && d.init &&
            d.init.type === 'Identifier' && d.init.name === ctx.pName
          ) {
            for (const prop of d.id.properties) {
              if (
                prop.type !== 'Property' || prop.computed ||
                prop.key.type !== 'Identifier' || prop.value.type !== 'Identifier'
              ) {
                failAt(
                  'only plain `const { a, b } = p;` payload destructuring is ' +
                    'supported (no defaults, rest, or renaming patterns beyond ' +
                    'identifiers)',
                  prop
                );
              }
              const synthetic = {
                type: 'MemberExpression',
                computed: false,
                object: { type: 'Identifier', name: ctx.pName, loc: prop.loc },
                property: { type: 'Identifier', name: prop.key.name, loc: prop.loc },
                loc: prop.loc,
              };
              declared.add(prop.value.name);
              ctx.env.locals.set(prop.value.name, txExpr(synthetic, ctx));
            }
            continue;
          }
          if (d.id.type !== 'Identifier' || !d.init) {
            failAt('only simple `const x = expr;` declarations are supported', d);
          }
          const alias = ctx.mode === 'scalar'
            ? null // scalar state has no map to alias into
            : matchAliasBinding(stripModelMapPrefix(d.init, ctx), ctx);
          if (alias) {
            // A fresh alias bound AFTER a mutation/commit reads the
            // PRE-state variable in TLA+, but JS would see the committed
            // value — a well-formed, silently wrong translation. Refuse.
            // (Not applicable to 2.1 next-form bodies: model.* is the frozen
            // pre-state there, which IS the unprimed TLA+ variable.)
            if (ctx.hasMutated && !ctx.nextForm) {
              failAt(
                'node alias bound after a state mutation/commit — the alias ' +
                  'would read the pre-state in TLA+ but the post-state in JS ' +
                  '(bind aliases before mutating, or restructure) — outside the subset',
                d
              );
            }
            if (ctx.env.alias) {
              // Extension: further alias bindings are read-only views of
              // other nodes (writes must go through the primary alias).
              ctx.env.roAliases.set(d.id.name, alias.keyTla);
            } else {
              ctx.env.alias = { name: d.id.name, keyTla: alias.keyTla };
            }
          } else {
            ctx.env.locals.set(d.id.name, txExpr(d.init, ctx));
          }
        }
        break;
      }

      case 'ExpressionStatement': {
        const e = st.expression;
        if (e.type === 'UnaryExpression' && e.operator === 'void') {
          break; // `void x;` — an explicit no-op
        }
        if (isUnchangedCall(e, ctx)) {
          // statement-position `unchanged('a','b');` — an explicit frame
          // declaration: validated + cross-checked, then a no-op (the
          // UNCHANGED emission derives from the unwritten-variable analysis)
          checkUnchangedArgs(e, ctx);
          break;
        }
        if (e.type === 'AssignmentExpression') {
          // 2.1 next-state write: next.<var> = expr
          const nt = matchNextTarget(e.left, ctx);
          if (nt) {
            handleNextWrite(e, nt.prop, ctx, branchCond);
            break;
          }
          // In a 2.1 next-form body (or over a scalar state, which is
          // 2.1-only), writing model.* is a runtime SamShapeError in
          // sam-pattern 2.1 STRICT — refuse loudly, never transpile it.
          if ((ctx.nextForm || ctx.mode === 'scalar') && isModelMemberTarget(e.left, ctx)) {
            failAt(
              `assignment through '${ctx.modelName}.*' in a STRICT acceptor — ` +
                'a runtime SamShapeError in sam-pattern 2.1; 2.1 next-state ' +
                `form required: write '${ctx.nextName ?? 'next'}.<stateVar> = ` +
                `expr' (reads of ${ctx.modelName}.* stay pre-state)`,
              e.left
            );
          }
          // legacy v2.0 commit: model.<sv> = { ...model.<sv>, [key]: rec }
          if (ctx.isV2 && isModelStateVarTarget(e.left, ctx)) {
            if (e.operator !== '=') {
              failAt(`state commit with operator '${e.operator}'`, e);
            }
            handleCommit(e.right, ctx, branchCond);
            break;
          }
          // (guarded) reassignment of a `let` local
          if (e.left.type === 'Identifier' && ctx.env.locals.has(e.left.name)) {
            handleLocalAssign(e, ctx, branchCond);
            break;
          }
          // write to a field of a local record object (up.f = expr)
          const rw = matchRecordField(e.left, ctx);
          if (rw) {
            const cur = recordRead(rw.rec, rw.field, ctx, e.left);
            const rhs = e.operator === '=' ? txExpr(e.right, ctx) : txExpr(e.right, ctx);
            let v;
            if (e.operator === '=') v = rhs;
            else if (e.operator === '+=' || e.operator === '-=') {
              // Same rule as txExpr's BinaryExpression: string arithmetic is
              // refused at transpile time, not left to error inside TLC.
              if (cur.type === 'str' || rhs.type === 'str') {
                failAt('string arithmetic (compound assignment on a string field) is outside the subset', e);
              }
              v = { tla: `(${cur.tla} ${e.operator === '+=' ? '+' : '-'} ${rhs.tla})`, type: 'num' };
            } else {
              failAt(`assignment operator '${e.operator}' is outside the subset`, e);
            }
            guardedRecordWrite(ctx, rw.rec, rw.field, v, cur, branchCond, e);
            break;
          }
          const f = matchAliasField(e.left, ctx);
          if (!f) {
            failAt(
              'assignment target must be an alias field (n.<field>), a local ' +
                'record field, a `let` local, or the v2 state commit — ' +
                'outside the subset',
              e.left
            );
          }
          if (ctx.isV2) {
            failAt(
              'in-place write through a node reference (nested write) ' +
                'bypasses the strict-profile write tracker — outside the v2 ' +
                'subset (build a record and commit it at top level)',
              e.left
            );
          }
          const rhs = txExpr(e.right, ctx);
          const cur = ctx.env.fields.get(f) ?? fieldRead(ctx, f);
          let v;
          if (e.operator === '=') v = rhs.tla;
          else if (e.operator === '+=' || e.operator === '-=') {
            if (rhs.type === 'str' || ctx.fieldTypes?.[f] === 'str') {
              failAt('string arithmetic (compound assignment on a string field) is outside the subset', e);
            }
            v = `(${cur} ${e.operator === '+=' ? '+' : '-'} ${rhs.tla})`;
          } else failAt(`assignment operator '${e.operator}' is outside the subset`, e);
          guardedWrite(ctx, f, v, branchCond);
        } else if (e.type === 'UpdateExpression') {
          const rw = matchRecordField(e.argument, ctx);
          if (rw) {
            const cur = recordRead(rw.rec, rw.field, ctx, e.argument);
            const v = {
              tla: `(${cur.tla} ${e.operator === '++' ? '+' : '-'} 1)`,
              type: 'num',
            };
            guardedRecordWrite(ctx, rw.rec, rw.field, v, cur, branchCond, e);
            break;
          }
          if (
            e.argument.type === 'Identifier' &&
            ctx.env.locals.has(e.argument.name)
          ) {
            handleLocalAssign(
              {
                type: 'AssignmentExpression',
                operator: e.operator === '++' ? '+=' : '-=',
                left: e.argument,
                right: { type: 'Literal', value: 1, raw: '1', loc: e.loc },
                loc: e.loc,
              },
              ctx, branchCond
            );
            break;
          }
          const f = matchAliasField(e.argument, ctx);
          if (!f) failAt('update target must be an alias field', e);
          if (ctx.isV2) {
            failAt(
              'in-place update through a node reference (nested write) is ' +
                'outside the v2 subset',
              e.argument
            );
          }
          const cur = ctx.env.fields.get(f) ?? fieldRead(ctx, f);
          guardedWrite(ctx, f, `(${cur} ${e.operator === '++' ? '+' : '-'} 1)`, branchCond);
        } else if (
          e.type === 'CallExpression' &&
          e.callee.type === 'Identifier' &&
          ctx.helpers && ctx.helpers.has(e.callee.name)
        ) {
          inlineHelperStmt(e, ctx, branchCond); // extension: mutating helper
        } else if (isRejectCall(e, ctx)) {
          failAt(
            "a bare 'reject(...)' statement (not 'return reject(...)') is " +
              'outside the subset — its post-rejection continuation semantics ' +
              'are not modelled',
            st
          );
        } else {
          failAt(`statement '${e.type}' is outside the subset`, st);
        }
        break;
      }

      default:
        failAt(
          `statement '${st.type}' (${friendlyName(st.type)}) is outside the ` +
            'transpilable subset',
          st
        );
    }
  }
  return declared;
}

// `return reject('reason')` — the call itself
function isRejectCall(node, ctx) {
  return !!(
    ctx.rejectName &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === ctx.rejectName
  );
}

// bare `return;`, `return reject(...)`, or `return unchanged(...)`
// (possibly in a one-statement block)
function isReturnLike(s, ctx) {
  if (!s) return false;
  if (s.type === 'ReturnStatement') {
    return (
      !s.argument ||
      isRejectCall(s.argument, ctx) ||
      isUnchangedCall(s.argument, ctx)
    );
  }
  if (s.type === 'BlockStatement' && s.body.length === 1) {
    return isReturnLike(s.body[0], ctx);
  }
  return false;
}

// `unchanged('a', 'b')` — the 2.1 explicit frame declaration
function isUnchangedCall(node, ctx) {
  return !!(
    ctx.unchangedName &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === ctx.unchangedName
  );
}

// Validate an unchanged('a','b') frame declaration: every argument must be a
// string literal naming a real state variable, and naming one this acceptor
// has already assigned UNCONDITIONALLY (guard TRUE on every live path) is a
// contradictory frame — refused loudly. The per-action UNCHANGED emission is
// still derived from the unwritten-variable analysis, not from these calls.
function checkUnchangedArgs(call, ctx) {
  const un = ctx.unchangedName;
  for (const arg of call.arguments) {
    if (arg.type !== 'Literal' || typeof arg.value !== 'string') {
      failAt(
        `${un}(...) arguments must be string literals naming state variables`,
        arg
      );
    }
    const name = arg.value;
    if (ctx.mode === 'scalar') {
      if (!ctx.scalarVars.includes(name)) {
        failAt(
          `${un}('${name}') names an unknown state variable — state keys ` +
            `are [${ctx.scalarVars.join(', ')}]`,
          arg
        );
      }
      if (ctx.unconditionalWrites.has(name)) {
        failAt(
          `contradictory frame: '${name}' is both assigned via ` +
            `${ctx.nextName ?? 'next'}.${name} and declared ` +
            `${un}('${name}') on the same path`,
          arg
        );
      }
    } else {
      if (name !== ctx.stateVar) {
        failAt(
          `${un}('${name}') names an unknown state variable — the ` +
            `observable state variable is '${ctx.stateVar}'`,
          arg
        );
      }
      if (ctx.unconditionalWrites.size > 0) {
        failAt(
          `contradictory frame: '${name}' is committed via ` +
            `${ctx.nextName ?? 'next'}.${name} and declared ` +
            `${un}('${name}') on the same path`,
          arg
        );
      }
    }
  }
}

// `next.<prop>` as an assignment target (the 2.1 next-state write LHS).
// A more complex LHS rooted at `next` (next.sv[k] = ..., next.sv.f = ...) is
// refused loudly — 2.1 writes are whole-variable.
function matchNextTarget(left, ctx) {
  if (!ctx.nextName) return null;
  if (
    left.type === 'MemberExpression' && !left.computed &&
    left.object.type === 'Identifier' && left.object.name === ctx.nextName &&
    left.property.type === 'Identifier'
  ) {
    return { prop: left.property.name };
  }
  let n = left;
  while (n.type === 'MemberExpression') n = n.object;
  if (n.type === 'Identifier' && n.name === ctx.nextName) {
    failAt(
      `writes through '${ctx.nextName}' must assign a whole state variable ` +
        `('${ctx.nextName}.<var> = expr') — nested/computed next-writes are ` +
        'outside the subset',
      left
    );
  }
  return null;
}

// any assignment LHS rooted at the model parameter (model.x, model.sv[k], ...)
function isModelMemberTarget(left, ctx) {
  let n = left;
  while (n.type === 'MemberExpression') n = n.object;
  return n.type === 'Identifier' && n.name === ctx.modelName;
}

// 2.1 next-state write: next.<var> = expr. RHS reads of model.* are the
// pre-state (unprimed) by construction — there is no sequential-mutation
// fold in the 2.1 form.
function handleNextWrite(e, prop, ctx, branchCond) {
  if (e.operator !== '=') {
    failAt(
      `compound assignment '${e.operator}' through '${ctx.nextName}' reads ` +
        `the post-state — outside the subset (write '${ctx.nextName}.${prop} ` +
        `= ${ctx.modelName}.${prop} ...' instead)`,
      e
    );
  }
  if (ctx.mode === 'scalar') {
    if (!ctx.scalarVars.includes(prop)) {
      failAt(
        `write to unknown state variable '${ctx.nextName}.${prop}' — state ` +
          `keys are [${ctx.scalarVars.join(', ')}]`,
        e.left
      );
    }
    const v = txExpr(e.right, ctx);
    requireDefined(v, e, `state variable '${prop}'`);
    guardedWrite(ctx, prop, v.tla, branchCond);
    return;
  }
  // map mode: next.<stateVar> = { ...model.<stateVar>, [key]: rec }
  if (prop !== ctx.stateVar) {
    failAt(
      `write to '${ctx.nextName}.${prop}' but the observable state variable ` +
        `is '${ctx.stateVar}'`,
      e.left
    );
  }
  handleCommit(e.right, ctx, branchCond);
}

// `model.<stateVar>` as an assignment target (the v2 commit LHS)
function isModelStateVarTarget(left, ctx) {
  return (
    left.type === 'MemberExpression' && !left.computed &&
    left.object.type === 'Identifier' && left.object.name === ctx.modelName &&
    left.property.type === 'Identifier' && left.property.name === ctx.stateVar
  );
}

// (guarded) reassignment of a `let` local; new value merges with the old one
// under the current path condition.
function handleLocalAssign(e, ctx, branchCond) {
  const name = e.left.name;
  if (!ctx.env.letNames.has(name)) {
    failAt(`assignment to const local '${name}' — not valid JavaScript`, e);
  }
  const old = ctx.env.locals.get(name);
  const g = andTla(branchCond, ctx.alive);
  if (g === 'FALSE') return; // dead path
  let v;
  if (e.operator === '=') {
    v = txExpr(e.right, ctx);
  } else if (e.operator === '+=' || e.operator === '-=') {
    if (!old || old.type === 'uninit') {
      failAt(`compound assignment to uninitialized local '${name}'`, e);
    }
    const rhs = txExpr(e.right, ctx);
    v = {
      tla: `(${old.tla} ${e.operator === '+=' ? '+' : '-'} ${rhs.tla})`,
      type: 'num',
    };
  } else {
    failAt(`assignment operator '${e.operator}' is outside the subset`, e);
  }
  if (!old || old.type === 'uninit') {
    if (g !== 'TRUE') {
      // Conditional first assignment (the `let x; if (a) x = A; ...` idiom).
      // The local becomes a maybe-undefined value: a `definedIf` condition
      // rides along and is folded into every truthiness test and comparison
      // (JS: undefined is falsy and compares false against defined values).
      // The not-yet-assigned arm holds a TYPE-NEUTRAL value so TLC's eager
      // evaluation of dead IF-arms can never crash; `definedIf` keeps that
      // neutral value from ever influencing a result.
      const neutral = { bool: 'FALSE', num: '0', str: '""' }[v.type];
      if (!neutral) {
        failAt(
          `conditional initialization of 'let ${name}' with a value of ` +
            `type '${v.type}' is outside the subset`,
          e
        );
      }
      const vDef = v.definedIf ?? 'TRUE';
      ctx.env.locals.set(name, {
        tla: g === 'TRUE' ? v.tla : `(IF ${g} THEN ${v.tla} ELSE ${neutral})`,
        type: v.type,
        definedIf: andTla(g, vDef),
      });
      return;
    }
    ctx.env.locals.set(name, v);
    return;
  }
  ctx.env.locals.set(name, mergeGuarded(g, v, old, ctx, e));
}

// IF g THEN nv ELSE ov, for scalars and node records alike
function mergeGuarded(g, nv, ov, ctx, node) {
  if (g === 'TRUE') return nv;
  if (nv.type === 'noderec' || ov.type === 'noderec') {
    if (nv.type !== 'noderec' || ov.type !== 'noderec') {
      failAt('conditional mix of record and scalar values for one local', node);
    }
    const fields = new Map();
    let baseKey = null;
    if (nv.baseKey && nv.baseKey === ov.baseKey) {
      // shared base: merge only the overridden fields
      baseKey = nv.baseKey;
      const keys = new Set([...nv.fields.keys(), ...ov.fields.keys()]);
      for (const f of keys) {
        const a = nv.fields.get(f) ?? recordBaseRead(nv, f, ctx, node);
        const b = ov.fields.get(f) ?? recordBaseRead(ov, f, ctx, node);
        fields.set(f, ifMerge(g, a, b));
      }
    } else {
      // different (or no) bases: materialize every state field
      for (const f of ctx.fieldNames) {
        const a = recordRead(nv, f, ctx, node);
        const b = recordRead(ov, f, ctx, node);
        fields.set(f, ifMerge(g, a, b));
      }
    }
    return { type: 'noderec', fields, baseKey, aliasView: false };
  }
  return ifMerge(g, nv, ov);
}

function ifMerge(g, a, b) {
  const aDef = a.definedIf ?? 'TRUE';
  const bDef = b.definedIf ?? 'TRUE';
  const def =
    aDef === 'TRUE' && bDef === 'TRUE'
      ? 'TRUE'
      : orTla(andTla(g, aDef), andTla(notTla(g), bDef));
  if (a.tla === b.tla && aDef === bDef) return a;
  const out = {
    tla: `(IF ${g} THEN ${a.tla} ELSE ${b.tla})`,
    type: a.type === b.type ? a.type : 'unknown',
  };
  if (def !== 'TRUE') out.definedIf = def;
  return out;
}

// read of field f straight off a record's base node (pre-state)
function recordBaseRead(rec, f, ctx, node) {
  if (!ctx.fieldNames.includes(f)) {
    failAt(`read of unknown state field '${f}'`, node);
  }
  return {
    tla: `${ctx.stateVar}[${rec.baseKey}].${f}`,
    type: ctx.fieldTypes[f] ?? 'unknown',
  };
}

// read of field f from a local record value
function recordRead(rec, f, ctx, node) {
  const v = rec.fields.get(f);
  if (v) return v;
  if (rec.baseKey) return recordBaseRead(rec, f, ctx, node);
  failAt(
    `field '${f}' is never set on this record literal and it has no ` +
      '...spread base — reading it would be undefined',
    node
  );
}

// `x.<field>` where x is a local record object -> { rec, field }
function matchRecordField(m, ctx) {
  if (
    m.type === 'MemberExpression' && !m.computed &&
    m.object.type === 'Identifier' &&
    m.property.type === 'Identifier'
  ) {
    const lv = ctx.env.locals.get(m.object.name);
    if (lv && lv.type === 'noderec') return { rec: lv, field: m.property.name };
  }
  return null;
}

function requireDefined(v, node, what) {
  if ((v.definedIf ?? 'TRUE') !== 'TRUE') {
    failAt(
      `a possibly-undefined value flows into ${what} — JS would write ` +
        'undefined into the state (outside the subset)',
      node
    );
  }
}

// write `rec.f := v` under the current path guard
function guardedRecordWrite(ctx, rec, f, v, cur, branchCond, node) {
  if (rec.aliasView) {
    failAt(
      'in-place write through a node reference (nested write) bypasses the ' +
        'strict-profile write tracker — outside the v2 subset (copy it first: ' +
        'const up = { ...n })',
      node
    );
  }
  requireDefined(v, node, `record field '${f}'`);
  const g = andTla(branchCond, ctx.alive);
  if (g === 'FALSE') return; // dead path
  rec.fields.set(f, g === 'TRUE' ? v : ifMerge(g, v, cur));
}

// v2 state commit: model.<sv> = { ...model.<sv>, [key]: rec }
function handleCommit(right, ctx, branchCond) {
  if (!ctx.env.alias) {
    failAt('state commit before any node alias binding — no commit target', right);
  }
  const bad = (msg, n) =>
    failAt(`state commit must be '{ ...${ctx.modelName}.${ctx.stateVar}, ` +
      `[<key>]: <record> }' — ${msg}`, n);
  if (right.type !== 'ObjectExpression') bad('RHS is not an object literal', right);
  const props = right.properties;
  if (props.length !== 2) bad('expected exactly one spread and one keyed entry', right);
  const sp = props[0];
  if (
    sp.type !== 'SpreadElement' ||
    sp.argument.type !== 'MemberExpression' || sp.argument.computed ||
    sp.argument.object.type !== 'Identifier' ||
    sp.argument.object.name !== ctx.modelName ||
    sp.argument.property.type !== 'Identifier' ||
    sp.argument.property.name !== ctx.stateVar
  ) {
    bad(`first entry must be ...${ctx.modelName}.${ctx.stateVar}`, sp);
  }
  const kp = props[1];
  if (kp.type !== 'Property' || !kp.computed) {
    bad('second entry must be a computed [key]: record property', kp);
  }
  const keyTla = txExpr(kp.key, ctx).tla;
  if (keyTla !== ctx.env.alias.keyTla) {
    failAt(
      `commit key '${keyTla}' differs from the bound node key ` +
        `'${ctx.env.alias.keyTla}' — multi-node commits are outside the subset`,
      kp
    );
  }
  const rec = txExpr(kp.value, ctx);
  if (rec.type !== 'noderec') {
    failAt('committed value is not a node record object', kp.value);
  }
  if (rec.baseKey && rec.baseKey !== ctx.env.alias.keyTla) {
    failAt(
      `committed record is based on node '${rec.baseKey}' but is written to ` +
        `'${ctx.env.alias.keyTla}' — outside the subset`,
      kp.value
    );
  }
  for (const f of ctx.fieldNames) {
    const v = recordRead(rec, f, ctx, kp.value);
    requireDefined(v, kp.value, `state field '${f}' in a commit`);
    const cur = ctx.env.fields.get(f) ?? fieldRead(ctx, f);
    if (v.tla === cur) continue; // true no-op for this field on every path
    guardedWrite(ctx, f, v.tla, branchCond);
  }
}

function blockBody(s) {
  return s.type === 'BlockStatement' ? s.body : [s];
}

// write `f := v` under the current path guard (branchCond /\ alive)
function guardedWrite(ctx, f, v, branchCond) {
  const g = andTla(branchCond, ctx.alive);
  if (g === 'FALSE') return; // dead path
  const cur = ctx.env.fields.get(f) ?? fieldRead(ctx, f);
  ctx.env.fields.set(f, g === 'TRUE' ? v : `(IF ${g} THEN ${v} ELSE ${cur})`);
  ctx.hasMutated = true;
  if (g === 'TRUE') ctx.unconditionalWrites?.add(f);
}

// `model.<sv> && <rest>` -> <rest> (the state map object is always truthy)
function stripModelMapPrefix(init, ctx) {
  if (
    init.type === 'LogicalExpression' && init.operator === '&&' &&
    init.left.type === 'MemberExpression' && !init.left.computed &&
    init.left.object.type === 'Identifier' &&
    init.left.object.name === ctx.modelName &&
    init.left.property.type === 'Identifier' &&
    init.left.property.name === ctx.stateVar
  ) {
    return init.right;
  }
  return init;
}

// `model.<stateVar>[<expr>]` -> { keyTla }
function matchAliasBinding(init, ctx) {
  if (
    init.type === 'MemberExpression' && init.computed &&
    init.object.type === 'MemberExpression' && !init.object.computed &&
    init.object.object.type === 'Identifier' &&
    init.object.object.name === ctx.modelName &&
    init.object.property.type === 'Identifier'
  ) {
    if (init.object.property.name !== ctx.stateVar) {
      failAt(
        `alias binds ${ctx.modelName}.${init.object.property.name} but the ` +
          `observable state variable is '${ctx.stateVar}'`,
        init
      );
    }
    return { keyTla: txExpr(init.property, ctx).tla };
  }
  return null;
}

// `n.<field>` -> field name (or null)
function matchAliasField(m, ctx) {
  if (
    ctx.env.alias &&
    m.type === 'MemberExpression' && !m.computed &&
    m.object.type === 'Identifier' && m.object.name === ctx.env.alias.name &&
    m.property.type === 'Identifier' &&
    ctx.fieldNames.includes(m.property.name)
  ) {
    return m.property.name;
  }
  return null;
}

function fieldRead(ctx, f) {
  if (ctx.mode === 'scalar') return f; // the unprimed TLA+ variable itself
  return `${ctx.stateVar}[${ctx.env.alias.keyTla}].${f}`;
}

// `model.<stateVar>[<expr>]` -> keyTla (or null); used for direct state reads
function matchModelLookup(n, ctx) {
  if (
    n.type === 'MemberExpression' && n.computed &&
    n.object.type === 'MemberExpression' && !n.object.computed &&
    n.object.object.type === 'Identifier' &&
    n.object.object.name === ctx.modelName &&
    n.object.property.type === 'Identifier' &&
    n.object.property.name === ctx.stateVar
  ) {
    return txExpr(n.property, ctx).tla;
  }
  return null;
}

// JS truthiness of a typed TLA+ expression, for guard/test positions
// (extension: string -> /= "", number -> /= 0)
function truthyTla(res, node, ctx) {
  const def = res.definedIf ?? 'TRUE';
  if (res.type === 'bool') return andTla(def, res.tla);
  if (res.type === 'str') return andTla(def, `(${res.tla} /= "")`);
  if (res.type === 'num') return andTla(def, `(${res.tla} /= 0)`);
  if (res.type === 'rec') return 'TRUE'; // payload records are always objects
  if (res.type === 'noderec') {
    // truthiness of a node record == "the key is a real node" (a record
    // literal with no base is always a fresh object, hence truthy)
    return res.baseKey && res.fields.size === 0
      ? `(${res.baseKey} \\in DOMAIN ${ctx.stateVar})`
      : 'TRUE';
  }
  failAt(`cannot coerce a value of type '${res.type}' to a boolean test`, node);
}

function txBool(node, ctx) {
  // JS test semantics distribute over the logical operators:
  //   truthy(a && b) == truthy(a) /\ truthy(b)
  //   truthy(a || b) == truthy(a) \/ truthy(b)
  //   truthy(!a)     == ~truthy(a)
  if (node.type === 'LogicalExpression' && (node.operator === '&&' || node.operator === '||')) {
    const a = txBool(node.left, ctx);
    const b = txBool(node.right, ctx);
    return node.operator === '&&' ? andTla(a, b) : orTla(a, b);
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    return notTla(txBool(node.argument, ctx));
  }
  return truthyTla(txExpr(node, ctx), node, ctx);
}

function orTla(a, b) {
  if (a === 'FALSE') return b;
  if (b === 'FALSE') return a;
  if (a === 'TRUE' || b === 'TRUE') return 'TRUE';
  return `(${a} \\/ ${b})`;
}

// ---------------------------------------------------------------------------
// Expression translation
// ---------------------------------------------------------------------------

function txExpr(node, ctx) {
  switch (node.type) {
    case 'Literal': {
      if (typeof node.value === 'number') {
        if (!Number.isInteger(node.value)) {
          failAt('non-integer numeric literal is outside the subset', node);
        }
        return { tla: String(node.value), type: 'num' };
      }
      if (typeof node.value === 'string') {
        return { tla: `"${node.value}"`, type: 'str' };
      }
      if (typeof node.value === 'boolean') {
        return { tla: node.value ? 'TRUE' : 'FALSE', type: 'bool' };
      }
      failAt(`literal ${node.raw} is outside the subset`, node);
      break;
    }

    case 'Identifier': {
      if (ctx.env.locals.has(node.name)) {
        const lv = ctx.env.locals.get(node.name);
        if (lv.type === 'uninit') {
          failAt(`read of uninitialized local '${node.name}'`, node);
        }
        return lv;
      }
      if (ctx.isV2 && ctx.env.alias && node.name === ctx.env.alias.name) {
        // the alias as a VALUE: a read-only view of the bound node record
        return {
          type: 'noderec', fields: new Map(),
          baseKey: ctx.env.alias.keyTla, aliasView: true,
        };
      }
      if (ctx.isV2 && ctx.env.roAliases.has(node.name)) {
        return {
          type: 'noderec', fields: new Map(),
          baseKey: ctx.env.roAliases.get(node.name), aliasView: true,
        };
      }
      if (ctx.env.alias && node.name === ctx.env.alias.name) {
        // truthiness of the alias == "the key is a real node"
        return {
          tla: `(${ctx.env.alias.keyTla} \\in DOMAIN ${ctx.stateVar})`,
          type: 'bool',
        };
      }
      if (ctx.env.roAliases.has(node.name)) {
        return {
          tla: `(${ctx.env.roAliases.get(node.name)} \\in DOMAIN ${ctx.stateVar})`,
          type: 'bool',
        };
      }
      if (node.name === ctx.pName || node.name === ctx.modelName) {
        // the proposal / model objects are always truthy
        return { tla: 'TRUE', type: 'bool' };
      }
      if (node.name === 'undefined') {
        return { tla: '"__js_undefined__"', type: 'undef' };
      }
      failAt(`unknown identifier '${node.name}'`, node);
      break;
    }

    case 'MemberExpression': {
      // p.<field>
      if (
        !node.computed &&
        node.object.type === 'Identifier' && node.object.name === ctx.pName &&
        node.property.type === 'Identifier'
      ) {
        const f = node.property.name;
        if (f === ctx.actionFlag) return { tla: 'TRUE', type: 'bool' };
        if (f === '__name') return { tla: `"${ctx.actionName}"`, type: 'str' };
        if (ctx.dataKeys && ctx.dataKeys.has(f)) {
          // wrapper-style proposal: p.<dataKey> IS the payload record
          return { tla: 'd', type: 'rec' };
        }
        if (f in ctx.discFields) {
          return { tla: `"${ctx.discFields[f]}"`, type: 'str' };
        }
        if (ctx.allFlags.has(f)) return { tla: 'FALSE', type: 'bool' };
        if (!(f in ctx.payloadTypes)) {
          failAt(
            `payload field '${f}' does not appear in the checkerIntents ` +
              'values for this action — no domain to draw it from',
            node
          );
        }
        return { tla: `d.${f}`, type: ctx.payloadTypes[f] };
      }
      // next.* is write-only: reading it back is outside the subset
      {
        let root = node;
        while (root.type === 'MemberExpression') root = root.object;
        if (ctx.nextName && root.type === 'Identifier' && root.name === ctx.nextName) {
          failAt(
            `read of '${ctx.nextName}.*' — next holds the post-state and is ` +
              `write-only in the transpilable subset (read ${ctx.modelName}.* ` +
              'for the pre-state instead)',
            node
          );
        }
      }
      // scalar mode: model.<var> is ALWAYS the pre-state (unprimed) — the
      // 2.1 contract freezes model, so a read after `next.<var> = ...` still
      // sees the pre-state (no sequential-mutation fold).
      if (
        ctx.mode === 'scalar' && !node.computed &&
        node.object.type === 'Identifier' && node.object.name === ctx.modelName &&
        node.property.type === 'Identifier'
      ) {
        const sv = node.property.name;
        if (!ctx.scalarVars.includes(sv)) {
          failAt(
            `read of unknown state variable '${ctx.modelName}.${sv}' — state ` +
              `keys are [${ctx.scalarVars.join(', ')}]`,
            node
          );
        }
        return { tla: sv, type: ctx.scalarTypes[sv] ?? 'unknown' };
      }
      // n.<field>
      const f = matchAliasField(node, ctx);
      if (f) {
        // v2 snapshot semantics: `const n = model.<sv>[k]` captures the
        // pre-state record; the spread commit never mutates it, so alias
        // reads ALWAYS see the pre-state (even after a commit).
        return {
          tla: ctx.snapshotAlias
            ? fieldRead(ctx, f)
            : ctx.env.fields.get(f) ?? fieldRead(ctx, f),
          type: ctx.fieldTypes[f],
        };
      }
      // field read off a local record object (up.term, cur.role, ...)
      const rw = matchRecordField(node, ctx);
      if (rw) return recordRead(rw.rec, rw.field, ctx, node);
      // Extension: field reads off a payload record (`d2.node` where
      // `const d2 = p.data;`, or `p.data.node` directly)
      if (!node.computed && node.property.type === 'Identifier') {
        let isRec = false;
        if (
          node.object.type === 'Identifier' &&
          ctx.env.locals.has(node.object.name) &&
          ctx.env.locals.get(node.object.name).type === 'rec'
        ) {
          isRec = true;
        } else if (
          node.object.type === 'MemberExpression' && !node.object.computed &&
          node.object.object.type === 'Identifier' &&
          node.object.object.name === ctx.pName &&
          node.object.property.type === 'Identifier' &&
          ctx.dataKeys && ctx.dataKeys.has(node.object.property.name)
        ) {
          isRec = true;
        }
        if (isRec) {
          const g = node.property.name;
          if (!(g in ctx.payloadTypes)) {
            failAt(
              `payload field '${g}' does not appear in the checkerIntents ` +
                'values for this action — no domain to draw it from',
              node
            );
          }
          return { tla: `d.${g}`, type: ctx.payloadTypes[g] };
        }
      }
      // Extension: truthiness of the state map itself
      if (
        !node.computed &&
        node.object.type === 'Identifier' && node.object.name === ctx.modelName &&
        node.property.type === 'Identifier' && node.property.name === ctx.stateVar
      ) {
        return { tla: 'TRUE', type: 'bool' };
      }
      // Extension: read-only alias fields (other nodes' records)
      if (
        !node.computed &&
        node.object.type === 'Identifier' &&
        ctx.env.roAliases.has(node.object.name) &&
        node.property.type === 'Identifier'
      ) {
        const df = node.property.name;
        if (!ctx.fieldNames.includes(df)) {
          failAt(`read of unknown state field '${df}'`, node);
        }
        if (ctx.hasMutated && !ctx.snapshotAlias) {
          failAt(
            'read through a secondary alias after a mutation — could alias ' +
              'the mutated node (outside the subset)',
            node
          );
        }
        return {
          tla: `${ctx.stateVar}[${ctx.env.roAliases.get(node.object.name)}].${df}`,
          type: ctx.fieldTypes[df],
        };
      }
      // Extension: direct state reads.
      //   model.<sv>[e]           (truthiness) -> e \in DOMAIN <sv>
      //   model.<sv>[e].<field>   -> <sv>[e].<field>  (only before any
      //                              mutation — afterwards the read could
      //                              alias the mutated node, which the
      //                              symbolic env does not track)
      if (!node.computed && node.object.type === 'MemberExpression') {
        const baseKey = matchModelLookup(node.object, ctx);
        if (baseKey && node.property.type === 'Identifier') {
          const df = node.property.name;
          if (!ctx.fieldNames.includes(df)) {
            failAt(`read of unknown state field '${df}'`, node);
          }
          // 2.1 next-form bodies: model.* is the frozen pre-state, so a read
          // after a next-commit is still the unprimed variable — no aliasing
          // hazard. Legacy bodies keep the refusal.
          if (ctx.hasMutated && !ctx.nextForm) {
            failAt(
              'direct state read after a mutation — could alias the mutated ' +
                'node, which symbolic execution does not track (outside the ' +
                'subset)',
              node
            );
          }
          return { tla: `${ctx.stateVar}[${baseKey}].${df}`, type: ctx.fieldTypes[df] };
        }
      }
      const lookupKey = matchModelLookup(node, ctx);
      if (lookupKey) {
        return {
          tla: `(${lookupKey} \\in DOMAIN ${ctx.stateVar})`,
          type: 'bool',
        };
      }
      if (
        !node.computed &&
        node.object.type === 'Identifier' && node.object.name === ctx.modelName &&
        node.property.type === 'Identifier' && node.property.name !== ctx.stateVar
      ) {
        failAt(
          `read/write of private model key '${ctx.modelName}.${node.property.name}' — ` +
            `only the observable state variable '${ctx.stateVar}' exists in the ` +
            'TLA+ model (outside the subset)',
          node
        );
      }
      failAt(
        `member expression outside the subset (only ${ctx.pName}.<field> and ` +
          'alias fields are readable)',
        node
      );
      break;
    }

    case 'UnaryExpression': {
      if (node.operator === '!') {
        return { tla: notTla(txBool(node.argument, ctx)), type: 'bool' };
      }
      if (node.operator === '-') {
        const a = txExpr(node.argument, ctx);
        return { tla: `(-${a.tla})`, type: 'num' };
      }
      failAt(`unary operator '${node.operator}' is outside the subset`, node);
      break;
    }

    case 'BinaryExpression': {
      // Extension: `typeof x === '<t>'` folds to a constant (every value the
      // transpiler tracks has a statically known JS type).
      if (['===', '==', '!==', '!='].includes(node.operator)) {
        const tof = [node.left, node.right].find(
          (s) => s.type === 'UnaryExpression' && s.operator === 'typeof'
        );
        const lit = [node.left, node.right].find(
          (s) => s.type === 'Literal' && typeof s.value === 'string'
        );
        if (tof && lit) {
          const arg = txExpr(tof.argument, ctx);
          const isEq = node.operator === '===' || node.operator === '==';
          // A conditionally-initialized let has typeof 'undefined' on the
          // paths where it was never assigned — folding on the static type
          // alone would turn the guard into a constant and fire guarded
          // writes on paths where JS wrote nothing.
          const def = arg.definedIf ?? 'TRUE';
          if (lit.value === 'undefined') {
            const undef = notTla(def); // TRUE exactly when the value is not defined
            return { tla: isEq ? undef : notTla(undef), type: 'bool' };
          }
          const jsName =
            { num: 'number', str: 'string', bool: 'boolean' }[arg.type] ||
            (arg.type === 'rec' || arg.type === 'staterec' ? 'object' : null);
          if (!jsName) {
            failAt(`typeof on a value of type '${arg.type}' is outside the subset`, tof);
          }
          const same = jsName === lit.value;
          // A mismatched type name is false whether or not the value is
          // defined (typeof undefined is 'undefined', not lit.value); a
          // matching one holds exactly when the value IS defined.
          const eqTla = same ? def : 'FALSE';
          return { tla: isEq ? eqTla : notTla(eqTla), type: 'bool' };
        }
      }
      // Extension: comparisons against `undefined` / `null`. Any expression
      // the transpiler tracks as num/str/bool/rec is a defined non-null value
      // (payload fields come from the finite checkerIntents domain), so the
      // comparison folds to a constant.
      if (['===', '==', '!==', '!='].includes(node.operator)) {
        const nullish = [node.left, node.right].find(
          (s) =>
            (s.type === 'Identifier' && s.name === 'undefined') ||
            (s.type === 'Literal' && s.value === null)
        );
        if (nullish) {
          const other = node.left === nullish ? node.right : node.left;
          const o = txExpr(other, ctx); // must itself be inside the subset
          if (!['num', 'str', 'bool', 'rec'].includes(o.type)) {
            failAt(
              `comparison with null/undefined on a value of type '${o.type}' ` +
                'is outside the subset',
              node
            );
          }
          const isEq = node.operator === '===' || node.operator === '==';
          const strict = node.operator === '===' || node.operator === '!==';
          // A conditionally-initialized let IS undefined on the paths where
          // it was never assigned — `x === undefined` (and loose `x == null`)
          // is exactly its not-defined condition, not a constant. Strict
          // comparison with the null LITERAL can never match undefined (and
          // the subset tracks no null-valued expressions), so it stays
          // constant.
          const def = o.definedIf ?? 'TRUE';
          const matchesUndefined = !(nullish.type === 'Literal' && strict);
          const eqTla = matchesUndefined ? notTla(def) : 'FALSE';
          return { tla: isEq ? eqTla : notTla(eqTla), type: 'bool' };
        }
      }
      const map = {
        '===': '=', '==': '=', '!==': '/=', '!=': '/=',
        '<': '<', '<=': '<=', '>': '>', '>=': '>=',
        '+': '+', '-': '-', '*': '*',
      };
      const op = map[node.operator];
      if (!op) failAt(`operator '${node.operator}' is outside the subset`, node);
      const a = txExpr(node.left, ctx);
      const b = txExpr(node.right, ctx);
      if (['+', '-', '*'].includes(op) && (a.type === 'str' || b.type === 'str')) {
        failAt('string arithmetic is outside the subset', node);
      }
      const isCmp = ['=', '/=', '<', '<=', '>', '>='].includes(op);
      // Maybe-undefined operands (conditionally initialized lets): JS makes
      // undefined compare false against any defined value ('/=' true), and
      // poisons arithmetic (NaN) — the latter is outside the subset.
      const bothDef = andTla(a.definedIf ?? 'TRUE', b.definedIf ?? 'TRUE');
      if (bothDef !== 'TRUE') {
        if (!isCmp) {
          failAt(
            'arithmetic on a possibly-undefined value (NaN in JS) is ' +
              'outside the subset',
            node
          );
        }
        const cmp = `(${a.tla} ${op} ${b.tla})`;
        return {
          tla: op === '/=' ? orTla(notTla(bothDef), cmp) : andTla(bothDef, cmp),
          type: 'bool',
        };
      }
      return { tla: `(${a.tla} ${op} ${b.tla})`, type: isCmp ? 'bool' : 'num' };
    }

    case 'LogicalExpression': {
      const op =
        node.operator === '&&' ? '/\\' :
        node.operator === '||' ? '\\/' : null;
      if (!op) failAt(`logical operator '${node.operator}' is outside the subset`, node);
      const a = txExpr(node.left, ctx);
      // Extension: JS value semantics for non-boolean operands
      //   a || b == IF truthy(a) THEN a ELSE b ; a && b == IF truthy(a) THEN b ELSE a
      // The right operand is evaluated lazily so constant-truthy defaults
      // like `p.data || {}` never touch the (unsupported) fallback literal.
      const ta = truthyTla(a, node.left, ctx);
      if (ta === 'TRUE') return node.operator === '||' ? a : txExpr(node.right, ctx);
      if (ta === 'FALSE') return node.operator === '||' ? txExpr(node.right, ctx) : a;
      const b = txExpr(node.right, ctx);
      if (a.type === 'bool' && b.type === 'bool') {
        return { tla: `(${a.tla} ${op} ${b.tla})`, type: 'bool' };
      }
      const tla =
        node.operator === '||'
          ? `(IF ${ta} THEN ${a.tla} ELSE ${b.tla})`
          : `(IF ${ta} THEN ${b.tla} ELSE ${a.tla})`;
      return { tla, type: a.type === b.type ? a.type : 'unknown' };
    }

    case 'ConditionalExpression': {
      const c = txBool(node.test, ctx);
      // constant tests short-circuit (the dead arm may be outside the subset,
      // e.g. a `null` fallback that provably cannot be reached)
      if (c === 'TRUE') return txExpr(node.consequent, ctx);
      if (c === 'FALSE') return txExpr(node.alternate, ctx);
      const a = txExpr(node.consequent, ctx);
      const b = txExpr(node.alternate, ctx);
      return {
        tla: `(IF ${c} THEN ${a.tla} ELSE ${b.tla})`,
        type: a.type === b.type ? a.type : 'unknown',
      };
    }

    case 'CallExpression': {
      const callee = node.callee;
      if (
        callee.type === 'MemberExpression' && !callee.computed &&
        callee.object.type === 'Identifier' && callee.object.name === 'Math' &&
        (callee.property.name === 'max' || callee.property.name === 'min')
      ) {
        if (node.arguments.length !== 2) {
          failAt('Math.max/Math.min with != 2 arguments is outside the subset', node);
        }
        const a = txExpr(node.arguments[0], ctx);
        const b = txExpr(node.arguments[1], ctx);
        const fn = callee.property.name === 'max' ? 'Max' : 'Min';
        return { tla: `${fn}(${a.tla}, ${b.tla})`, type: 'num' };
      }
      // `[lit, ...].includes(e)` -> set membership (inline literal array)
      if (
        callee.type === 'MemberExpression' && !callee.computed &&
        callee.object.type === 'ArrayExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'includes' && node.arguments.length === 1
      ) {
        const els = callee.object.elements;
        if (
          !els.every(
            (el) => el && el.type === 'Literal' &&
              (typeof el.value === 'string' || typeof el.value === 'number')
          )
        ) {
          failAt('includes() on a non-literal array is outside the subset', node);
        }
        const a = txExpr(node.arguments[0], ctx);
        const set = els
          .map((el) => (typeof el.value === 'string' ? `"${el.value}"` : String(el.value)))
          .join(', ');
        return { tla: `(${a.tla} \\in {${set}})`, type: 'bool' };
      }
      // Extension: `CONSTARRAY.includes(e)` -> set membership
      if (
        callee.type === 'MemberExpression' && !callee.computed &&
        callee.object.type === 'Identifier' &&
        ctx.constArrays && ctx.constArrays.has(callee.object.name) &&
        callee.property.name === 'includes' && node.arguments.length === 1
      ) {
        const a = txExpr(node.arguments[0], ctx);
        const set = ctx.constArrays
          .get(callee.object.name)
          .map((v) => (typeof v === 'string' ? `"${v}"` : String(v)))
          .join(', ');
        return { tla: `(${a.tla} \\in {${set}})`, type: 'bool' };
      }
      // Extension: numeric coercion no-ops on already-numeric values
      if (callee.type === 'Identifier' && callee.name === 'Number') {
        const a = txExpr(node.arguments[0], ctx);
        if (a.type === 'num') return a;
        failAt('Number(x) on a non-numeric operand is outside the subset', node);
      }
      if (
        callee.type === 'MemberExpression' && !callee.computed &&
        callee.object.type === 'Identifier' && callee.object.name === 'Number' &&
        (callee.property.name === 'isFinite' || callee.property.name === 'isInteger')
      ) {
        const a = txExpr(node.arguments[0], ctx);
        if (a.type === 'num') return { tla: 'TRUE', type: 'bool' };
        failAt(`Number.${callee.property.name} on a non-numeric operand`, node);
      }
      if (callee.type === 'Identifier' && callee.name === 'String') {
        const a = txExpr(node.arguments[0], ctx);
        if (a.type === 'str') return a; // identity on strings
        if (node.arguments[0].type === 'Literal' &&
            typeof node.arguments[0].value === 'number') {
          return { tla: `"${node.arguments[0].value}"`, type: 'str' };
        }
        failAt(
          'String(x) on a non-string operand is outside the subset ' +
            '(TLA+ has no integer-to-string coercion here)',
          node
        );
      }
      if (
        callee.type === 'Identifier' && ctx.helpers && ctx.helpers.has(callee.name)
      ) {
        return inlineHelper(node, ctx); // extension: pure helper inlining
      }
      failAt(
        `call '${SRC.slice(node.start, node.end)}' is outside the subset ` +
          '(only Math.max, Math.min, String on strings, and inlinable pure helpers)',
        node
      );
      break;
    }

    case 'ObjectExpression': {
      if (!ctx.isV2) {
        failAt(
          `expression 'ObjectExpression' (object literal construction) is ` +
            'outside the subset',
          node
        );
      }
      return txRecord(node, ctx);
    }

    default:
      failAt(`expression '${node.type}' (${friendlyName(node.type)}) is outside the subset`, node);
  }
}

// v2 record literal -> symbolic node record.
//   { ...n, f: e, ... }   spread-with-overrides (spread must come first)
//   { f1: e1, ..., fn: en } full field list (no base)
function txRecord(node, ctx) {
  let fields = new Map();
  let baseKey = null;
  for (let i = 0; i < node.properties.length; i++) {
    const el = node.properties[i];
    if (el.type === 'SpreadElement') {
      if (i !== 0) {
        failAt('a ...spread must be the FIRST entry of a record literal', el);
      }
      const arg = txExpr(el.argument, ctx);
      if (arg.type !== 'noderec') {
        failAt('spread of a non-record value in a record literal', el);
      }
      baseKey = arg.baseKey;
      fields = new Map(arg.fields);
      continue;
    }
    if (el.type !== 'Property') {
      failAt(`record literal entry '${el.type}' is outside the subset`, el);
    }
    if (el.computed) {
      failAt(
        'computed keys are only supported in the top-level state commit',
        el
      );
    }
    const key = el.key.name ?? el.key.value;
    const v = txExpr(el.value, ctx);
    if (v.type === 'noderec') {
      failAt('nested record values are outside the subset', el);
    }
    requireDefined(v, el, `record field '${key}'`);
    fields.set(key, v);
  }
  return { type: 'noderec', fields, baseKey, aliasView: false };
}

function notTla(t) {
  if (t === 'TRUE') return 'FALSE';
  if (t === 'FALSE') return 'TRUE';
  if (t.startsWith('~(') && t.endsWith(')')) return t.slice(1); // ~~x == x
  return t.startsWith('(') ? `~${t}` : `~(${t})`;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function tlaValue(v) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    // TLA+ string literals have no escape mechanism for embedded quotes —
    // refuse loudly rather than emitting a malformed module. Backslashes are
    // passed through (TLA+ strings are not backslash-escaped).
    if (v.includes('"')) die(`cannot emit string ${JSON.stringify(v)} as TLA+ (embedded double quote has no TLA+ escape)`);
    return `"${v}"`;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  die(`cannot emit JS value ${JSON.stringify(v)} as TLA+`);
}

function tlaRecord(obj) {
  return `[${Object.entries(obj).map(([k, v]) => `${k} |-> ${tlaValue(v)}`).join(', ')}]`;
}

function emitModule(m) {
  if (m.mode === 'scalar') return emitModuleScalar(m);
  const L = [];
  const header = `---------------------------- MODULE ${m.moduleName} ----------------------------`;
  L.push(header);
  L.push(`\\* Generated by polygraph scripts/to-tla.mjs from`);
  L.push(`\\*   ${m.specPath}`);
  L.push(`\\* Do not edit by hand.`);
  L.push(`EXTENDS Integers, TLC`);
  L.push('');
  L.push(`VARIABLE ${m.stateVar}`);
  L.push('');
  L.push(`Max(a, b) == IF a >= b THEN a ELSE b`);
  L.push(`Min(a, b) == IF a <= b THEN a ELSE b`);
  L.push('');

  // Init
  const nodeIds = Object.keys(m.nodesObj);
  const initParts = nodeIds.map(
    (id) => `"${id}" :> ${tlaRecord(m.nodesObj[id])}`
  );
  L.push('Init ==');
  L.push(`  ${m.stateVar} = ( ${initParts.join('\n            @@ ')} )`);
  L.push('');

  // Actions.
  //
  // JS commit semantics vs TLA+: the spread-commit `{ ...sv, [k]: rec }` ADDS
  // key k when it is absent, but `[sv EXCEPT ![k] = ...]` on a key outside
  // DOMAIN sv returns sv UNCHANGED — a silent stutter that erases reachable
  // JS states from the model (a false TLC pass). When every value the commit
  // key can take is provably in the Init domain the plain EXCEPT is emitted;
  // otherwise the update is guarded on domain membership, with `(k :> rec)
  // @@ sv` extending the domain exactly as the JS spread does. (In the ELSE
  // branch a field falling back to `sv[k].f` is an out-of-domain apply — TLC
  // errors loudly there, which matches JS reading a field of a node that
  // does not exist.)
  const keyProvablyInDomain = (a) => {
    const lit = a.keyTla.match(/^"(.*)"$/);
    if (lit) return nodeIds.includes(lit[1]);
    const pf = a.keyTla.match(/^d\.([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (pf) {
      return a.payloads.length > 0
        && a.payloads.every((p) => typeof p[pf[1]] === 'string' && nodeIds.includes(p[pf[1]]));
    }
    return false; // can't prove — use the guarded (creation-capable) form
  };
  for (const a of m.actions) {
    const setName = `${a.name}Payloads`;
    L.push(`${setName} == {`);
    L.push(a.payloads.map((p) => `  ${tlaRecord(p)}`).join(',\n'));
    L.push('}');
    L.push('');
    L.push(`${a.name} ==`);
    L.push(`  \\E d \\in ${setName} :`);
    for (const g of a.guards) L.push(`    /\\ ${g}`);
    const fieldUpdates = m.fieldNames
      .map((f) => `${f} |-> ${a.fields.get(f) ?? `${m.stateVar}[${a.keyTla}].${f}`}`)
      .join(',\n         ');
    if (keyProvablyInDomain(a)) {
      L.push(`    /\\ ${m.stateVar}' = [${m.stateVar} EXCEPT ![${a.keyTla}] =`);
      L.push(`        [${fieldUpdates}]]`);
    } else {
      L.push(`    \\* commit key may be outside DOMAIN ${m.stateVar}: JS would CREATE the`);
      L.push(`    \\* entry, EXCEPT would silently stutter — guard on membership.`);
      L.push(`    /\\ ${m.stateVar}' = IF ${a.keyTla} \\in DOMAIN ${m.stateVar}`);
      L.push(`        THEN [${m.stateVar} EXCEPT ![${a.keyTla}] =`);
      L.push(`          [${fieldUpdates}]]`);
      L.push(`        ELSE (${a.keyTla} :> [${fieldUpdates}]) @@ ${m.stateVar}`);
    }
    L.push('');
  }

  L.push('Next ==');
  L.push(m.actions.map((a) => `  \\/ ${a.name}`).join('\n'));
  L.push('');

  // Invariants: translated from the JS predicate sources of the contract's
  // invariants file (generalization (a); each carries its source as a comment).
  for (const iv of m.invariants) {
    for (const line of iv.jsSource.split('\n')) {
      L.push(`\\* ${line.replace(/\s+$/, '')}`);
    }
    L.push(`${iv.name} ==`);
    L.push(`  ${iv.tla}`);
    L.push('');
  }

  // State constraint: bound every numeric per-node counter.
  const numFields = m.fieldNames.filter((f) => m.fieldTypes[f] === 'num');
  L.push(`\\* Bound the only unbounded counters (payload domains are finite).`);
  L.push('StateConstraint ==');
  L.push(
    numFields.length === 0
      ? '  TRUE'
      : `  \\A i \\in DOMAIN ${m.stateVar} : ` +
        numFields.map((f) => `${m.stateVar}[i].${f} <= ${m.bound}`).join(' /\\ ')
  );
  L.push('');
  L.push('='.repeat(header.length));
  L.push('');
  return L.join('\n');
}

// Scalar-mode emission: each top-level scalar state key is its own TLA+
// VARIABLE; per action, every written variable gets a primed assignment
// (var' = expr, RHS over unprimed variables — 2.1 reads are pre-state) and
// the unwritten variables become one UNCHANGED conjunct.
function emitModuleScalar(m) {
  const L = [];
  const header = `---------------------------- MODULE ${m.moduleName} ----------------------------`;
  L.push(header);
  L.push(`\\* Generated by polygraph scripts/to-tla.mjs from`);
  L.push(`\\*   ${m.specPath}`);
  L.push(`\\* Do not edit by hand.`);
  L.push(`EXTENDS Integers, TLC`);
  L.push('');
  L.push(`VARIABLES ${m.scalarVars.join(', ')}`);
  L.push('');
  L.push(`Max(a, b) == IF a >= b THEN a ELSE b`);
  L.push(`Min(a, b) == IF a <= b THEN a ELSE b`);
  L.push('');

  L.push('Init ==');
  for (const v of m.scalarVars) {
    L.push(`  /\\ ${v} = ${tlaValue(m.scalarInit[v])}`);
  }
  L.push('');

  for (const a of m.actions) {
    const noPayload = a.payloads.every((p) => Object.keys(p).length === 0);
    const conj = [];
    for (const g of a.guards) conj.push(`/\\ ${g}`);
    const written = m.scalarVars.filter((v) => a.fields.has(v));
    const unwritten = m.scalarVars.filter((v) => !a.fields.has(v));
    for (const v of written) conj.push(`/\\ ${v}' = ${a.fields.get(v)}`);
    if (unwritten.length > 0) {
      conj.push(`/\\ UNCHANGED <<${unwritten.join(', ')}>>`);
    }
    if (conj.length === 0) conj.push('/\\ TRUE');
    if (noPayload) {
      // an empty payload domain record set ({ [] }) is not valid TLA+ — and
      // the quantifier would be vacuous anyway
      L.push(`${a.name} ==`);
      for (const c of conj) L.push(`  ${c}`);
    } else {
      const setName = `${a.name}Payloads`;
      L.push(`${setName} == {`);
      L.push(a.payloads.map((p) => `  ${tlaRecord(p)}`).join(',\n'));
      L.push('}');
      L.push('');
      L.push(`${a.name} ==`);
      L.push(`  \\E d \\in ${setName} :`);
      for (const c of conj) L.push(`    ${c}`);
    }
    L.push('');
  }

  L.push('Next ==');
  L.push(m.actions.map((a) => `  \\/ ${a.name}`).join('\n'));
  L.push('');

  for (const iv of m.invariants) {
    for (const line of iv.jsSource.split('\n')) {
      L.push(`\\* ${line.replace(/\s+$/, '')}`);
    }
    L.push(`${iv.name} ==`);
    L.push(`  ${iv.tla}`);
    L.push('');
  }

  const numVars = m.scalarVars.filter((v) => m.scalarTypes[v] === 'num');
  L.push(`\\* Bound the only unbounded counters (payload domains are finite).`);
  L.push('StateConstraint ==');
  L.push(
    numVars.length === 0
      ? '  TRUE'
      : '  ' + numVars.map((v) => `${v} <= ${m.bound}`).join(' /\\ ')
  );
  L.push('');
  L.push('='.repeat(header.length));
  L.push('');
  return L.join('\n');
}

function emitCfg(invariantNames) {
  return [
    'INIT Init',
    'NEXT Next',
    'CONSTRAINT StateConstraint',
    ...invariantNames.map((n) => `INVARIANT ${n}`),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Bare {init,next} diagnostic
// ---------------------------------------------------------------------------

const SUBSET_STMT_TYPES = new Set([
  'BlockStatement', 'IfStatement', 'ReturnStatement', 'ExpressionStatement',
  'AssignmentExpression', 'UpdateExpression', 'VariableDeclaration',
  'VariableDeclarator', 'Identifier', 'Literal', 'MemberExpression',
  'BinaryExpression', 'LogicalExpression', 'UnaryExpression',
  'CallExpression', 'ConditionalExpression',
  'Property', // only meaningful as part of an already-reported ObjectExpression
]);

const FRIENDLY = {
  ForOfStatement: 'for...of loop',
  ForInStatement: 'for...in loop',
  ForStatement: 'for loop',
  WhileStatement: 'while loop',
  DoWhileStatement: 'do...while loop',
  SwitchStatement: 'switch statement',
  SpreadElement: 'object/array spread',
  ObjectExpression: 'object literal construction',
  ArrayExpression: 'array literal construction',
  TemplateLiteral: 'template literal',
  ThrowStatement: 'throw',
  TryStatement: 'try/catch',
  FunctionDeclaration: 'nested function',
  ArrowFunctionExpression: 'nested arrow function',
};

function friendlyName(t) {
  return FRIENDLY[t] || t;
}

function bareNextDiagnostic(ast) {
  console.error('to-tla: TRANSPILE ERROR: no SAM acceptors array found — this looks');
  console.error('  like a bare { init, next } module, which is not transpilable:');
  console.error('  in a bare next() the guards are IMPLICIT in arbitrary control');
  console.error('  flow (action-string dispatch, loops, object spreads); nothing in');
  console.error('  the module shape marks which conditions are preconditions of');
  console.error('  which transition, so there is no mechanical guard/update split');
  console.error('  to lift into TLA+ actions.');

  // Locate a next() function and name the first offending construct.
  let nextFn = null;
  for (const n of walkAst(ast)) {
    if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'next') {
      nextFn = n;
      break;
    }
    if (
      n.type === 'VariableDeclarator' && n.id.type === 'Identifier' &&
      n.id.name === 'next' && n.init &&
      (n.init.type === 'ArrowFunctionExpression' || n.init.type === 'FunctionExpression')
    ) {
      nextFn = n.init;
      break;
    }
  }
  if (nextFn) {
    console.error('  Constructs in next() outside the transpilable subset:');
    const seen = new Set();
    let shown = 0;
    for (const n of walkAst(nextFn.body)) {
      if (SUBSET_STMT_TYPES.has(n.type) || seen.has(n.type)) continue;
      seen.add(n.type);
      const line = n.loc ? n.loc.start.line : '?';
      const snippet = n.loc ? (SRC.split('\n')[n.loc.start.line - 1] || '').trim() : '';
      console.error(`    - ${n.type} (${friendlyName(n.type)}) at ${FILE}:${line}`);
      console.error(`        ${snippet}`);
      if (++shown >= 4) break;
    }
  }
}

// CLI entry point (module import leaves this inert)
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    if (err instanceof TranspileError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  });
}
