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
ok('unknown model passed verbatim', resolveModel('sonnet-4.8').id === 'sonnet-4.8');
ok('prompt-cache control on the source turn', reqBody.messages[0].content[0].cache_control.type === 'ephemeral');
ok('extractSpec pulls the fenced block', extractSpec('```javascript\nmodule.exports={};\n```') === 'module.exports={};');

const mockFetch = async () => ({
  ok: true,
  json: async () => ({ content: [{ text: '```javascript\nmodule.exports = { init: () => ({}), next: (s) => s };\n```' }], usage: {} }),
});
const gens = await generateSpecs({ prompt: 'X', model: 'fable-5', n: 2, apiKey: 'test', fetchImpl: mockFetch });
ok('mocked generate returns 2 specs', gens.length === 2 && gens.every((g) => g.ok && g.spec.includes('next')));

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

rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} CHECKS PASSED`);
