// Full polygen() orchestration self-test with a SCRIPTED model stub — no API.
//
// The scripted run exercises the guarantee the conformance-repair path must
// uphold: a post-replay rewrite produces NEW code, so the stage-3 verdict no
// longer applies — polygen must re-model-check the rewrite, and a repair that
// reintroduces a reachable invariant violation must ship as NOT converged.
//
// Construction: M1 keeps a hidden `internal` counter that survives in-process
// corpus synthesis (init once per scenario) but is reset by the replayer's
// per-window init() — a deterministic cross-process conformance failure,
// exactly the class stage 5 exists to catch. The stubbed "repair" M2 removes
// the hidden state but reintroduces a reachable 'BROKEN' control state.
//
// Run: node test/selftest-polygen.mjs   (wired into `npm test`)
import { strict as assert } from 'node:assert';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { polygen } from '../scripts/polygen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, '.tmp-polygen');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ok  ' + name);
  passed++;
}

const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';

const V2_HEADER = `'use strict';
const { createInstance } = require('@cognitive-fab/sam-pattern');
const instance = createInstance({ strict: true, hasAsyncActions: false });
`;
const V2_FOOTER = `
const { intents } = control;
const getState = () => instance({}).getState();
const setState = (s) => { instance({}).setState(s); };
const init = () => { setState(INITIAL_STATE); };
const actions = Object.fromEntries(Object.keys(intents).map((k) => [k, (d = {}) => intents[k](d)]));
module.exports = { instance, init, actions, getState, setState };
`;

// M1: converges clean in stage 3 (deterministic: init() resets `hits`), but
// its behavior depends on the hidden internal counter, so the replayer's
// per-window init()+setState(pre) cannot reproduce mid-scenario windows.
const M1 = `${V2_HEADER}
const INITIAL_STATE = { state: 'COLD', hits: 0 };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' }, hits: { type: 'number', internal: true } },
    actions: { BUMP: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] } },
    acceptors: {
      BUMP: (model) => (p, { next }) => {
        const hits = model.hits + 1;   // pre-state read, threaded locally
        next.hits = hits;
        next.state = hits >= 2 ? 'HOT' : 'WARM';
      },
    },
    reactors: [],
  },
});
${V2_FOOTER}`;

// M2 (the stubbed "conformance repair"): stateless across steps (replay-clean)
// but reaches the undeclared 'BROKEN' control state — a reachable invariant
// violation the re-check MUST catch.
const M2 = `${V2_HEADER}
const INITIAL_STATE = { state: 'COLD' };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' } },
    actions: { BUMP: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] } },
    acceptors: {
      BUMP: (model) => (p, { next }) => { next.state = model.state === 'COLD' ? 'WARM' : 'BROKEN'; },
    },
    reactors: [],
  },
});
${V2_FOOTER}`;

const INVARIANTS = `export const stateInvariants = [
  { name: 'never-broken', pred: (s) => s.state !== 'BROKEN' },
];
export const transitionInvariants = [];
`;

const SCENARIOS = JSON.stringify({ s1: [['BUMP', {}], ['BUMP', {}]] });

const contractPath = join(TMP, 'contract.json');
writeFileSync(contractPath, JSON.stringify({
  stateKeys: ['state'],
  initState: { state: 'COLD' },
  actions: { BUMP: { dataFields: {} } },
}, null, 2), 'utf-8');

console.log('1) conformance repair must be RE-CHECKED (a rewrite ships under its own verdict)');
const stages = [];
const stub = (stage) => {
  stages.push(stage);
  if (stage === 'author') return fence('javascript', M1);
  if (stage === 'invariants') return fence('javascript', INVARIANTS);
  if (stage === 'scenarios') return fence('json', SCENARIOS);
  if (stage === 'repair-conformance') return fence('javascript', M2);
  throw new Error(`unexpected stage: ${stage}`);
};

const r = await polygen({
  intent: 'a two-step heater machine (test fixture)',
  contractPath,
  out: join(TMP, 'out'),
  callImpl: stub,
});

ok('stage 3 converged on M1 (iteration 0, no violations)',
  r.repairHistory[0].iteration === 0 && r.repairHistory[0].violationCount === 0);
ok('hidden-state module fails its own corpus in the separate-process replay',
  r.conformanceRepair !== null && r.conformanceRepair.before > 0);
ok('the conformance rewrite was requested from the model',
  stages.includes('repair-conformance'));
ok('the rewrite is RE-model-checked (conformance-recheck round recorded)',
  r.repairHistory.some((it) => it.iteration === 'conformance-recheck'));
const recheck = r.repairHistory.find((it) => it.iteration === 'conformance-recheck');
ok('the re-check catches the reintroduced violation', recheck.violationCount === 1
  && recheck.violations.includes('never-broken'));
ok('a repair that reintroduces a violation flips the run to NOT converged',
  r.converged === false);
ok('finalCheck reflects the REWRITTEN code, not the stage-3 code',
  r.finalCheck.violations.some((v) => v.invariant === 'never-broken'));
const report = readFileSync(join(TMP, 'out', 'polygen-report.md'), 'utf-8');
ok('report says DID NOT CONVERGE (never a clean verdict on unchecked code)',
  report.includes('DID NOT CONVERGE') && !report.includes('**Converged'));
ok("report names the surviving violation", report.includes('never-broken'));
ok('M2 replays its own re-synthesized corpus clean (after == 0)',
  r.conformanceRepair.after === 0 && r.replay.fails === 0);

console.log('2) exploration-coverage gaps block convergence (a skipped intent must not present as clean)');
// The contract declares BUMP and PING; the authored module only registers
// BUMP. Nothing violates, nothing gaps — but PING was NEVER explored, and
// that must not converge.
const contract2 = join(TMP, 'contract2.json');
writeFileSync(contract2, JSON.stringify({
  stateKeys: ['state'],
  initState: { state: 'COLD' },
  actions: { BUMP: { dataFields: {} }, PING: { dataFields: {} } },
}, null, 2), 'utf-8');
const M3 = `${V2_HEADER}
const INITIAL_STATE = { state: 'COLD' };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' } },
    actions: { BUMP: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] } },
    acceptors: { BUMP: (model) => (p, { next }) => { next.state = 'WARM'; } },
    reactors: [],
  },
});
${V2_FOOTER}`;
const repairStages2 = [];
const stub2 = (stage) => {
  if (stage === 'author') return fence('javascript', M3);
  if (stage === 'invariants') return fence('javascript', 'export const stateInvariants = [{ name: "always", pred: () => true }];\nexport const transitionInvariants = [];\n');
  if (stage === 'scenarios') return fence('json', JSON.stringify({ s1: [['BUMP', {}]] }));
  if (/^repair-\d+-domain-gap$/.test(stage)) { repairStages2.push(stage); return fence('javascript', M3); } // "repair" never fixes it
  throw new Error(`unexpected stage: ${stage}`);
};
const r2 = await polygen({
  intent: 'coverage-gap fixture',
  contractPath: contract2,
  out: join(TMP, 'out2'),
  callImpl: stub2,
  repairMax: 2,
});
ok('a contract action missing from the manifest is a coverage note',
  r2.coverageNotes.some((n) => /'PING' is not in the module's manifest/.test(n)));
ok('coverage notes are REPAIRABLE: the repair budget is spent through the domain-gap prompt',
  repairStages2.length === 2 && repairStages2[0] === 'repair-0-domain-gap');
ok('coverage notes block convergence (no vacuous clean over a partial machine)',
  r2.converged === false);
const report2 = readFileSync(join(TMP, 'out2', 'polygen-report.md'), 'utf-8');
ok('report renders the never-explored warning', /NEVER explored/.test(report2) && /PING/.test(report2));

console.log('3) invariants gate: default export unwraps; an empty set is refused (vacuous check)');
{
  const stubDefault = (stage) => {
    if (stage === 'author') return fence('javascript', M3);
    if (stage === 'invariants') return fence('javascript',
      'export default { stateInvariants: [{ name: "always", pred: () => true }], transitionInvariants: [] };\n');
    if (stage === 'scenarios') return fence('json', JSON.stringify({ s1: [['BUMP', {}]] }));
    throw new Error(`unexpected stage: ${stage}`);
  };
  const contract3 = join(TMP, 'contract3.json');
  writeFileSync(contract3, JSON.stringify({
    stateKeys: ['state'], initState: { state: 'COLD' }, actions: { BUMP: { dataFields: {} } },
  }, null, 2), 'utf-8');
  const r3 = await polygen({ intent: 'default-export fixture', contractPath: contract3, out: join(TMP, 'out3'), callImpl: stubDefault });
  ok('a default-exported invariants module is unwrapped (check ran, run converged)', r3.converged === true);

  const stubEmpty = (stage) => {
    if (stage === 'author') return fence('javascript', M3);
    if (stage === 'invariants') return fence('javascript', 'export const rules = [];\n'); // wrong names
    if (stage === 'scenarios') return fence('json', JSON.stringify({ s1: [['BUMP', {}]] }));
    throw new Error(`unexpected stage: ${stage}`);
  };
  let threw = null;
  try { await polygen({ intent: 'empty-invariants fixture', contractPath: contract3, out: join(TMP, 'out4'), callImpl: stubEmpty }); }
  catch (e) { threw = e.message; }
  ok('an invariants module with NO recognized exports is refused (never a vacuous clean)',
    threw !== null && /vacuously/.test(threw));
}

console.log('4) domain cross-check: numeric/boolean values are token-matched, not substring-matched');
{
  const { findDataDomainRefGaps } = await import('../scripts/polygen.mjs');
  const c = { dataDomain: { SET: { level: [3, 15] } } };
  ok('a number appearing only inside another number is a GAP (no substring false negative)',
    findDataDomainRefGaps(c, 'const x = 13; const y = 150;').length === 2);
  ok('a standalone numeric token is found', findDataDomainRefGaps(c, 'if (p.level === 3 || p.level === 15) {}').length === 0);
  const cs = { dataDomain: { GO: { dir: ['up'] } } };
  ok('string values still require a quoted literal', findDataDomainRefGaps(cs, 'const up = 1;').length === 1
    && findDataDomainRefGaps(cs, "go('up')").length === 0);

  // OBJECT-valued entries: the code references LEAVES, never the object
  // verbatim — the old whole-object string check was a permanently
  // unsatisfiable false positive that burned repair iterations
  // (examples/polyrun-oms REPAIR-NOTE).
  const co = { dataDomain: { DONE: { childState: [{ shipState: 'delivered' }, { shipState: 'cancelledShipment' }] } } };
  ok('object domain entry with all leaves referenced is NOT a gap',
    findDataDomainRefGaps(co, "if (p.childState.shipState === 'delivered') {} else if (p.childState.shipState === 'cancelledShipment') {}").length === 0);
  const gaps = findDataDomainRefGaps(co, "if (p.childState.shipState === 'delivered') {}");
  ok('object domain entry with a MISSING leaf reports that leaf path',
    gaps.length === 1 && /childState\.shipState = "cancelledShipment"/.test(gaps[0]));
  const cn = { dataDomain: { SET: { opt: [{ mode: null }] } } };
  ok('null leaves carry no referenceable token and are not gaps',
    findDataDomainRefGaps(cn, 'const nothing = 0;').length === 0);
}

console.log("4b) v2 gate: a NAMED component (local-state acceptor binding) is dead at init and refused");
{
  const { validateV2Module } = await import('../scripts/polygen.mjs');
  const { loadSpec } = await import('../scripts/load-spec.mjs');
  const mkModule = (nameLine) => `
'use strict';
const { createInstance } = require('@cognitive-fab/sam-pattern');
const instance = createInstance({ strict: true, hasAsyncActions: false });
const INITIAL_STATE = { st: 'a' };
const { intents } = instance({
  initialState: { ...INITIAL_STATE },
  component: {
    ${nameLine}
    modelShape: { st: { type: 'string' } },
    actions: { GO: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] } },
    acceptors: { GO: (m) => (p, { reject, next }) => { if (m.st !== 'a') return reject('done'); next.st = 'b'; } },
  },
});
const getState = () => instance({}).getState();
const setState = (s) => { instance({}).setState(s); };
const init = () => { setState(INITIAL_STATE); };
module.exports = { instance, init, actions: { GO: (d = {}) => intents.GO(d) }, getState, setState };
`;
  const goodPath = join(TMP, 'gate-good.cjs');
  writeFileSync(goodPath, mkModule(''), 'utf-8');
  let goodOk = true;
  try { validateV2Module(loadSpec(goodPath)); } catch { goodOk = false; }
  ok('an anonymous component passes the dead-at-init gate', goodOk);

  const badPath = join(TMP, 'gate-named.cjs');
  writeFileSync(badPath, mkModule(`name: 'gate',`), 'utf-8');
  let badMsg = null;
  try { validateV2Module(loadSpec(badPath)); } catch (e) { badMsg = e.message; }
  ok('a NAMED component is refused as DEAD AT INIT with the name: diagnosis',
    badMsg !== null && /DEAD AT INIT/.test(badMsg) && /name:/.test(badMsg));
}

console.log('5) corpus synthesis hygiene: stale traces cleaned, scenario names sanitized');
{
  // Re-run into out2's traces dir with a hostile scenario name and a stale file.
  const contract5 = join(TMP, 'contract5.json');
  writeFileSync(contract5, JSON.stringify({
    stateKeys: ['state'], initState: { state: 'COLD' }, actions: { BUMP: { dataFields: {} } },
  }, null, 2), 'utf-8');
  const out5 = join(TMP, 'out5');
  mkdirSync(join(out5, 'traces'), { recursive: true });
  writeFileSync(join(out5, 'traces', 'stale.ndjson'),
    JSON.stringify({ pre: { state: 'OLD' }, action: 'BUMP', data: {}, post: { state: 'OLDER' } }) + '\n', 'utf-8');
  const stub5 = (stage) => {
    if (stage === 'author') return fence('javascript', M3);
    if (stage === 'invariants') return fence('javascript', 'export const stateInvariants = [{ name: "always", pred: () => true }];\nexport const transitionInvariants = [];\n');
    if (stage === 'scenarios') return fence('json', JSON.stringify({ '../escape/s1': [['BUMP', {}]] }));
    throw new Error(`unexpected stage: ${stage}`);
  };
  const r5 = await polygen({ intent: 'hygiene fixture', contractPath: contract5, out: out5, callImpl: stub5 });
  const traceFiles = (await import('node:fs')).readdirSync(join(out5, 'traces'));
  ok('stale .ndjson from a previous run is removed before synthesis', !traceFiles.includes('stale.ndjson'));
  ok('hostile scenario name is sanitized into tracesDir (no path escape, file readable back)',
    traceFiles.length === 1 && /^\.\._escape_s1\.ndjson$/.test(traceFiles[0]) && r5.replay.windows === 1);
  ok('the run is clean end-to-end (converged, no replay fails)', r5.converged === true && r5.replay.fails === 0);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} CHECKS PASSED`);
