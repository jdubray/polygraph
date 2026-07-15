// Self-test for the TLC escalation tier's transpiler (scripts/to-tla.mjs) —
// output-shape checks only, no Java/TLC needed.
//
// Focus: JS spread-commit `{ ...sv, [k]: rec }` ADDS the key when absent, but
// TLA+ `[sv EXCEPT ![k] = ...]` on a key outside DOMAIN sv is a silent
// stutter — reachable JS states would vanish from the model (a false TLC
// pass). The transpiler must emit a domain-membership-guarded update whenever
// the commit key is not provably in the Init domain.
//
// Run: node test/selftest-tla.mjs   (wired into `npm test`)
import { strict as assert } from 'node:assert';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transpile } from '../scripts/to-tla.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TMP = join(HERE, '.tmp-tla');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ok  ' + name);
  passed++;
}

console.log('1) reference spec (all commit keys provably in the Init domain)');
await transpile(join(ROOT, 'examples', 'etcd-raft-v2', 'spec.cjs'), {
  outPath: join(TMP, 'Raft.tla'),
  invariantsPath: join(ROOT, 'examples', 'etcd-raft-v2', 'invariants.mjs'),
  contractPath: join(ROOT, 'examples', 'etcd-raft-v2', 'contract.json'),
});
const raft = readFileSync(join(TMP, 'Raft.tla'), 'utf-8');
ok('plain EXCEPT kept for provably-in-domain commits (no spurious guards)',
  (raft.match(/EXCEPT/g) || []).length === 5 && !/IF d\.\w+ \\in DOMAIN/.test(raft));

console.log('2) creation-shaped commit (payload key outside the Init domain)');
const createSpec = join(TMP, 'create-spec.cjs');
writeFileSync(createSpec, `'use strict';
const { createInstance } = require('@cognitive-fab/sam-pattern');
const instance = createInstance({ strict: true, hasAsyncActions: false });
const INITIAL_STATE = { nodes: { n1: { seen: 0 } } };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { nodes: { type: 'object' } },
    actions: {
      REGISTER: { action: (d = {}) => ({ ...d }), schema: { id: { type: 'string', required: true } }, domain: [{ id: 'n1' }, { id: 'n2' }] },
    },
    acceptors: {
      REGISTER: (model) => (p, { reject }) => {
        const n = model.nodes[p.id];
        if (n) return reject('already-registered');
        model.nodes = { ...model.nodes, [p.id]: { seen: 1 } };
      },
    },
    reactors: [],
  },
});
const { intents } = control;
const getState = () => instance({}).getState();
const setState = (s) => { instance({}).setState(s); };
const init = () => { setState(INITIAL_STATE); };
const actions = Object.fromEntries(Object.keys(intents).map((k) => [k, (d = {}) => intents[k](d)]));
module.exports = { instance, init, actions, getState, setState };
`, 'utf-8');
await transpile(createSpec, { outPath: join(TMP, 'Create.tla') });
const create = readFileSync(join(TMP, 'Create.tla'), 'utf-8');
ok('creation commit is guarded on DOMAIN membership (no silent stutter)',
  /IF d\.id \\in DOMAIN nodes/.test(create));
ok('the ELSE branch extends the domain exactly as the JS spread does (k :> rec @@ sv)',
  /ELSE \(d\.id :> \[seen \|-> 1\]\) @@ nodes/.test(create));
ok('the THEN branch still uses EXCEPT for the existing-key case',
  /THEN \[nodes EXCEPT !\[d\.id\] =/.test(create));

console.log('3) undefined/typeof folds on conditionally-initialized lets consult definedIf');
const definedIfSpec = join(TMP, 'definedif-spec.cjs');
writeFileSync(definedIfSpec, `'use strict';
const { createInstance } = require('@cognitive-fab/sam-pattern');
const instance = createInstance({ strict: true, hasAsyncActions: false });
const INITIAL_STATE = { nodes: { n1: { count: 0 } } };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { nodes: { type: 'object' } },
    actions: {
      COUNT: { action: (d = {}) => ({ ...d }), schema: { id: { type: 'string', required: true }, v: { type: 'number', required: true } }, domain: [{ id: 'n1', v: 0 }, { id: 'n1', v: 1 }] },
    },
    acceptors: {
      COUNT: (model) => (p, { reject }) => {
        const n = model.nodes[p.id];
        let seen;
        if (p.v === n.count) seen = 1;
        if (seen !== undefined) return reject('already-seen');
        model.nodes = { ...model.nodes, [p.id]: { count: p.v } };
      },
    },
    reactors: [],
  },
});
const { intents } = control;
const getState = () => instance({}).getState();
const setState = (s) => { instance({}).setState(s); };
const init = () => { setState(INITIAL_STATE); };
const actions = Object.fromEntries(Object.keys(intents).map((k) => [k, (d = {}) => intents[k](d)]));
module.exports = { instance, init, actions, getState, setState };
`, 'utf-8');
// Old behavior: `seen !== undefined` folded to constant TRUE (static type
// only), turning the acceptor into an unconditional early return — the COUNT
// action silently vanished from the model. It must instead translate to the
// let's definedness condition (v == count), keeping the commit reachable.
let definedIfOutcome;
try {
  await transpile(definedIfSpec, { outPath: join(TMP, 'DefinedIf.tla') });
  definedIfOutcome = { threw: false, tla: readFileSync(join(TMP, 'DefinedIf.tla'), 'utf-8') };
} catch (e) {
  definedIfOutcome = { threw: true, message: e.message };
}
ok('conditionally-initialized let: the guard is NOT folded to a constant (loud refusal or a real condition)',
  definedIfOutcome.threw
    ? true // refusing loudly is sound — silent mistranslation is the bug
    : /d\.v = nodes\[d\.id\]\.count/.test(definedIfOutcome.tla)
      && /nodes'/.test(definedIfOutcome.tla));
if (!definedIfOutcome.threw) {
  ok('the commit stays reachable (old fold made the acceptor an unconditional return)',
    /count \|-> d\.v/.test(definedIfOutcome.tla));
}

console.log('4) TLC output parsing + status precedence');
{
  const { parseTlcOutput, tlcStatus } = await import('../scripts/tla-check.mjs');
  const grouped = parseTlcOutput(
    '3,001,443 states generated, 1,204,977 distinct states found, 12,345 states left on queue.\n' +
    'Model checking completed. No error has been found.\n'
  );
  ok('comma-grouped TLC state counts parse in full (not just the last digit group)',
    grouped.statesGenerated === 3001443 && grouped.distinctStates === 1204977 && grouped.queueDepth === 12345);
  const violatedThenHung = parseTlcOutput('Error: Invariant NoDoubleCharge is violated\n');
  ok('a violation printed before a timeout is reported as the violation, not buried as timeout',
    tlcStatus(violatedThenHung, true, null) === 'invariant-violation');
  ok('a clean run that timed out is a timeout', tlcStatus(parseTlcOutput(''), true, null) === 'timeout');
  ok('completedClean + exit 0 is required for pass', tlcStatus(parseTlcOutput(''), false, 0) === 'error');
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} CHECKS PASSED`);
