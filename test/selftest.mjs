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
const refStatuses = replaySpec(join(EX, 'specs', 'reference.js'), windows);
ok('reference passes all 12 windows', refStatuses.every((s) => s === 'pass'));
const mutStatuses = replaySpec(join(EX, 'specs-mutant', 'mutant.js'), windows);
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
const mix = await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: mixDir, out: join(TMP, 'out-mix') });
ok('mix: 9 consistent windows', mix.summary.consistent === 9);
ok('mix: 3 spec-error windows', mix.summary.specError === 3);
ok('mix: 0 code-finding windows', mix.summary.codeFinding === 0);

// (b) mutant alone: the 3 push windows all fail -> code-finding-or-contract.
const soloDir = join(TMP, 'solo');
mkdirSync(soloDir, { recursive: true });
cpSync(join(EX, 'specs-mutant', 'mutant.js'), join(soloDir, 'spec_0.js'));
const solo = await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: soloDir, out: join(TMP, 'out-solo') });
ok('solo: 9 consistent windows', solo.summary.consistent === 9);
ok('solo: 3 code-finding windows', solo.summary.codeFinding === 3);
ok('findings.md written', readFileSync(join(TMP, 'out-solo', 'findings.md'), 'utf-8').includes('verification findings'));

console.log('4) prompt build (derivation mode — no per-state semantics leaked)');
const prompt = buildPrompt(contract, readFileSync(join(EX, 'turnstile.js'), 'utf-8'), { filePath: 'turnstile.js', lang: 'javascript' });
ok('prompt embeds the source', prompt.includes('class Turnstile'));
ok('prompt lists the state keys', prompt.includes('`state`') && prompt.includes('`coins`'));
ok('prompt lists the actions', prompt.includes("'COIN'") && prompt.includes("'PUSH'"));
ok('prompt states the no-op rule', /ignored action must\s+return the state unchanged/.test(prompt));
// Derivation mode: the TEMPLATE + contract rendering must not add per-state
// semantics (the source may legitimately describe its own behavior in comments;
// that is what the model derives from). Build with a neutral source and confirm
// no per-action behavior is described by our own scaffolding.
const neutralPrompt = buildPrompt(contract, '// (source omitted for this check)', { filePath: 'x.js', lang: 'javascript' });
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
  replaySpec(join(EX, 'specs', 'reference.js'), samWindows).every((s) => s === 'pass'));

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
try { await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: emptyDir, out: join(TMP, 'out-empty') }); }
catch (e) { threw = /no specs found/.test(e.message); }
ok('--specs with zero matching files throws (no false clean)', threw);
const cjsDir = join(TMP, 'cjs-specs');
mkdirSync(cjsDir, { recursive: true });
cpSync(join(EX, 'specs', 'reference.js'), join(cjsDir, 'reference.cjs'));
const cjsRun = await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: cjsDir, out: join(TMP, 'out-cjs') });
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
  replaySpec(noisySpec, windows).every((s) => s === 'pass'));

// (8d) dead-spec partition: one dead spec among live ones no longer floods
// every window as spec-error; all-dead yields unscoreable-all, not consistent.
const deadMixDir = join(TMP, 'dead-mix');
mkdirSync(deadMixDir, { recursive: true });
cpSync(join(EX, 'specs', 'reference.js'), join(deadMixDir, 'spec_0.js'));
writeFileSync(join(deadMixDir, 'spec_1.js'), 'syntax error(', 'utf-8');
const deadMix = await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: deadMixDir, out: join(TMP, 'out-deadmix') });
ok('dead spec excluded: windows classify from live specs only', deadMix.summary.consistent === 12 && deadMix.summary.specError === 0);
ok('dead spec is named in the summary', deadMix.summary.deadSpecs.length === 1 && deadMix.summary.deadSpecs[0] === 'spec_1.js');
const allDeadDir = join(TMP, 'all-dead');
mkdirSync(allDeadDir, { recursive: true });
writeFileSync(join(allDeadDir, 'spec_0.js'), 'syntax error(', 'utf-8');
const allDead = await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: allDeadDir, out: join(TMP, 'out-alldead') });
ok('all specs dead -> unscoreable-all, never consistent', allDead.summary.unscoreableAll === 12 && allDead.summary.consistent === 0);

// (8e) invariant phase: a dead spec surfaces as an error and does NOT dilute
// strength; all-dead prints DID NOT RUN instead of a clean check.
const invFile = join(TMP, 'inv.mjs');
writeFileSync(invFile, `export const stateInvariants = [{ name: 'never-unlocked', pred: (s) => s.state !== 'UNLOCKED' }];\nexport const transitionInvariants = [];\n`, 'utf-8');
// (turnstile coins are unbounded, so bound exploration: capHit must PROPAGATE.)
const invMix = await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: deadMixDir, out: join(TMP, 'out-invmix'), invariants: invFile, 'max-states': 50 });
ok('invariant strength counts only specs the checker ran (all-specs, not diluted)',
  invMix.invReport.violations.length === 1 && invMix.invReport.violations[0].strength === 'all-specs');
ok('checker-failure on a spec is surfaced as an error', invMix.invReport.errors.length === 1 && /spec_1\.js/.test(invMix.invReport.errors[0]));
ok('capHit propagates into invReport (bounded exploration is visible)', invMix.invReport.capHit === true);
ok('CAP HIT is rendered in findings.md',
  readFileSync(join(TMP, 'out-invmix', 'findings.md'), 'utf-8').includes('CAP HIT'));
const invDead = await verify({ contract: join(EX, 'contract.json'), traces: join(EX, 'traces'), specs: allDeadDir, out: join(TMP, 'out-invdead'), invariants: invFile, 'max-states': 50 });
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
  replaySpec(nestedSpec, loadWindows(nestedTrace)).every((s) => s === 'pass'));

// (8i) guarded shared API call: HTTP errors and empty responses are failures,
// never parseable-as-clean text (the eval scores them unscoreable).
const { callMessages } = await import('../scripts/generate.mjs');
const http500 = await callMessages({ prompt: 'x', model: 'sonnet-5', apiKey: 't', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) });
ok('callMessages: HTTP error -> ok:false', http500.ok === false && /500/.test(http500.error));
const emptyResp = await callMessages({ prompt: 'x', model: 'sonnet-5', apiKey: 't', fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'max_tokens' }) }) });
ok('callMessages: empty/all-thinking response -> ok:false with hint', emptyResp.ok === false && /max_tokens/.test(emptyResp.error));

// (8j) canonical verdict vocabulary: classify is exported and zero specs is
// never 'consistent'.
const { classify: canonicalClassify } = await import('../scripts/verify.mjs');
ok('classify is exported (single verdict vocabulary)', typeof canonicalClassify === 'function');
ok('classify([]) is unscoreable-all, never consistent', canonicalClassify([]) === 'unscoreable-all');
ok('classify all-fail is code-finding-or-contract', canonicalClassify(['fail', 'fail']) === 'code-finding-or-contract');

rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} CHECKS PASSED`);
