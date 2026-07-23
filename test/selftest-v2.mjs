// Self-test for the v2 (SAM strict-profile) pipeline: contract renderers,
// sam-tv.mjs replay (incl. rejection triage), the checker's manifest-domain
// exploration through the {init,next} adapter, and the determinism
// double-pass. NO API calls; the vendored sam-lib bundle is the only SAM
// dependency exercised.
//
// Run: node test/selftest-v2.mjs   (also wired into `npm test`)
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderModelShape, renderIntentSchemas, renderIntentDomains, renderSpecialRulesAsRejections,
} from '../scripts/contract_render.mjs';
import { loadWindows, replaySpec, replaySpecResults } from '../scripts/replay.mjs';
import { loadSpec } from '../scripts/load-spec.mjs';
import { check } from '../scripts/check.mjs';
import { verify } from '../scripts/verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const EX = join(ROOT, 'examples', 'turnstile-v2');
const V2_SPEC = join(EX, 'specs', 'reference.js');
const contract = JSON.parse(readFileSync(join(EX, 'contract.json'), 'utf-8'));
const TMP = join(HERE, '.tmp-v2');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ok  ' + name);
  passed++;
}

// ── Fixture specs (written at runtime; loaded via the pipeline loader, so
//    require('@cognitive-fab/sam-pattern') resolves to the VENDORED bundle) ──

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

// Seeded bug: the third COIN jams the machine into the undeclared 'JACKPOT'
// control state — reachable only by ITERATION (every individual trace window
// still conforms), i.e. exactly what the checker exists to find.
const buggySpec = join(TMP, 'buggy-v2.js');
writeFileSync(buggySpec, `${V2_HEADER}
const INITIAL_STATE = { state: 'LOCKED', coins: 0 };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' }, coins: { type: 'number' } },
    actions: {
      COIN: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      PUSH: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
    },
    acceptors: {
      COIN: (model) => (p, { next }) => {
        next.state = model.coins >= 2 ? 'JACKPOT' : 'UNLOCKED'; // seeded bug
        next.coins = model.coins + 1;
      },
      PUSH: (model) => (p, { reject, next, unchanged }) => {
        if (model.state === 'LOCKED') return reject('push-while-locked-is-noop');
        next.state = 'LOCKED';
        unchanged('coins');
      },
    },
    reactors: [],
  },
});
${V2_FOOTER}`, 'utf-8');

// Nondeterministic spec: Math.random in an acceptor — the determinism
// double-pass must flag it.
const randomSpec = join(TMP, 'random-v2.js');
writeFileSync(randomSpec, `${V2_HEADER}
const INITIAL_STATE = { state: 'LOCKED', coins: 0 };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' }, coins: { type: 'number' } },
    actions: { COIN: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] } },
    acceptors: { COIN: (model) => (p, { next, unchanged }) => { next.coins = Math.random(); unchanged('state'); } },
    reactors: [],
  },
});
${V2_FOOTER}`, 'utf-8');

// Strict-schema spec: CHARGE requires a string 'result' — firing it without
// one must surface as a SamSchemaError window failure, not a protocol error.
const gatedSpec = join(TMP, 'gated-v2.js');
writeFileSync(gatedSpec, `${V2_HEADER}
const INITIAL_STATE = { txState: 'idle' };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { txState: { type: 'string' } },
    actions: {
      CHARGE: {
        action: (d = {}) => ({ ...d }),
        schema: { result: { type: 'string', required: true } },
        domain: [{ result: 'ok' }, { result: 'err5xx' }],
      },
    },
    acceptors: {
      CHARGE: (model) => (p, { next }) => { next.txState = p.result === 'ok' ? 'paid' : 'failed'; },
    },
    reactors: [],
  },
});
${V2_FOOTER}`, 'utf-8');

console.log('1) P1 — v2 contract renderers (derived from the EXISTING schema fields)');
const shape = renderModelShape(contract);
ok('modelShape: types inferred from initState', /state: \{ type: 'string' \}/.test(shape) && /coins: \{ type: 'number' \}/.test(shape));
const nullableShape = renderModelShape({ stateKeys: [{ name: 'holder', type: 'string or null' }], initState: { holder: null } });
ok('modelShape: null initState value renders nullable with note-derived type', /holder: \{ type: 'string', nullable: true \}/.test(nullableShape));
const schemas = renderIntentSchemas({
  actions: { COIN: { dataFields: {} }, CHARGE: { dataFields: { result: 'string', amount: 'number of cents' } } },
  dataDomain: { CHARGE: { result: ['ok', 'err5xx'], amount: [100, 250] } },
});
ok('intent schemas: empty payload renders {}', /COIN: \{\},/.test(schemas));
ok('intent schemas: types inferred from dataDomain values, required: true',
  /result: \{ type: 'string', required: true \}/.test(schemas) && /amount: \{ type: 'number', required: true \}/.test(schemas));
const domains = renderIntentDomains({
  actions: { COIN: { dataFields: {} }, CHARGE: { dataFields: { result: 'string', amount: 'number' } } },
  dataDomain: { CHARGE: { result: ['ok', 'err'], amount: [1, 2] } },
});
ok('intent domains: no-payload action gets [{}]', /COIN: \[\{\}\],/.test(domains));
ok('intent domains: cartesian product over declared fields (2x2 = 4 payloads)',
  (domains.match(/\{"result"/g) || []).length === 4);
let domainThrew = null;
try { renderIntentDomains({ actions: { CHARGE: { dataFields: { result: 'string' } } } }); }
catch (e) { domainThrew = e.message; }
ok('intent domains: action with data fields but no dataDomain FAILS LOUDLY',
  domainThrew !== null && /dataDomain/.test(domainThrew) && /CHARGE/.test(domainThrew));
const rejections = renderSpecialRulesAsRejections(contract);
ok('specialRules render as REQUIRED reject(reason) cases',
  /reject\('push-while-locked-is-noop'\)/.test(rejections) && /MUST/.test(rejections));
ok('legacy renderers untouched: no-rules fallback still demands reject()',
  /reject\(reason\)/.test(renderSpecialRulesAsRejections({})));

console.log('2) P2 — sam-tv.mjs replay of the v2 turnstile (positive control + rejection triage)');
const windows = loadWindows(join(EX, 'traces'));
const resp = replaySpecResults(V2_SPEC, windows, 'sam');
ok('v2 reference replays: protocol ok', resp.ok === true);
ok('v2 reference passes all 12 windows', resp.results.length === 12 && resp.results.every((r) => r.status === 'pass'));
const rejectedWindows = resp.results.filter((r) => r.classification === 'rejected');
const pushLockedCount = windows.filter((w) => w.action === 'PUSH' && w.pre.state === 'LOCKED').length;
ok('the PUSH-while-LOCKED no-ops classify as rejected (not unhandled)',
  rejectedWindows.length === pushLockedCount && pushLockedCount === 3);
ok('rejected windows carry the contract-anchored rejectionReason',
  rejectedWindows.every((r) => r.rejectionReason === 'push-while-locked-is-noop'));
ok('mutating windows classify as mutated',
  resp.results.filter((r) => r.classification === 'mutated').length === 12 - pushLockedCount);
ok('replaySpec (status projection) agrees', replaySpec(V2_SPEC, windows, 'sam').every((s) => s === 'pass'));

// A rejected window that CONTRADICTS the trace still fails — with the reason attached.
const badWindow = [{ scenario: 'x', index: 0, action: 'PUSH', data: {}, pre: { state: 'LOCKED', coins: 0 }, post: { state: 'LOCKED', coins: 5 } }];
const badResp = replaySpecResults(V2_SPEC, badWindow, 'sam');
ok('a rejection that disagrees with the trace is a FAIL carrying rejectionReason',
  badResp.results[0].status === 'fail' && badResp.results[0].classification === 'rejected'
  && badResp.results[0].rejectionReason === 'push-while-locked-is-noop');

// Strict-profile throw: missing required payload field -> window failure with the error NAME.
const gateResp = replaySpecResults(gatedSpec, [
  { action: 'CHARGE', data: {}, pre: { txState: 'idle' }, post: { txState: 'paid' } },
  { action: 'CHARGE', data: { result: 'ok' }, pre: { txState: 'idle' }, post: { txState: 'paid' } },
], 'sam');
ok('strict schema violation -> fail with the error name in the result',
  gateResp.ok === true && gateResp.results[0].status === 'fail' && /SamSchemaError/.test(gateResp.results[0].error));
ok('well-formed payload on the same spec passes', gateResp.results[1].status === 'pass');

// Mode mismatches are LOUD, never silently clean.
const legacyThroughSam = replaySpecResults(join(ROOT, 'examples', 'turnstile', 'specs', 'reference.js'), windows, 'sam');
ok('legacy bare-next spec through the sam replayer -> ok:false naming the fix',
  legacyThroughSam.ok === false && /legacy/.test(legacyThroughSam.error));
ok('v2 spec through the LEGACY replayer -> unscoreable (no next())',
  replaySpec(V2_SPEC, windows, 'legacy').every((s) => s === 'unscoreable'));

console.log('3) P4 — checker drives the v2 module via the adapter + manifest() domains');
const invariants = {
  stateInvariants: [
    { name: 'control-state-is-declared', pred: (s) => s.state === 'LOCKED' || s.state === 'UNLOCKED' },
    { name: 'coins-never-negative', pred: (s) => s.coins >= 0 },
  ],
};
const good = check({ specModule: loadSpec(V2_SPEC), contract, invariants, maxStates: 40 });
ok('v2 engine selected (adapter + manifest domains)', good.engine === 'sam-v2');
ok('exploration is real (multiple states from manifest domains)', good.statesExplored > 1);
ok('good v2 spec: no violations, deterministic', good.violations.length === 0 && good.nondeterministic === false);
ok('manifest supplies every domain (no skip notes)', (good.domainNotes || []).length === 0);
ok('frozen-field scan runs on the v2 engine (turnstile keys all vary — none frozen)',
  Array.isArray(good.frozenKeys) && good.frozenKeys.length === 0);

// mutate.mjs (M4) drives a v2 module through the same adapter + manifest
// alphabet: enumeration works, and the control classifies every mutation
// without crashing (adapter rejections replay as no-ops under projection).
{
  const { enumerateMutations: mutEnum, applyMutations: mutApply } = await import('../scripts/mutate.mjs');
  const v2Mut = mutEnum({ specModule: loadSpec(V2_SPEC), contract });
  ok('mutate: v2 spec enumerates operators over the manifest alphabet', v2Mut.mutants.length > 0);
  const v2Applied = mutApply({ specModule: loadSpec(V2_SPEC), contract, windows });
  ok('mutate: v2 control classifies every mutation (discriminated/equivalent/blind-spot)',
    v2Applied.reports.length === v2Mut.mutants.length
    && v2Applied.reports.every((r) => ['discriminated', 'equivalent', 'equivalent-bounded', 'blind-spot'].includes(r.status)));
}

const buggy = check({ specModule: loadSpec(buggySpec), contract, invariants, maxStates: 40 });
ok('seeded bug FOUND via manifest-domain exploration', buggy.ok === false
  && buggy.violations.some((v) => v.invariant === 'control-state-is-declared'));
const cx = buggy.violations.find((v) => v.invariant === 'control-state-is-declared');
ok('counterexample is the shortest path (init + 3x COIN)',
  cx.path.length === 4 && cx.path.slice(1).every((s) => s.action === 'COIN'));
ok('rejections explored as legal no-ops (PUSH@LOCKED did not throw)',
  !buggy.violations.some((v) => v.kind === 'throw'));

const legacyCheck = check({
  specModule: { init: () => ({ n: 0 }), next: (s, a) => (a === 'TICK' ? { n: s.n + 1 } : s) },
  contract: { stateKeys: ['n'], actions: { TICK: { dataFields: {} } } }, invariants: {}, maxStates: 5,
});
ok('legacy {init,next} module still uses the legacy engine + buildDomain', legacyCheck.engine === 'legacy');
const forcedLegacy = check({ specModule: loadSpec(V2_SPEC), contract, invariants, maxStates: 40, legacyBareNext: true });
ok('--legacy-bare-next forces the bare-next path even on a v2 module (loud error, no silent clean)',
  forcedLegacy.ok === false && /init\(\) and next\(\)/.test(forcedLegacy.error));

// Empty exploration domains are ERRORS, never vacuous passes.
const noIntentsSpec = join(TMP, 'no-intents-v2.js');
writeFileSync(noIntentsSpec, `${V2_HEADER}
const INITIAL_STATE = { state: 'LOCKED' };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: { modelShape: { state: { type: 'string' } }, actions: {}, acceptors: {}, reactors: [] },
});
${V2_FOOTER}`, 'utf-8');
const noIntents = check({ specModule: loadSpec(noIntentsSpec), contract, invariants, maxStates: 40 });
ok('v2 module with an empty intent registry is an ERROR, not a vacuous clean',
  noIntents.ok === false && typeof noIntents.error === 'string' && noIntents.violations.length === 0);
const emptyLegacy = check({
  specModule: { init: () => ({ n: 0 }), next: (s) => s },
  contract: { stateKeys: ['n'], actions: {} }, invariants: {}, maxStates: 5,
});
ok('legacy contract with zero explorable actions is an ERROR (empty domain)',
  emptyLegacy.ok === false && /exploration domain is empty/.test(emptyLegacy.error));
// A contract action the manifest doesn't know about must be VISIBLE.
const extraActionContract = { ...contract, actions: { ...contract.actions, MYSTERY: { dataFields: {} } } };
const diffed = check({ specModule: loadSpec(V2_SPEC), contract: extraActionContract, invariants, maxStates: 40 });
ok("contract action missing from manifest() surfaces as a NOT-explored note",
  (diffed.domainNotes || []).some((n) => /'MYSTERY' is not in the module's manifest/.test(n)));

// Adapter purity: next() must be a function of (state, action, data) ALONE.
// A module whose behavior depends on a hidden `internal` counter (merge-only
// setState leaves it behind) must NOT give history-dependent answers.
const hiddenSpec = join(TMP, 'hidden-v2.js');
writeFileSync(hiddenSpec, `${V2_HEADER}
const INITIAL_STATE = { state: 'COLD', hits: 0 };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' }, hits: { type: 'number', internal: true } },
    actions: { BUMP: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] } },
    acceptors: { BUMP: (model) => (p, { next }) => { next.hits = model.hits + 1; next.state = model.hits + 1 >= 2 ? 'HOT' : 'WARM'; } },
    reactors: [],
  },
});
${V2_FOOTER}`, 'utf-8');
{
  const samAdapter = (await import('../scripts/sam-adapter.cjs')).default;
  const adapted = samAdapter.makeSamAdapter(loadSpec(hiddenSpec));
  adapted.init();
  const first = adapted.next({ state: 'COLD' }, 'BUMP', {});
  const second = adapted.next({ state: 'COLD' }, 'BUMP', {});
  ok('adapter next() is pure: same input state gives the same output regardless of history',
    JSON.stringify(first) === JSON.stringify(second));
  ok('hidden internal state is canonically reset (init-value semantics, same as sam-tv per-window)',
    first.state === 'WARM');
}

// stable(): a dropped field (undefined) or NaN must never equal a trace null.
{
  const { stable } = await import('../scripts/load-spec.mjs');
  ok('stable: undefined ≠ null (a spec that drops a field must fail a null trace value)',
    stable(undefined) !== stable(null) && stable({ a: undefined }) !== stable({ a: null }));
  ok('stable: NaN/Infinity ≠ null', stable(NaN) !== stable(null) && stable(Infinity) !== stable(null) && stable(NaN) !== stable(Infinity));
  ok('stable: key order is still canonical', stable({ a: 1, b: 2 }) === stable({ b: 2, a: 1 }));
}

// Mutate-then-reject: a rejection that changed the model is a spec DEFECT —
// the checker must record it, not explore it as a legal identity no-op (which
// would contradict the replayer, which sees the mutation in getState()).
// Under 2.1 primes the top-level path is closed by construction (the frozen
// pre-state throws, and a next-draft write is discarded on reject), so the
// remaining defect path is a DEEP write through the shallow freeze — which
// the library reports with step.mutations EMPTY. This fixture keeps that
// loophole covered.
const mutateRejectSpec = join(TMP, 'mutate-reject-v2.js');
writeFileSync(mutateRejectSpec, `${V2_HEADER}
const INITIAL_STATE = { state: 'LOCKED', box: { coins: 0 } };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' }, box: { type: 'object' } },
    actions: { COIN: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] } },
    acceptors: { COIN: (model) => (p, { reject }) => { model.box.coins = model.box.coins + 1; return reject('nope'); } },
    reactors: [],
  },
});
${V2_FOOTER}`, 'utf-8');
const mutateReject = check({ specModule: loadSpec(mutateRejectSpec), contract, invariants: {}, maxStates: 10 });
ok('mutate-then-reject is a recorded violation, never a silent identity no-op',
  mutateReject.ok === false
  && mutateReject.violations.some((v) => v.kind === 'throw' && /mutated the observable model .* and then rejected/.test(v.detail)));

// ...and a next-draft write before rejecting IN THE SAME ACCEPTOR — the
// reason-logging idiom 2.1 silently discarded — is a hard SamFrameError under
// 2.2 (#36, motivated by the hatchet field study: 5/5 generations no-opped by
// annotating success with reject). The checker must surface the library's own
// error as a throw finding, never explore it as a legal no-op.
const internalRejectSpec = join(TMP, 'internal-reject-v2.js');
writeFileSync(internalRejectSpec, `${V2_HEADER}
const INITIAL_STATE = { state: 'LOCKED', coins: 0, lastReason: '' };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' }, coins: { type: 'number' }, lastReason: { type: 'string', internal: true } },
    actions: { COIN: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] } },
    acceptors: { COIN: (model) => (p, { reject, next }) => { next.lastReason = 'not-now'; return reject('not-now'); } },
    reactors: [],
  },
});
${V2_FOOTER}`, 'utf-8');
const internalReject = check({ specModule: loadSpec(internalRejectSpec), contract, invariants: {}, maxStates: 10 });
ok('write-then-reject in the same acceptor is a hard error under 2.2 (#36), surfaced as a throw finding',
  internalReject.violations.some((v) => v.kind === 'throw' && /reject\(\) after next-state writes/.test(v.detail)));

console.log('4) P4 — determinism double-pass');
const rand = check({ specModule: loadSpec(randomSpec), contract: {}, invariants: {}, maxStates: 30 });
ok('Math.random spec flagged nondeterministic', rand.nondeterministic === true);
ok("a first-class 'nondeterminism' finding is reported", rand.ok === false
  && rand.violations.some((v) => v.kind === 'nondeterminism' && v.invariant === 'deterministic-exploration'));

console.log('5) end-to-end — verify.mjs over the v2 example (replay-only, default sam mode)');
const e2e = await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: join(EX, 'specs'), out: join(TMP, 'out-v2') });
ok('verify (sam mode): 12/12 windows consistent', e2e.summary.consistent === 12 && e2e.summary.specs === 1);
ok('no dead specs', e2e.summary.deadSpecs.length === 0);

// CLI flag threading: --legacy-bare-next is a boolean flag selecting tv.mjs end-to-end.
const cli = spawnSync('node', [join(ROOT, 'scripts', 'verify.mjs'),
  '--contract', join(ROOT, 'examples', 'turnstile', 'contract.json'),
  '--traces', join(ROOT, 'examples', 'turnstile', 'traces'),
  '--specs', join(ROOT, 'examples', 'turnstile', 'specs'),
  '--legacy-bare-next',
  '--out', join(TMP, 'out-legacy-cli')], { encoding: 'utf-8' });
ok('CLI --legacy-bare-next replays the legacy example clean (12/12)',
  cli.status === 0 && /12\/12 windows consistent/.test(cli.stdout));

// CLI arg hardening: a value flag followed by another flag must be a loud
// usage error, not a silent `Number(true) === 1`.
const cliBadN = spawnSync('node', [join(ROOT, 'scripts', 'verify.mjs'),
  '--contract', join(EX, 'contract.json'), '--traces', join(EX, 'traces'),
  '--specs', join(EX, 'specs'), '--n', '--tla'], { encoding: 'utf-8' });
ok('CLI: value flag with flag-shaped value exits 2 (no silent --n=1)',
  cliBadN.status === 2 && /missing value for --n/.test(cliBadN.stderr));
const cliMix = spawnSync('node', [join(ROOT, 'scripts', 'verify.mjs'),
  '--contract', join(EX, 'contract.json'), '--traces', join(EX, 'traces'),
  '--specs', join(EX, 'specs'), '--model', 'sonnet-5'], { encoding: 'utf-8' });
ok('CLI: --specs plus generation flags is a loud error (stale specs cannot masquerade as regenerated)',
  cliMix.status === 1 && /cannot be combined/.test(cliMix.stderr));

console.log('6) reject-as-annotation trap (hatchet field study) — detected, named, and triaged');
// 5 of 5 generations computed the correct next.* writes and then appended
// reject(reason) as a success label. PRIMARY detection since sam-pattern
// 2.2.0 (#36): the library hard-fails the same-acceptor write-then-reject at
// step time with its own message. FALLBACK detection (kept for older-library
// specs and pure-reject variants): the trace signature — a spec that
// REJECTED a window whose trace shows the code ACTED.
{
  const trapDir = join(TMP, 'trap-specs');
  mkdirSync(trapDir, { recursive: true });
  writeFileSync(join(trapDir, 'spec_0.js'), `${V2_HEADER}
const INITIAL_STATE = { state: 'LOCKED', coins: 0 };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' }, coins: { type: 'number' } },
    actions: {
      COIN: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      PUSH: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
    },
    acceptors: {
      COIN: (model) => (p, { next, reject }) => {
        next.state = 'UNLOCKED';
        next.coins = model.coins + 1;
        return reject('coin-accepted'); // the trap: annotating a SUCCESS
      },
      PUSH: (model) => (p, { next, reject, unchanged }) => {
        if (model.state !== 'UNLOCKED') return reject('push-while-locked-is-noop');
        next.state = 'LOCKED';
        unchanged('coins');
        return reject('push-applied'); // the trap again
      },
    },
    reactors: [],
  },
});
${V2_FOOTER}`, 'utf-8');
  const trapRun = await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: trapDir, out: join(TMP, 'out-trap') });
  const trapJson = JSON.parse(readFileSync(join(TMP, 'out-trap', 'findings.json'), 'utf-8'));
  ok('2.2 (#36): write-then-reject fails LOUDLY at step time with the library\'s own message',
    trapRun.summary.consistent < 12
    && trapJson.perWindow.some((w) => w.verdict !== 'consistent'));
  // The library error text must reach the operator (per-window error in the
  // replay detail; surfaced through the failing windows rather than a silent
  // no-op that replays as a plausible spec).
  ok('the SamFrameError names the discarded writes and the misuse',
    /reject\(\) after next-state writes/.test(readFileSync(join(TMP, 'out-trap', 'findings.json'), 'utf-8')));

  // FALLBACK signature (pure reject, no writes — nothing for #36 to catch):
  // a spec that declines windows the code acted on still trips the
  // trace-signature detector.
  const pureDir = join(TMP, 'pure-reject-specs');
  mkdirSync(pureDir, { recursive: true });
  writeFileSync(join(pureDir, 'spec_0.js'), `${V2_HEADER}
const INITIAL_STATE = { state: 'LOCKED', coins: 0 };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' }, coins: { type: 'number' } },
    actions: {
      COIN: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      PUSH: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
    },
    acceptors: {
      COIN: (model) => (p, { reject }) => reject('coin-declined'),
      PUSH: (model) => (p, { next, reject, unchanged }) => {
        if (model.state !== 'UNLOCKED') return reject('push-while-locked-is-noop');
        next.state = 'LOCKED';
        unchanged('coins');
      },
    },
    reactors: [],
  },
});
${V2_FOOTER}`, 'utf-8');
  const pureRun = await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: pureDir, out: join(TMP, 'out-pure') });
  ok('fallback: pure reject on acted windows trips the trace-signature detector',
    pureRun.summary.rejectedActedWindows > 0
    && pureRun.findings.filter((f) => f.action === 'COIN').every((f) => f.rejectedButCodeActed === true));
  const pureMd = readFileSync(join(TMP, 'out-pure', 'findings.md'), 'utf-8');
  ok('findings.md names the reject-as-annotation trap with the triage hint',
    /REJECTED while the code ACTED/.test(pureMd) && /reject-as-annotation trap/.test(pureMd) && /trailing reject/.test(pureMd));
  // A clean run reports zero and stays quiet.
  ok('clean v2 run: no rejected-but-code-acted noise',
    e2e.summary.rejectedActedWindows === 0);

  // Projection basis: "the code ACTED" must use the replayer's own rule
  // (only keys present in the trace post count). In a delta-shaped corpus
  // whose post is a key SUBSET of pre, raw window inequality would flag a
  // correctly-rejected no-op as reject-as-annotation.
  const projDir = join(TMP, 'proj-traces');
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 's1.ndjson'),
    JSON.stringify({ pre: { state: 'LOCKED', coins: 0 }, action: 'PUSH', data: {}, post: { state: 'LOCKED' } }) + '\n', 'utf-8');
  const mixDir = join(TMP, 'proj-specs');
  mkdirSync(mixDir, { recursive: true });
  cpSync(join(EX, 'specs'), mixDir, { recursive: true }); // good spec: rejects PUSH@LOCKED (passes)
  writeFileSync(join(mixDir, 'zz_bad.js'), `${V2_HEADER}
const INITIAL_STATE = { state: 'LOCKED', coins: 0 };
const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: { state: { type: 'string' }, coins: { type: 'number' } },
    actions: {
      COIN: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
      PUSH: { action: (d = {}) => ({ ...d }), schema: {}, domain: [{}] },
    },
    acceptors: {
      COIN: (model) => (p, { next, unchanged }) => { next.state = 'UNLOCKED'; next.coins = model.coins + 1; },
      PUSH: (model) => (p, { next, unchanged }) => { next.state = 'UNLOCKED'; next.coins = model.coins; }, // wrongly transitions on the no-op
    },
    reactors: [],
  },
});
${V2_FOOTER}`, 'utf-8');
  const projRun = await verify({ contract: join(EX, 'contract.json'), traces: projDir, specs: mixDir, out: join(TMP, 'out-proj') });
  const projWindow = projRun.summary; // 1 window: good spec passes (rejected), bad spec fails -> spec-error
  ok('delta-shaped no-op window (post ⊂ pre, unchanged) does NOT flag reject-as-annotation',
    projWindow.specError === 1 && projWindow.rejectedActedWindows === 0);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} CHECKS PASSED`);
