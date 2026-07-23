// Self-test: proves the replay + classify + corpus-validation paths end to end
// on the turnstile example, WITHOUT calling the Anthropic API. The API path
// (generate.mjs) is exercised with a mocked fetch.
//
// Run: npm test   (node test/selftest.mjs)
import { strict as assert } from 'node:assert';
import { readFileSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCorpus } from '../scripts/validate_corpus.mjs';
import { loadWindows, replaySpec } from '../scripts/replay.mjs';
import { verify } from '../scripts/verify.mjs';
import { buildRequest, extractSpec, generateSpecs } from '../scripts/generate.mjs';
import { buildPrompt } from '../scripts/build_prompt.mjs';
import { resolveModel } from '../scripts/models.mjs';
import { check, buildDomain } from '../scripts/check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EX = join(HERE, '..', 'examples', 'turnstile');
const contract = JSON.parse(readFileSync(join(EX, 'contract.json'), 'utf-8'));
const TMP = join(HERE, '.tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ok  ' + name);
  passed++;
}

console.log('1) corpus validation');
const rep = validateCorpus(contract, join(EX, 'traces'));
ok('12 windows total', rep.total === 12);
ok('no chaining/terminal problems', rep.problems.length === 0);
ok('push-while-locked covered by 3 windows (no warning)', rep.ruleWindows['push-while-locked-is-noop'] === 3);
ok('no under-covered special rules', rep.underCovered.length === 0);

console.log('2) controls (positive + negative) via the replayer');
const windows = loadWindows(join(EX, 'traces'));
const refStatuses = replaySpec(join(EX, 'specs', 'reference.js'), windows, 'legacy');
ok('reference passes all 12 windows', refStatuses.every((s) => s === 'pass'));
const mutStatuses = replaySpec(join(EX, 'specs-mutant', 'mutant.js'), windows, 'legacy');
const failIdx = mutStatuses.map((s, i) => (s === 'fail' ? i : -1)).filter((i) => i >= 0);
ok('mutant fails exactly 3 windows', failIdx.length === 3);
ok('mutant failures are all PUSH-while-LOCKED no-ops',
  failIdx.every((i) => windows[i].action === 'PUSH' && windows[i].pre.state === 'LOCKED'));
ok('mutant passes the other 9 windows', mutStatuses.filter((s) => s === 'pass').length === 9);

console.log('3) verify.mjs --specs classification');
// (a) reference + mutant together: the 3 push windows are pass+fail -> spec-error.
const mixDir = join(TMP, 'mix');
mkdirSync(mixDir, { recursive: true });
cpSync(join(EX, 'specs', 'reference.js'), join(mixDir, 'spec_0.js'));
cpSync(join(EX, 'specs-mutant', 'mutant.js'), join(mixDir, 'spec_1.js'));
const mix = await verify({ legacyBareNext: true, contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: mixDir, out: join(TMP, 'out-mix') });
ok('mix: 9 consistent windows', mix.summary.consistent === 9);
ok('mix: 3 spec-error windows', mix.summary.specError === 3);
ok('mix: 0 code-finding windows', mix.summary.codeFinding === 0);

// (b) mutant alone: the 3 push windows all fail -> code-finding-or-contract.
const soloDir = join(TMP, 'solo');
mkdirSync(soloDir, { recursive: true });
cpSync(join(EX, 'specs-mutant', 'mutant.js'), join(soloDir, 'spec_0.js'));
const solo = await verify({ legacyBareNext: true, contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: soloDir, out: join(TMP, 'out-solo') });
ok('solo: 9 consistent windows', solo.summary.consistent === 9);
ok('solo: 3 code-finding windows', solo.summary.codeFinding === 3);
ok('findings.md written', readFileSync(join(TMP, 'out-solo', 'findings.md'), 'utf-8').includes('verification findings'));

console.log('4) prompt build (derivation mode — no per-state semantics leaked)');
// mode 'legacy' is explicit here: the DEFAULT prompt is now the v2 SAM strict
// profile (covered by test/selftest-prompts.mjs); this suite pins the
// --legacy-bare-next arm.
const prompt = buildPrompt(contract, readFileSync(join(EX, 'turnstile.js'), 'utf-8'), { filePath: 'turnstile.js', lang: 'javascript', mode: 'legacy' });
ok('prompt embeds the source', prompt.includes('class Turnstile'));
ok('prompt lists the state keys', prompt.includes('`state`') && prompt.includes('`coins`'));
ok('prompt lists the actions', prompt.includes("'COIN'") && prompt.includes("'PUSH'"));
ok('prompt states the no-op rule', /ignored action must\s+return the state unchanged/.test(prompt));
// Derivation mode: the TEMPLATE + contract rendering must not add per-state
// semantics (the source may legitimately describe its own behavior in comments;
// that is what the model derives from). Build with a neutral source and confirm
// no per-action behavior is described by our own scaffolding.
const neutralPrompt = buildPrompt(contract, '// (source omitted for this check)', { filePath: 'x.js', lang: 'javascript', mode: 'legacy' });
ok('template instructs derivation from source (not description)',
  /Model the observable single-step behavior of the real code\s+as implemented in the source above/.test(neutralPrompt));
ok('template adds no per-(state,action) transition table',
  !/\b(LOCKED|UNLOCKED)\b\s*->/.test(neutralPrompt));

console.log('5) generate.mjs request shape + mocked API');
const reqBody = buildRequest({ prompt: 'X', model: 'fable-5' });
ok('model alias resolved (fable-5 -> claude-fable-5)', reqBody.model === 'claude-fable-5');
ok('unknown model passed verbatim', resolveModel('some-exact-api-id').id === 'some-exact-api-id');
ok('documented recommended alias resolves (sonnet-5)', resolveModel('sonnet-5').resolved === true);
ok('prompt-cache control on the source turn', reqBody.messages[0].content[0].cache_control.type === 'ephemeral');
ok('extractSpec pulls the fenced block', extractSpec('```javascript\nmodule.exports={};\n```') === 'module.exports={};');

const mockFetch = async () => ({
  ok: true,
  json: async () => ({ content: [{ text: '```javascript\nmodule.exports = { init: () => ({}), next: (s) => s };\n```' }], usage: {} }),
});
const gens = await generateSpecs({ prompt: 'X', model: 'fable-5', n: 2, apiKey: 'test', fetchImpl: mockFetch });
ok('mocked generate returns 2 specs', gens.length === 2 && gens.every((g) => g.ok && g.spec.includes('next')));

// Default budget is generous enough for reasoning models' thinking + answer.
ok('default max_tokens is high enough for reasoning models', buildRequest({ prompt: 'X', model: 'sonnet-5' }).max_tokens >= 32000);
ok('--max-tokens override honored', buildRequest({ prompt: 'X', model: 'fable-5', maxTokens: 4096 }).max_tokens === 4096);

// Reasoning-model budget-exhaustion: empty answer + stop_reason max_tokens must
// FAIL LOUDLY with an actionable hint, not silently return an empty spec.
const truncatedFetch = async () => ({
  ok: true,
  json: async () => ({ content: [{ type: 'thinking', thinking: '...' }], stop_reason: 'max_tokens', usage: {} }),
});
const truncated = await generateSpecs({ prompt: 'X', model: 'sonnet-5', n: 1, apiKey: 'test', fetchImpl: truncatedFetch });
ok('empty reasoning-model response fails (not ok:true with empty spec)', truncated[0].ok === false);
ok('error names the max-tokens cause', /max-tokens/.test(truncated[0].error) && /max_tokens/.test(truncated[0].error));

console.log('6) SAM instrumentation (withSamTracing) — real @cognitive-fab/sam-pattern instance');
const { makeTurnstile } = await import('../examples/turnstile-sam/turnstile-sam.mjs');
const samDir = join(TMP, 'sam-traces');
mkdirSync(samDir, { recursive: true });
const ts = makeTurnstile(join(samDir, 's1.ndjson'));
await ts.coin();  // LOCKED   -> UNLOCKED (coins 1)
await ts.push();  // UNLOCKED -> LOCKED
await ts.push();  // LOCKED   -> LOCKED  (no-op)
await ts.coin();  // LOCKED   -> UNLOCKED (coins 2)
const samWindows = loadWindows(samDir);
ok('SAM: 4 windows captured', samWindows.length === 4);
ok('SAM: windows well-formed {pre,action,data,post}',
  samWindows.every((w) => w.pre && w.post && typeof w.action === 'string' && w.data));
ok('SAM: windows chain (post[k] == pre[k+1])',
  samWindows.slice(1).every((w, i) => JSON.stringify(w.pre) === JSON.stringify(samWindows[i].post)));
const samNoop = samWindows.find((w) => w.action === 'PUSH' && w.pre.state === 'LOCKED');
ok('SAM: PUSH-while-LOCKED no-op has post == pre',
  samNoop && JSON.stringify(samNoop.pre) === JSON.stringify(samNoop.post));
// The SAM-captured corpus is validated by the same controls path: the existing
// hand-written reference next() must score 100% on it.
ok('SAM: reference spec scores 100% on the SAM-captured corpus',
  replaySpec(join(EX, 'specs', 'reference.js'), samWindows, 'legacy').every((s) => s === 'pass'));

console.log('7) model checker (scripts/check.mjs) — iterate next() against invariants');
// A tiny counter machine with an off-by-one: it should lock at 3 but locks at 4,
// so it reaches the illegal state {active, n:3}. Model checking must FIND it.
const buggy = {
  init: () => ({ status: 'active', n: 0 }),
  next: (s, action) => {
    if (action === 'TICK' && s.status === 'active') { const n = s.n + 1; return n > 3 ? { status: 'locked', n } : { status: 'active', n }; }
    return { status: s.status, n: s.n };
  },
};
const counterContract = { stateKeys: ['status', 'n'], actions: { TICK: { dataFields: {} } } };
const inv = { stateInvariants: [{ name: 'locked-by-3', pred: (s) => !(s.status === 'active' && s.n >= 3) }] };
const buggyRes = check({ specModule: buggy, contract: counterContract, invariants: inv });
ok('checker FINDS the reachable violation a faithful spec hides', buggyRes.ok === false && buggyRes.violations.length === 1);
ok('checker returns a shortest counterexample path (init -> 3x TICK)',
  buggyRes.violations[0].path.length === 4 && buggyRes.violations[0].path.slice(1).every((s) => s.action === 'TICK'));

// The corrected machine (locks at 3) satisfies the invariant — no violation.
const fixed = { init: () => ({ status: 'active', n: 0 }), next: (s, a) => (a === 'TICK' && s.status === 'active') ? (s.n + 1 >= 3 ? { status: 'locked', n: s.n + 1 } : { status: 'active', n: s.n + 1 }) : { status: s.status, n: s.n } };
ok('checker passes a correct machine (no false alarm)', check({ specModule: fixed, contract: counterContract, invariants: inv }).ok === true);

// A next() that throws is itself a finding.
const thrower = { init: () => ({ x: 0 }), next: () => { throw new Error('boom'); } };
const throwRes = check({ specModule: thrower, contract: { stateKeys: ['x'], actions: { GO: { dataFields: {} } } }, invariants: {} });
ok('checker reports a throwing next() as a violation', throwRes.ok === false && /threw/.test(throwRes.violations[0].invariant));

// Domain inference from traces (no contract dataDomain).
const dom = buildDomain({ actions: { CHARGE: { dataFields: { result: 'string' } } } }, [{ action: 'CHARGE', data: { result: 'ok' } }, { action: 'CHARGE', data: { result: 'err5xx' } }]);
ok('checker infers a finite data domain from traces', dom.steps.length === 2 && dom.steps.some((s) => s.data.result === 'err5xx'));

console.log('8) code-review regression checks — no silent-clean paths');

// (8a) build_prompt: $-patterns and literal placeholders in SOURCE survive byte-identical.
const trickySource = `s.replace(/x/, '$&!'); const cost = '$$5'; // {state_keys} stays literal`;
const trickyPrompt = buildPrompt(contract, trickySource, { filePath: 'tricky.js', lang: 'javascript' });
ok('$& and $$ in source survive prompt embedding', trickyPrompt.includes(trickySource));
ok('literal {state_keys} in source is not rewritten',
  trickyPrompt.includes('// {state_keys} stays literal'));

// (8b) verify --specs: empty dir throws; .cjs specs are picked up.
const emptyDir = join(TMP, 'empty-specs');
mkdirSync(emptyDir, { recursive: true });
let threw = false;
try { await verify({ legacyBareNext: true, contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: emptyDir, out: join(TMP, 'out-empty') }); }
catch (e) { threw = /no specs found/.test(e.message); }
ok('--specs with zero matching files throws (no false clean)', threw);
const cjsDir = join(TMP, 'cjs-specs');
mkdirSync(cjsDir, { recursive: true });
cpSync(join(EX, 'specs', 'reference.js'), join(cjsDir, 'reference.cjs'));
const cjsRun = await verify({ legacyBareNext: true, contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: cjsDir, out: join(TMP, 'out-cjs') });
ok('.cjs reference spec is picked up and passes', cjsRun.summary.specs === 1 && cjsRun.summary.consistent === 12);

// (8c) stdout integrity: a spec that console.logs (top-level AND inside next())
// still replays pass — logging goes to stderr, protocol stays parseable.
const noisySpec = join(TMP, 'noisy.js');
const refBody = readFileSync(join(EX, 'specs', 'reference.js'), 'utf-8');
writeFileSync(noisySpec, `console.log('top-level noise');
${refBody}
const _refNext = module.exports.next;
module.exports.next = (s, a, d) => { console.log('runtime noise'); return _refNext(s, a, d); };
`, 'utf-8');
ok('spec with console.log replays pass (stdout protocol intact)',
  replaySpec(noisySpec, windows, 'legacy').every((s) => s === 'pass'));

// (8d) dead-spec partition: one dead spec among live ones no longer floods
// every window as spec-error; all-dead yields unscoreable-all, not consistent.
const deadMixDir = join(TMP, 'dead-mix');
mkdirSync(deadMixDir, { recursive: true });
cpSync(join(EX, 'specs', 'reference.js'), join(deadMixDir, 'spec_0.js'));
writeFileSync(join(deadMixDir, 'spec_1.js'), 'syntax error(', 'utf-8');
const deadMix = await verify({ legacyBareNext: true, contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: deadMixDir, out: join(TMP, 'out-deadmix') });
ok('dead spec excluded: windows classify from live specs only', deadMix.summary.consistent === 12 && deadMix.summary.specError === 0);
ok('dead spec is named in the summary', deadMix.summary.deadSpecs.length === 1 && deadMix.summary.deadSpecs[0] === 'spec_1.js');
const allDeadDir = join(TMP, 'all-dead');
mkdirSync(allDeadDir, { recursive: true });
writeFileSync(join(allDeadDir, 'spec_0.js'), 'syntax error(', 'utf-8');
const allDead = await verify({ legacyBareNext: true, contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: allDeadDir, out: join(TMP, 'out-alldead') });
ok('all specs dead -> unscoreable-all, never consistent', allDead.summary.unscoreableAll === 12 && allDead.summary.consistent === 0);

// (8e) invariant phase: a dead spec surfaces as an error and does NOT dilute
// strength; all-dead prints DID NOT RUN instead of a clean check.
const invFile = join(TMP, 'inv.mjs');
writeFileSync(invFile, `export const stateInvariants = [{ name: 'never-unlocked', pred: (s) => s.state !== 'UNLOCKED' }];\nexport const transitionInvariants = [];\n`, 'utf-8');
// (turnstile coins are unbounded, so bound exploration: capHit must PROPAGATE.)
const invMix = await verify({ legacyBareNext: true, contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: deadMixDir, out: join(TMP, 'out-invmix'), invariants: invFile, 'max-states': 50 });
ok('invariant strength counts only specs the checker ran (all-specs, not diluted)',
  invMix.invReport.violations.length === 1 && invMix.invReport.violations[0].strength === 'all-specs');
ok('checker-failure on a spec is surfaced as an error', invMix.invReport.errors.length === 1 && /spec_1\.js/.test(invMix.invReport.errors[0]));
ok('capHit propagates into invReport (bounded exploration is visible)', invMix.invReport.capHit === true);
ok('CAP HIT is rendered in findings.md',
  readFileSync(join(TMP, 'out-invmix', 'findings.md'), 'utf-8').includes('CAP HIT'));
const invDead = await verify({ legacyBareNext: true, contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: allDeadDir, out: join(TMP, 'out-invdead'), invariants: invFile, 'max-states': 50 });
ok('all specs dead -> model check reports DID NOT RUN',
  invDead.invReport.checkedSpecs === 0 && readFileSync(join(TMP, 'out-invdead', 'findings.md'), 'utf-8').includes('DID NOT RUN'));

// (8f) capHit is reported by check() when exploration is bounded.
const counter = { init: () => ({ n: 0 }), next: (s, a) => (a === 'TICK' ? { n: s.n + 1 } : s) };
const capRes = check({ specModule: counter, contract: { stateKeys: ['n'], actions: { TICK: { dataFields: {} } } }, invariants: {}, maxStates: 3 });
ok('check() reports capHit on bounded exploration', capRes.capHit === true);

// (8g) buildDomain accepts the `data:` alias exactly like build_prompt.
const aliasDom = buildDomain({ actions: { CHARGE: { data: { result: 'string' } } }, dataDomain: { CHARGE: { result: ['ok', 'err'] } } }, []);
ok('buildDomain reads data: alias (same accessor as the prompt)', aliasDom.steps.length === 2);
// ...and a skipped action is VISIBLE in the render, qualifying the clean line.
const skipped = check({ specModule: counter, contract: { stateKeys: ['n'], actions: { TICK: { dataFields: {} }, MYSTERY: { dataFields: { x: 'string' } } } }, invariants: {}, maxStates: 5 });
const { render: renderCheck } = await import('../scripts/check.mjs');
const skippedText = renderCheck(skipped);
ok('skipped action surfaces as a WARNING in check render', /WARNING: no domain for MYSTERY\.x/.test(skippedText));
ok('clean line is qualified when the alphabet was pruned', /EXPLORED alphabet/.test(skippedText));

// (8h) canonical deep-equality: nested-object state in a different key order
// is EQUAL (replay) — replay and checker share one state-equality definition.
const nestedTrace = join(TMP, 'nested');
mkdirSync(nestedTrace, { recursive: true });
writeFileSync(join(nestedTrace, 's1.ndjson'),
  JSON.stringify({ pre: { s: { a: 1, b: 2 } }, action: 'X', data: {}, post: { s: { a: 1, b: 2 } } }) + '\n', 'utf-8');
const nestedSpec = join(TMP, 'nested-spec.js');
writeFileSync(nestedSpec, `module.exports = { init: () => ({ s: { a: 1, b: 2 } }), next: (st) => ({ s: { b: st.s.b, a: st.s.a } }) };`, 'utf-8');
ok('nested-object state with reordered keys replays pass (canonical equality)',
  replaySpec(nestedSpec, loadWindows(nestedTrace), 'legacy').every((s) => s === 'pass'));

// (8i) guarded shared API call: HTTP errors and empty responses are failures,
// never parseable-as-clean text (the eval scores them unscoreable).
const { callMessages } = await import('../scripts/generate.mjs');
const http500 = await callMessages({ prompt: 'x', model: 'sonnet-5', apiKey: 't', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) });
ok('callMessages: HTTP error -> ok:false', http500.ok === false && /500/.test(http500.error));
const emptyResp = await callMessages({ prompt: 'x', model: 'sonnet-5', apiKey: 't', fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'max_tokens' }) }) });
ok('callMessages: empty/all-thinking response -> ok:false with hint', emptyResp.ok === false && /max_tokens/.test(emptyResp.error));
// PARTIAL text + stop_reason max_tokens is a truncated spec — it can be
// loadable-but-incomplete, so it must fail here, not replay as a live spec.
const partialResp = await callMessages({ prompt: 'x', model: 'sonnet-5', apiKey: 't', fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ text: '```javascript\nmodule.exports = { init: () => ({}) ' }], stop_reason: 'max_tokens' }) }) });
ok('callMessages: TRUNCATED response (partial text + max_tokens) -> ok:false', partialResp.ok === false && /truncated/.test(partialResp.error));

// (8j) canonical verdict vocabulary: classify is exported and zero specs is
// never 'consistent'.
const { classify: canonicalClassify } = await import('../scripts/verify.mjs');
ok('classify is exported (single verdict vocabulary)', typeof canonicalClassify === 'function');
ok('classify([]) is unscoreable-all, never consistent', canonicalClassify([]) === 'unscoreable-all');
ok('classify all-fail is code-finding-or-contract', canonicalClassify(['fail', 'fail']) === 'code-finding-or-contract');
ok('classify fail+unscoreable mix does NOT claim "all specs disagree" (weaker spec-error verdict)',
  canonicalClassify(['fail', 'unscoreable', 'unscoreable']) === 'spec-error');

// (8l is below 8k chronologically; kept adjacent to the SAM emitter tests' theme)
// Structured-state projection through withSamTracing: acceptors mutate the
// model IN PLACE, so a projection returning object/array values must be
// deep-snapshotted at capture time or every window silently reads pre == post.
{
  const SAMPattern = (await import('@cognitive-fab/sam-pattern')).default;
  const { withSamTracing } = await import('../scripts/instrument/sam-emitter.mjs');
  const structDir = join(TMP, 'struct-traces');
  mkdirSync(structDir, { recursive: true });
  const structFile = join(structDir, 's1.ndjson');
  const instance = SAMPattern.createInstance({ instanceName: 'cart', hasAsyncActions: false });
  const project = (m) => ({ items: m.items }); // OBJECT-VALUED observable key
  const component = {
    actions: [() => ({ __name: 'ADD' })],
    acceptors: [(model) => (proposal) => {
      if (proposal.__name === 'ADD') model.items.push('x'); // in-place mutation
    }],
    reactors: [],
  };
  const { intents: [add] } = instance({
    initialState: { items: [] },
    component: withSamTracing(component, project, structFile),
  });
  await add();
  const w = loadWindows(structDir)[0];
  ok('object-valued projection: pre is the PRE-mutation snapshot (not post aliased)',
    JSON.stringify(w.pre) === JSON.stringify({ items: [] })
    && JSON.stringify(w.post) === JSON.stringify({ items: ['x'] }));
}

// (8k) zero-window corpus: verify must throw, validateCorpus must report a
// problem — a run that examined nothing must never report a clean bill.
const emptyTraces = join(TMP, 'empty-traces');
mkdirSync(emptyTraces, { recursive: true });
let noWindowsThrew = false;
try { await verify({ legacyBareNext: true, contract: join(EX, 'contract.json'), traces: emptyTraces, specs: mixDir, out: join(TMP, 'out-nowin') }); }
catch (e) { noWindowsThrew = /no trace windows/.test(e.message); }
ok('verify with zero trace windows throws (no false clean)', noWindowsThrew);
const emptyRep = validateCorpus(contract, emptyTraces);
ok('validateCorpus flags a traces dir with no .ndjson files', emptyRep.problems.some((p) => /no \.ndjson files/.test(p)));
writeFileSync(join(emptyTraces, 'blank.ndjson'), '\n\n', 'utf-8');
const blankRep = validateCorpus(contract, emptyTraces);
ok('validateCorpus flags an all-blank corpus (zero windows)', blankRep.problems.some((p) => /zero windows/.test(p)));

// (8o) corpus window-shape validation + no vacuous empty-post passes.
{
  const shapeDir = join(TMP, 'shape-traces');
  mkdirSync(shapeDir, { recursive: true });
  writeFileSync(join(shapeDir, 's1.ndjson'), [
    JSON.stringify({ pre: { state: 'LOCKED', coins: 0 }, action: 'COIN', data: {}, post: {} }),          // empty post
    JSON.stringify({ pre: { status: 'LOCKED' }, action: 'COIN', data: {}, post: { state: 'UNLOCKED' } }), // renamed key in pre
    JSON.stringify({ pre: null, action: 'COIN', data: {}, post: { state: 'UNLOCKED', coins: 1 } }),       // malformed
  ].join('\n') + '\n', 'utf-8');
  const shapeRep = validateCorpus(contract, shapeDir);
  ok('empty post is a corpus problem (would replay vacuously)',
    shapeRep.problems.some((p) => /post is EMPTY/.test(p)));
  ok('a missing declared state key is a corpus problem',
    shapeRep.problems.some((p) => /missing declared state key 'state'/.test(p)));
  ok('a malformed window is a REPORTED problem, not a crash',
    shapeRep.problems.some((p) => /malformed window/.test(p)));
  // ...and the replayer refuses to score an empty-post window as a pass.
  const emptyPostWindows = [{ scenario: 'x', index: 0, action: 'COIN', data: {}, pre: { state: 'LOCKED', coins: 0 }, post: {} }];
  ok('replayer scores an empty-post window unscoreable, never pass',
    replaySpec(join(EX, 'specs', 'reference.js'), emptyPostWindows, 'legacy').every((s) => s === 'unscoreable'));
  // Key-order-scrambled chaining is NOT a chain break (canonical equality).
  const orderDir = join(TMP, 'order-traces');
  mkdirSync(orderDir, { recursive: true });
  writeFileSync(join(orderDir, 's1.ndjson'), [
    JSON.stringify({ pre: { state: 'LOCKED', coins: 0 }, action: 'COIN', data: {}, post: { state: 'UNLOCKED', coins: 1 } }),
    JSON.stringify({ pre: { coins: 1, state: 'UNLOCKED' }, action: 'PUSH', data: {}, post: { coins: 1, state: 'LOCKED' } }),
  ].join('\n') + '\n', 'utf-8');
  ok('key-order-scrambled post/pre chaining is not a false chain break',
    !validateCorpus({ ...contract, terminalStates: [] }, orderDir).problems.some((p) => /chain break/.test(p)));
}

// (8n) a spec that blocks forever must time out to unscoreable, not hang the
// pipeline. (Short override; restored right after.)
{
  const hangSpec = join(TMP, 'hang.js');
  writeFileSync(hangSpec, `module.exports = { init: () => ({}), next: () => { for (;;) {} } };`, 'utf-8');
  process.env.POLYGRAPH_REPLAY_TIMEOUT_MS = '1500';
  const started = Date.now();
  const hung = replaySpec(hangSpec, windows.slice(0, 1), 'legacy');
  delete process.env.POLYGRAPH_REPLAY_TIMEOUT_MS;
  ok('blocking spec times out to unscoreable (pipeline does not hang)',
    hung.every((s) => s === 'unscoreable') && Date.now() - started < 30000);
}

// (8m) generate.mjs CLI contract: bad flags exit 2; a run that writes zero
// specs exits 1 (never success). The bogus key makes every call fail fast.
{
  const { spawnSync } = await import('node:child_process');
  const promptFile = join(TMP, 'prompt.txt');
  writeFileSync(promptFile, 'X', 'utf-8');
  const GEN = join(HERE, '..', 'scripts', 'generate.mjs');
  const genEnv = { ...process.env, ANTHROPIC_API_KEY: 'bogus-key-for-test' };
  const badN = spawnSync('node', [GEN, '--prompt', promptFile, '--model', 'sonnet-5', '--n', 'abc'], { encoding: 'utf-8', env: genEnv });
  ok('generate CLI: non-numeric --n exits 2', badN.status === 2 && /positive integer/.test(badN.stderr));
  const flagAsValue = spawnSync('node', [GEN, '--prompt', promptFile, '--model', 'sonnet-5', '--n', '--out'], { encoding: 'utf-8', env: genEnv });
  ok('generate CLI: flag-shaped value exits 2 (no silent --n=1)', flagAsValue.status === 2 && /missing value for --n/.test(flagAsValue.stderr));
  const zeroOk = spawnSync('node', [GEN, '--prompt', promptFile, '--model', 'sonnet-5', '--n', '1', '--out', join(TMP, 'gen-out')],
    { encoding: 'utf-8', env: genEnv });
  ok('generate CLI: zero specs written exits 1 (never a success code)',
    zeroOk.status === 1 && /no specs were written/.test(zeroOk.stderr));
}

console.log('9) frozen-field warning — the checker announces its structural blind spot');
// A state key no action ever changes fixes exploration to its init() value:
// behavior gated on other values is structurally unreachable and the check
// passes vacuously over it (eval/FINDING-raft-field-study.md, startIndex).
{
  const gated = {
    init: () => ({ mode: 'a', cfg: 3, n: 0 }),
    next: (s, a) => (a === 'TICK' && s.n < s.cfg
      ? { mode: s.mode === 'a' ? 'b' : 'a', cfg: s.cfg, n: s.n + 1 }
      : { mode: s.mode, cfg: s.cfg, n: s.n }),
  };
  const gatedContract = { stateKeys: ['mode', 'cfg', 'n'], actions: { TICK: { dataFields: {} } } };
  const frozenRes = check({ specModule: gated, contract: gatedContract, invariants: {} });
  ok('frozen key detected (cfg never changes across the reachable graph)',
    (frozenRes.frozenKeys || []).some((f) => f.key === 'cfg' && f.value === 3));
  ok('varying keys are NOT reported frozen',
    !frozenRes.frozenKeys.some((f) => f.key === 'n' || f.key === 'mode'));
  ok('frozen key surfaces as a WARNING in check render',
    /WARNING: state key 'cfg' is frozen at 3/.test(renderCheck(frozenRes)));
  ok('machine where every key varies reports no frozen keys (no new noise)',
    check({ specModule: fixed, contract: counterContract, invariants: inv }).frozenKeys.length === 0);
  // The documented remedy clears the warning by construction: a seeded state
  // with a non-default value joins the reachable graph, so the key varies.
  const seededRes = check({ specModule: gated, contract: gatedContract, invariants: {}, initialStates: [{ mode: 'a', cfg: 5, n: 0 }] });
  ok('an --initial-states seed with a non-default value un-freezes the key',
    !(seededRes.frozenKeys || []).some((f) => f.key === 'cfg'));

  // End-to-end: the warning reaches findings.md through verify's invariant phase.
  const fzDir = join(TMP, 'frozen');
  mkdirSync(join(fzDir, 'specs'), { recursive: true });
  mkdirSync(join(fzDir, 'traces'), { recursive: true });
  writeFileSync(join(fzDir, 'specs', 'spec_0.js'),
    `module.exports = { init: () => ({ mode: 'a', cfg: 3 }), next: (s, a) => (a === 'FLIP' ? { mode: s.mode === 'a' ? 'b' : 'a', cfg: s.cfg } : { mode: s.mode, cfg: s.cfg }) };`, 'utf-8');
  writeFileSync(join(fzDir, 'contract.json'),
    JSON.stringify({ stateKeys: ['mode', 'cfg'], actions: { FLIP: { dataFields: {} } } }), 'utf-8');
  writeFileSync(join(fzDir, 'traces', 's1.ndjson'),
    JSON.stringify({ pre: { mode: 'a', cfg: 3 }, action: 'FLIP', data: {}, post: { mode: 'b', cfg: 3 } }) + '\n', 'utf-8');
  writeFileSync(join(fzDir, 'inv.mjs'), `export const stateInvariants = [{ name: 'mode-declared', pred: (s) => s.mode === 'a' || s.mode === 'b' }];\n`, 'utf-8');
  const fzRun = await verify({ legacyBareNext: true, contract: join(fzDir, 'contract.json'), traces: join(fzDir, 'traces'), specs: join(fzDir, 'specs'), invariants: join(fzDir, 'inv.mjs'), out: join(fzDir, 'out') });
  ok('invReport aggregates the frozen key at all-specs strength',
    fzRun.invReport.frozenKeys.length === 1 && fzRun.invReport.frozenKeys[0].key === 'cfg'
    && fzRun.invReport.frozenKeys[0].values.length === 1 && fzRun.invReport.frozenKeys[0].values[0] === 3
    && fzRun.invReport.frozenKeys[0].strength === 'all-specs');
  const fzMd = readFileSync(join(fzDir, 'out', 'findings.md'), 'utf-8');
  ok('FROZEN STATE KEY warning is rendered in findings.md', /FROZEN STATE KEY: `cfg` stays 3/.test(fzMd));
  ok('the clean invariant line is qualified by the frozen key', /frozen state key\(s\)/.test(fzMd));

  // The remedy findings.md prescribes must work in the SAME tool: --initial-states
  // threads into every per-spec check, and an unfreezing seed clears the warning.
  writeFileSync(join(fzDir, 'seeds.json'), JSON.stringify([{ mode: 'a', cfg: 5 }]), 'utf-8');
  const fzSeeded = await verify({ legacyBareNext: true, contract: join(fzDir, 'contract.json'), traces: join(fzDir, 'traces'), specs: join(fzDir, 'specs'), invariants: join(fzDir, 'inv.mjs'), 'initial-states': join(fzDir, 'seeds.json'), out: join(fzDir, 'out-seeded') });
  ok('verify --initial-states un-freezes the key (warning clears end-to-end)',
    fzSeeded.invReport.frozenKeys.length === 0);
  let seedThrew = false;
  try { await verify({ legacyBareNext: true, contract: join(fzDir, 'contract.json'), traces: join(fzDir, 'traces'), specs: join(fzDir, 'specs'), 'initial-states': join(fzDir, 'seeds.json'), out: join(fzDir, 'out-noinv') }); }
  catch (e) { seedThrew = /only affects the invariant model check/.test(e.message); }
  ok('--initial-states without an invariants module is a loud error, never silently ignored', seedThrew);

  // Specs that freeze the same key at DIFFERENT constants disagree on the
  // machine's configuration — the aggregate must not assert the first spec's
  // value for all of them.
  writeFileSync(join(fzDir, 'specs', 'spec_1.js'),
    `module.exports = { init: () => ({ mode: 'a', cfg: 7 }), next: (s, a) => (a === 'FLIP' ? { mode: s.mode === 'a' ? 'b' : 'a', cfg: s.cfg } : { mode: s.mode, cfg: s.cfg }) };`, 'utf-8');
  const fzSplit = await verify({ legacyBareNext: true, contract: join(fzDir, 'contract.json'), traces: join(fzDir, 'traces'), specs: join(fzDir, 'specs'), invariants: join(fzDir, 'inv.mjs'), out: join(fzDir, 'out-split') });
  const splitEntry = fzSplit.invReport.frozenKeys.find((f) => f.key === 'cfg');
  ok('differing frozen values are BOTH reported (no first-spec-wins)',
    splitEntry && splitEntry.values.length === 2 && splitEntry.values.includes(3) && splitEntry.values.includes(7));
  ok('the value disagreement is rendered as such in findings.md',
    /DIFFERING constants \(3, 7\)/.test(readFileSync(join(fzDir, 'out-split', 'findings.md'), 'utf-8')));

  // A spec that varies the key makes it a some-specs claim, not all-specs.
  writeFileSync(join(fzDir, 'specs', 'spec_1.js'),
    `module.exports = { init: () => ({ mode: 'a', cfg: 3 }), next: (s, a) => (a === 'FLIP' ? { mode: s.mode === 'a' ? 'b' : 'a', cfg: s.cfg + 1 } : { mode: s.mode, cfg: s.cfg }) };`, 'utf-8');
  const fzSome = await verify({ legacyBareNext: true, contract: join(fzDir, 'contract.json'), traces: join(fzDir, 'traces'), specs: join(fzDir, 'specs'), invariants: join(fzDir, 'inv.mjs'), 'max-states': 10, out: join(fzDir, 'out-some') });
  const someEntry = fzSome.invReport.frozenKeys.find((f) => f.key === 'cfg');
  ok('a key only some specs freeze reports some-specs strength',
    someEntry && someEntry.strength === 'some-specs' && someEntry.specs === 1);
  ok('the some-specs render names the spec disagreement',
    /the others vary it, a spec disagreement/.test(readFileSync(join(fzDir, 'out-some', 'findings.md'), 'utf-8')));
  ok('under CAP HIT the frozen claim is scoped to EXPLORED states, remedy is --max-states first',
    /every EXPLORED state \(exploration was bounded/.test(readFileSync(join(fzDir, 'out-some', 'findings.md'), 'utf-8')));

  // A next() that returns undefined (routine in LLM-generated legacy specs for
  // an unhandled action) must not crash the frozen scan — the spec's REAL
  // violations still report; the scan just declines the degenerate graph.
  const undefSpec = { init: () => ({ x: 0 }), next: (s, a) => (a === 'TICK' && s && s.x === 0 ? { x: 1 } : undefined) };
  const undefRes = check({ specModule: undefSpec, contract: { stateKeys: ['x'], actions: { TICK: { dataFields: {} } } }, invariants: { stateInvariants: [{ name: 'x-defined', pred: (s) => s && typeof s.x === 'number' }] } });
  ok('non-object states in the graph do not crash the frozen scan; violations still report',
    undefRes.ok === false && undefRes.violations.length > 0 && Array.isArray(undefRes.frozenKeys) && undefRes.frozenKeys.length === 0);
}

console.log('10) runaway-exploration guardrails — drift detection + heartbeat');
// An action that mints a fresh state forever (unbounded monotonic counter)
// turns the default cap into a silent multi-minute grind; the guardrail warns
// EARLY instead of guessing a universal bound.
{
  const runaway = { init: () => ({ phase: 'up', term: 0 }), next: (s, a) => (a === 'TICK' ? { phase: 'up', term: s.term + 1 } : { phase: s.phase, term: s.term }) };
  const runContract = { stateKeys: ['phase', 'term'], actions: { TICK: { dataFields: {} } } };
  const drifted = check({ specModule: runaway, contract: runContract, invariants: {}, maxStates: 600, driftThreshold: 256 });
  ok('unbounded key detected before the cap grinds',
    (drifted.driftWarnings || []).some((w) => /state key 'term' has \d+ distinct values/.test(w) && /likely unbounded/.test(w)));
  ok('the bounded key is not flagged as drifting', !drifted.driftWarnings.some((w) => /'phase'/.test(w)));
  ok('drift warning surfaces in check render', /WARNING: state key 'term'/.test(renderCheck(drifted)));
  ok('drift tracking stays deterministic (double-pass digest unaffected)', drifted.nondeterministic === false);
  ok('bounded machine emits no drift warnings (no new noise)',
    check({ specModule: fixed, contract: counterContract, invariants: inv }).driftWarnings.length === 0);

  // A COMPLETED exploration retracts any mid-run drift suspicion: an exhausted
  // frontier is definitive disproof of "still growing", so a large bounded
  // machine must never be called likely-unbounded in the result.
  const boundedBig = { init: () => ({ n: 0 }), next: (s, a) => (a === 'TICK' && s.n < 700 ? { n: s.n + 1 } : { n: s.n }) };
  const bigRes = check({ specModule: boundedBig, contract: { stateKeys: ['n'], actions: { TICK: { dataFields: {} } } }, invariants: {}, maxStates: 5000, driftThreshold: 256 });
  ok('bounded-but-large machine: completed exploration reports NO drift (mid-run suspicion retracted)',
    bigRes.capHit === false && bigRes.driftWarnings.length === 0);

  // Fleet-style seeds carrying a per-instance distinct key (polyvers seeds
  // every snapshot) must not inflate the detector: drift is about what
  // exploration MINTS, not what it was handed.
  const idle = { init: () => ({ phase: 'up', id: 0 }), next: (s) => ({ phase: s.phase, id: s.id }) };
  const fleetSeeds = Array.from({ length: 1200 }, (_, i) => ({ phase: 'up', id: i }));
  const seededDrift = check({ specModule: idle, contract: { stateKeys: ['phase', 'id'], actions: { TICK: { dataFields: {} } } }, invariants: {}, initialStates: fleetSeeds, driftThreshold: 256 });
  ok('seeded fleet snapshots do not trigger a false unbounded verdict',
    seededDrift.driftWarnings.length === 0);

  // Heartbeat: clock-driven and stderr-only; accelerate the clock via env and
  // intercept stderr so the test asserts presence without waiting 10s.
  process.env.POLYGRAPH_HEARTBEAT_MS = '0';
  const beats = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk) => { beats.push(String(chunk)); return true; };
  try {
    check({ specModule: runaway, contract: runContract, invariants: {}, maxStates: 600, driftThreshold: 100000 });
  } finally { process.stderr.write = origWrite; delete process.env.POLYGRAPH_HEARTBEAT_MS; }
  ok('heartbeat line reports states/frontier/elapsed on a long exploration',
    beats.some((b) => /\[check\] exploring \(pass 1\)… \d+ states discovered, frontier \d+/.test(b)));

  // End-to-end at the DEFAULT threshold: the warning reaches findings.md.
  const rwDir = join(TMP, 'runaway');
  mkdirSync(join(rwDir, 'specs'), { recursive: true });
  mkdirSync(join(rwDir, 'traces'), { recursive: true });
  writeFileSync(join(rwDir, 'specs', 'spec_0.js'),
    `module.exports = { init: () => ({ phase: 'up', term: 0 }), next: (s, a) => (a === 'TICK' ? { phase: 'up', term: s.term + 1 } : { phase: s.phase, term: s.term }) };`, 'utf-8');
  writeFileSync(join(rwDir, 'contract.json'),
    JSON.stringify({ stateKeys: ['phase', 'term'], actions: { TICK: { dataFields: {} } } }), 'utf-8');
  writeFileSync(join(rwDir, 'traces', 's1.ndjson'),
    JSON.stringify({ pre: { phase: 'up', term: 0 }, action: 'TICK', data: {}, post: { phase: 'up', term: 1 } }) + '\n', 'utf-8');
  writeFileSync(join(rwDir, 'inv.mjs'), `export const stateInvariants = [{ name: 'term-non-negative', pred: (s) => s.term >= 0 }];\n`, 'utf-8');
  const rwRun = await verify({ legacyBareNext: true, contract: join(rwDir, 'contract.json'), traces: join(rwDir, 'traces'), specs: join(rwDir, 'specs'), invariants: join(rwDir, 'inv.mjs'), 'max-states': '1500', out: join(rwDir, 'out') });
  ok('invReport carries the drift warning at the default threshold',
    rwRun.invReport.driftWarnings.length === 1 && /state key 'term'/.test(rwRun.invReport.driftWarnings[0]));
  ok('drift warning is rendered in findings.md',
    /likely unbounded in this key/.test(readFileSync(join(rwDir, 'out', 'findings.md'), 'utf-8')));
}

console.log('11) spec-vs-spec agreement — the vote structure is a first-class signal');
// A lopsided split among generated specs (raft: 4 of 5 made the IDENTICAL
// mistake, the dissenter was right) must surface without hand-diffing specs.
{
  const agDir = join(TMP, 'agreement');
  mkdirSync(join(agDir, 'specs'), { recursive: true });
  mkdirSync(join(agDir, 'traces'), { recursive: true });
  const goodSpec = `module.exports = { init: () => ({ mode: 'a' }), next: (s, a) => (a === 'FLIP' ? { mode: s.mode === 'a' ? 'b' : 'a' } : { mode: s.mode }) };`;
  writeFileSync(join(agDir, 'specs', 'spec_0.js'), goodSpec, 'utf-8');
  writeFileSync(join(agDir, 'specs', 'spec_1.js'), goodSpec, 'utf-8');
  writeFileSync(join(agDir, 'specs', 'spec_2.js'),
    `module.exports = { init: () => ({ mode: 'a' }), next: (s) => ({ mode: s.mode }) };`, 'utf-8'); // FLIP is a no-op: fails every window
  writeFileSync(join(agDir, 'contract.json'),
    JSON.stringify({ stateKeys: ['mode'], actions: { FLIP: { dataFields: {} } } }), 'utf-8');
  writeFileSync(join(agDir, 'traces', 's1.ndjson'), [
    JSON.stringify({ pre: { mode: 'a' }, action: 'FLIP', data: {}, post: { mode: 'b' } }),
    JSON.stringify({ pre: { mode: 'b' }, action: 'FLIP', data: {}, post: { mode: 'a' } }),
    JSON.stringify({ pre: { mode: 'a' }, action: 'FLIP', data: {}, post: { mode: 'b' } }),
  ].join('\n') + '\n', 'utf-8');
  const agRun = await verify({ legacyBareNext: true, contract: join(agDir, 'contract.json'), traces: join(agDir, 'traces'), specs: join(agDir, 'specs'), out: join(agDir, 'out') });
  // pairs: (0,1) agree 3/3, (0,2) 0/3, (1,2) 0/3 -> 3/9 = 33%
  ok('pairwise agreement computed over live specs', agRun.summary.agreement.pairwisePct === 33);
  ok('the outlier is named with its deviation count',
    agRun.summary.agreement.outliers.length === 1 && agRun.summary.agreement.outliers[0].spec === 'spec_2.js' && agRun.summary.agreement.outliers[0].deviations === 3);
  ok('per-window split names majority-vs-minority',
    agRun.findings.every((f) => f.split === '2-vs-1 (minority: spec_2.js)'));
  const agMd = readFileSync(join(agDir, 'out', 'findings.md'), 'utf-8');
  ok('consensus line rendered with the outlier warning',
    /spec agreement: pairwise \*\*33%\*\*/.test(agMd) && /3\/3 majority-bearing windows/.test(agMd) && /NOT automatically right/.test(agMd));
  ok('split column rendered in the findings table', /2-vs-1 \(minority: spec_2\.js\)/.test(agMd));

  // All-agree: a quiet consensus line, no outlier noise.
  rmSync(join(agDir, 'specs', 'spec_2.js'));
  const agClean = await verify({ legacyBareNext: true, contract: join(agDir, 'contract.json'), traces: join(agDir, 'traces'), specs: join(agDir, 'specs'), out: join(agDir, 'out-clean') });
  ok('all-agree run: pairwise 100%, no outliers', agClean.summary.agreement.pairwisePct === 100 && agClean.summary.agreement.outliers.length === 0);
  ok('all-agree consensus line is quiet',
    /all 2 live specs agree on every measured window/.test(readFileSync(join(agDir, 'out-clean', 'findings.md'), 'utf-8')));

  // EVEN SPLIT (1-vs-1): no strict majority exists, so there is no nameable
  // outlier — but 0% agreement must NEVER render as consensus (the quiet line
  // is gated on full agreement, not on "no outlier").
  writeFileSync(join(agDir, 'specs', 'spec_1.js'),
    `module.exports = { init: () => ({ mode: 'a' }), next: (s) => ({ mode: s.mode }) };`, 'utf-8');
  const agEven = await verify({ legacyBareNext: true, contract: join(agDir, 'contract.json'), traces: join(agDir, 'traces'), specs: join(agDir, 'specs'), out: join(agDir, 'out-even') });
  ok('even split: 0% pairwise, no-majority windows counted, no fake outlier',
    agEven.summary.agreement.pairwisePct === 0 && agEven.summary.agreement.noMajority === 3 && agEven.summary.agreement.outliers.length === 0);
  const evenMd = readFileSync(join(agDir, 'out-even', 'findings.md'), 'utf-8');
  ok('even split never renders as consensus',
    !/agree on every measured window/.test(evenMd) && /split with NO majority/.test(evenMd));

  // Windows unscoreable in EVERY live spec measured nothing — excluded from
  // the agreement denominator instead of inflating consensus.
  writeFileSync(join(agDir, 'specs', 'spec_1.js'), goodSpec, 'utf-8');
  writeFileSync(join(agDir, 'traces', 's2.ndjson'),
    JSON.stringify({ pre: { mode: 'a' }, action: 'FLIP', data: {}, post: {} }) + '\n', 'utf-8'); // empty post: unscoreable everywhere
  const agUnsc = await verify({ legacyBareNext: true, contract: join(agDir, 'contract.json'), traces: join(agDir, 'traces'), specs: join(agDir, 'specs'), out: join(agDir, 'out-unsc') });
  ok('unscoreable-everywhere window excluded from the agreement measure',
    agUnsc.summary.agreement.measuredWindows === 3 && agUnsc.summary.agreement.pairwisePct === 100
    && /unscoreable-everywhere window\(s\) excluded/.test(readFileSync(join(agDir, 'out-unsc', 'findings.md'), 'utf-8')));
  rmSync(join(agDir, 'traces', 's2.ndjson'));

  // A single live spec has no cross-spec signal — no agreement block, no crash.
  rmSync(join(agDir, 'specs', 'spec_1.js'));
  const agOne = await verify({ legacyBareNext: true, contract: join(agDir, 'contract.json'), traces: join(agDir, 'traces'), specs: join(agDir, 'specs'), out: join(agDir, 'out-one') });
  ok('single live spec: agreement is null (no fake 100%)', agOne.summary.agreement === null);
}

console.log('12) scripted negative control (scripts/mutate.mjs) — the control that proves the harness can fail');
{
  const { enumerateMutations, applyMutations, renderReports } = await import('../scripts/mutate.mjs');
  const { loadSpec: loadSpecFile } = await import('../scripts/check.mjs');
  const refSpec = loadSpecFile(join(EX, 'specs', 'reference.js'));
  const tsContract = JSON.parse(readFileSync(join(EX, 'contract.json'), 'utf-8'));
  const tsWindows = loadWindows(join(EX, 'traces'));
  const { mutants } = enumerateMutations({ specModule: refSpec, contract: tsContract, windows: tsWindows, legacyBareNext: true });
  ok('polynv operators enumerated with stable ids (guard-drop, retarget, widen, freeze)',
    ['drop:COIN@"LOCKED"', 'drop:PUSH@"UNLOCKED"', 'retarget:COIN@"UNLOCKED"->"LOCKED"', 'freeze:coins'].every((id) => mutants.some((m) => m.id === id)));

  // A targeted mutation reproduces the hand-made negative control: known
  // flipped windows, everything else untouched.
  const one = applyMutations({ specModule: refSpec, contract: tsContract, windows: tsWindows, legacyBareNext: true, id: 'drop:COIN@"LOCKED"' });
  ok('applied mutation reports the exact flipped windows',
    one.reports.length === 1 && one.reports[0].status === 'discriminated'
    && one.reports[0].originalPassed === 12 && one.reports[0].mutantPassed === 8 && one.reports[0].flipped.length === 4);
  ok('render names the discriminated rule', /the corpus discriminates this rule ✓/.test(renderReports(one)));

  // Equivalent-mutant discard: widening PUSH@LOCKED yields the same no-op the
  // original already performs — no corpus can distinguish it, so it must NOT
  // be reported as a corpus blind spot (that would demand an impossible
  // trace). Turnstile coins are unbounded, so the graphs are CAP-TRUNCATED —
  // the claim must therefore be the bounded one, not full equivalence
  // (digest equality over truncated prefixes proves nothing beyond the bound).
  const all = applyMutations({ specModule: refSpec, contract: tsContract, windows: tsWindows, legacyBareNext: true });
  const widen = all.reports.find((r) => r.id.startsWith('widen:PUSH'));
  ok('indistinguishable mutant over a truncated graph claims BOUNDED equivalence only',
    widen && widen.status === 'equivalent-bounded' && /NOT proof of equivalence/.test(renderReports(all)));
  ok('full corpus discriminates every distinguishable mutation (no blind spots)',
    all.reports.every((r) => r.status !== 'blind-spot'));

  // Scoring parity with the pipeline replayers: PROJECTION — a trace post
  // carrying only a subset of keys still passes a spec that returns more.
  const projWindows = [{ scenario: 'p', index: 0, action: 'COIN', data: {}, pre: { state: 'LOCKED', coins: 0 }, post: { state: 'UNLOCKED' } }];
  const proj = applyMutations({ specModule: refSpec, contract: tsContract, windows: projWindows, legacyBareNext: true, id: 'drop:COIN@"LOCKED"' });
  ok('projection rule: subset-key post scores pass on the original (parity with tv.mjs)',
    proj.reports[0].originalPassed === 1 && proj.reports[0].flipped.length === 1);

  // Step-3 doctrine enforced: an imperfect reference refuses the control
  // instead of laundering the mismatch into "blind spot" verdicts.
  const brokenRef = { init: refSpec.init, next: (s) => ({ state: s.state, coins: s.coins }) };
  let refused = false;
  try { applyMutations({ specModule: brokenRef, contract: tsContract, windows: tsWindows, legacyBareNext: true }); }
  catch (e) { refused = /positive control must be 100%/.test(e.message); }
  ok('imperfect reference refuses the negative control loudly', refused);

  // A thin corpus that never exercises a rule is a BLIND SPOT — the trace-side
  // twin of the M1 frozen-key warning, and the tool's headline result.
  const thin = applyMutations({ specModule: refSpec, contract: tsContract, windows: tsWindows.slice(0, 1), legacyBareNext: true, id: 'drop:PUSH@"UNLOCKED"' });
  ok('unexercised rule reports a corpus blind spot',
    thin.reports[0].status === 'blind-spot' && /ZERO windows flipped/.test(renderReports(thin)));

  // CLI exit contract: blind spot -> 1, all-discriminated-or-equivalent -> 0,
  // usage error -> 2.
  const { spawnSync } = await import('node:child_process');
  const MUT = join(HERE, '..', 'scripts', 'mutate.mjs');
  const cliOk = spawnSync('node', [MUT, '--spec', join(EX, 'specs', 'reference.js'), '--contract', join(EX, 'contract.json'), '--traces', join(EX, 'traces'), '--legacy-bare-next', '--all'], { encoding: 'utf-8' });
  ok('CLI --all exits 0 when the corpus discriminates every distinguishable rule', cliOk.status === 0);
  const thinDir = join(TMP, 'thin-traces');
  mkdirSync(thinDir, { recursive: true });
  writeFileSync(join(thinDir, 's1.ndjson'), JSON.stringify({ pre: { state: 'LOCKED', coins: 0 }, action: 'COIN', data: {}, post: { state: 'UNLOCKED', coins: 1 } }) + '\n', 'utf-8');
  const cliBlind = spawnSync('node', [MUT, '--spec', join(EX, 'specs', 'reference.js'), '--contract', join(EX, 'contract.json'), '--traces', thinDir, '--legacy-bare-next', '--all'], { encoding: 'utf-8' });
  ok('CLI --all exits 1 on a corpus blind spot (a control that cannot fail is a failed control)', cliBlind.status === 1);
  const cliUsage = spawnSync('node', [MUT, '--spec', 'x.js'], { encoding: 'utf-8' });
  ok('CLI usage error exits 2', cliUsage.status === 2 && /usage: mutate\.mjs/.test(cliUsage.stderr));
  const cliNaN = spawnSync('node', [MUT, '--spec', join(EX, 'specs', 'reference.js'), '--contract', join(EX, 'contract.json'), '--list', '--max-states', 'abc'], { encoding: 'utf-8' });
  ok('CLI non-numeric --max-states exits 2 (never a silent empty exploration)',
    cliNaN.status === 2 && /positive integer/.test(cliNaN.stderr));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} CHECKS PASSED`);
