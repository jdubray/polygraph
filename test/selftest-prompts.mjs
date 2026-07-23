// Self-test for the P3/P5 prompt layer and the polygen v2 stage helpers:
// the v2 audit prompt template, mode selection in build_prompt.mjs, the seven
// polygen builders (v2 default + --legacy-bare-next branch), the
// retry-on-unloadable transport, and the strict validate() gate.
// NO API calls; the model transport is mocked where needed.
//
// Run: node test/selftest-prompts.mjs   (also wired into `npm test`)
import { strict as assert } from 'node:assert';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from '../scripts/build_prompt.mjs';
import {
  DISCIPLINE_SENTENCE,
  buildContractDraftPrompt,
  buildAuthorPrompt,
  buildInvariantsPrompt,
  buildRepairPrompt,
  buildDomainGapRepairPrompt,
  buildScenariosPrompt,
  buildSyntaxFixPrompt,
} from '../scripts/polygen_prompts.mjs';
import { requestLoadableModule, validateV2Module } from '../scripts/polygen.mjs';
import { loadSpec } from '../scripts/load-spec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const EX = join(ROOT, 'examples', 'turnstile-v2');
const contract = JSON.parse(readFileSync(join(EX, 'contract.json'), 'utf-8'));
const TMP = join(HERE, '.tmp-prompts');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ok  ' + name);
  passed++;
}

// The tested discipline sentence, tolerant of line-wrap/indentation only.
const DISCIPLINE_RE = /Acceptors must guard against invalid proposals \(an action that the\s+implementation does not act on in the current state must be a no-op via\s+`reject\(reason\)`, NOT a throw\)/;
// The whole-key commit idiom for nested map states (2.1 next-state form: the
// write goes to the `next` draft, the RHS spreads the PRE-state).
const COMMIT_RE = /next\.<key> = \{ \.\.\.model\.<key>, \[k\]: updated \}/;
// The 2.1 frame rule: every accepted step assigns or names every shape key.
const FRAME_RE = /unchanged\('keyA', 'keyB'\)/;

console.log('1) P3 — v2 audit prompt (prompt_template_v2.txt via build_prompt.mjs)');
// A hostile source: contains placeholder-lookalike text and a $-pattern; both
// must survive byte-identical because {source_code} is substituted LAST with
// a function-form replacement.
const nastySource = [
  "// literal {model_shape} and {state_keys} and {intent_domains} live in this source",
  "const s = 'x'.replace(/x/, '$&!');",
  "module.exports = { s };",
].join('\n');
const v2Prompt = buildPrompt(contract, nastySource, { filePath: 'src/turnstile.js', lang: 'javascript' });
ok('default mode is sam: renders the v2 strict contract', /v2 strict|STRICT\s+PROFILE/i.test(v2Prompt));
ok('exports the v2 surface (no checkerIntents)',
  v2Prompt.includes('module.exports = { instance, init, actions, getState, setState };')
  && !v2Prompt.includes('checkerIntents'));
ok('modelShape rendered from the contract',
  /modelShape/.test(v2Prompt) && /state: \{ type: 'string' \}/.test(v2Prompt) && /coins: \{ type: 'number' \}/.test(v2Prompt));
ok('intent schemas rendered (empty payloads as {})', /COIN: \{\},/.test(v2Prompt) && /PUSH: \{\},/.test(v2Prompt));
ok('intent domains rendered (no-payload actions get [{}])', /COIN: \[\{\}\],/.test(v2Prompt) && /PUSH: \[\{\}\],/.test(v2Prompt));
ok('specialRules render as REQUIRED reject(reason) cases',
  v2Prompt.includes("reject('push-while-locked-is-noop')"));
ok('discipline sentence present verbatim', DISCIPLINE_RE.test(v2Prompt));
ok('whole-key next-draft commit guidance present (nested maps) + flat next writes',
  COMMIT_RE.test(v2Prompt) && /FLAT state key/.test(v2Prompt));
ok('2.1 frame rule taught (unchanged(...) on accepted paths, none on reject)',
  FRAME_RE.test(v2Prompt) && /rejected step[\s\S]{0,40}NO framing/i.test(v2Prompt));
ok('init() is setState(INITIAL_STATE) only — the clearError idiom never appears as code',
  /setState\(INITIAL_STATE\)/.test(v2Prompt) && !/\.clearError\(\)/.test(v2Prompt)
  && /const init = \(\) => \{ setState\(INITIAL_STATE\); \};/.test(v2Prompt));
ok('safe-accessor rule noted in the module skeleton (state-key shadowing, sam-lib #29)',
  /sam-lib #29/.test(v2Prompt) && v2Prompt.includes('getState() is the safe')
  && !/instance\(\{\}\)\.state\(\)[\s\S]*clearError/.test(v2Prompt.split('const init')[1] || ''));
ok('in-context example present (rocket launcher, v2 strict profile)',
  /Rocket Launcher/.test(v2Prompt) && /createInstance\(\{ strict: true, hasAsyncActions: false \}\)/.test(v2Prompt));
ok('{source_code} substituted last: hostile source survives byte-identical',
  v2Prompt.includes(nastySource));
ok('placeholder-lookalikes in the source were NOT re-substituted (exactly one occurrence each, from the source)',
  (v2Prompt.match(/\{model_shape\}/g) || []).length === 1
  && (v2Prompt.match(/\{state_keys\}/g) || []).length === 1
  && v2Prompt.includes("'$&!'"));
const benign = buildPrompt(contract, 'module.exports = {};', {});
ok('no unreplaced template placeholders remain',
  ['{lang}', '{fence}', '{file_path}', '{state_keys}', '{init_state}', '{action_alphabet}',
   '{model_shape}', '{intent_schemas}', '{intent_domains}', '{special_rules_rejections}', '{source_code}']
    .every((p) => !benign.includes(p)));
const legacyPrompt = buildPrompt(contract, nastySource, { mode: 'legacy' });
ok('mode legacy still renders the bare-next template',
  legacyPrompt.includes('module.exports = { init, next };') && !legacyPrompt.includes('modelShape'));
ok('mode legacy also keeps the source byte-identical', legacyPrompt.includes(nastySource));
// The v2 path must hard-fail on a data field without a dataDomain (the domain
// is also the exploration + transpilation set).
let domainGateThrew = null;
try {
  buildPrompt({ stateKeys: ['s'], initState: { s: 'a' }, actions: { GO: { dataFields: { to: 'string' } } } }, 'x', {});
} catch (e) { domainGateThrew = e.message; }
ok('v2 prompt build FAILS LOUDLY when a data field has no dataDomain',
  domainGateThrew !== null && /dataDomain/.test(domainGateThrew) && /GO/.test(domainGateThrew));

console.log('2) P5 — polygen builders (v2 default + legacy branch)');
const draft = buildContractDraftPrompt('a turnstile', { lang: 'javascript' });
ok('contract draft keeps the dataDomain-mandatory language',
  /dataDomain: EVERY data field/.test(draft) && /not\s+optional/.test(draft));
ok('contract draft states the double justification: exploration AND transpilation/manifest sets',
  /exploration/.test(draft) && /transpilation/.test(draft) && /manifest/.test(draft));
const author = buildAuthorPrompt(contract, 'a turnstile', { lang: 'javascript' });
ok('author (v2): exports the v2 surface', author.includes('module.exports = { instance, init, actions, getState, setState };'));
ok('author (v2): modelShape/schemas/domains rendered from the contract',
  /modelShape/.test(author) && /COIN: \{\},/.test(author) && /COIN: \[\{\}\],/.test(author));
ok('author (v2): discipline sentence present', DISCIPLINE_RE.test(author));
ok('author (v2): special rules as REQUIRED reject(reason) cases', author.includes("reject('push-while-locked-is-noop')"));
ok('author (v2): init is setState(INITIAL_STATE) only, safe accessor named',
  /setState\(INITIAL_STATE\)/.test(author) && /sam-lib #29/.test(author) && !/clearError idiom is required/.test(author));
ok('author (v2): whole-key next-draft commit guidance present', COMMIT_RE.test(author));
ok('author (v2): 2.1 frame rule taught', FRAME_RE.test(author));
const authorLegacy = buildAuthorPrompt(contract, 'a turnstile', { mode: 'legacy' });
ok('author (legacy): still the bare-next contract',
  authorLegacy.includes('module.exports = { init, next };') && !authorLegacy.includes('modelShape'));
const violation = { invariant: 'coins-never-negative', kind: 'state', detail: 'reachable state violates the rule', path: [{ action: null, data: null }, { action: 'COIN', data: {} }] };
const repair = buildRepairPrompt(contract, 'CODE', violation, {});
ok('repair (v2): discipline sentence + v2 exports + reject-anchored rules',
  DISCIPLINE_RE.test(repair) && repair.includes('module.exports = { instance, init, actions, getState, setState };')
  && repair.includes("reject('push-while-locked-is-noop')"));
ok('repair (v2): forbids weakening declarations', /do not change the declared modelShape, schemas, or\s+domains/.test(repair));
const repairTriaged = buildRepairPrompt(contract, 'CODE', violation, {
  triage: {
    nondeterministic: true,
    replay: [{ scenario: 's1.ndjson', index: 2, action: 'PUSH', status: 'fail', classification: 'unhandled' },
             { scenario: 's1.ndjson', index: 4, action: 'PUSH', status: 'fail', classification: 'rejected', rejectionReason: 'push-while-locked-is-noop' }],
  },
});
ok('repair (v2): determinism flag renders as a first-class section',
  /Determinism flag/.test(repairTriaged) && /nondeterministic/i.test(repairTriaged));
ok('repair (v2): sam-tv classifications (rejected/unhandled) render with reasons',
  /classified 'unhandled'/.test(repairTriaged) && /classified 'rejected'/.test(repairTriaged)
  && /"push-while-locked-is-noop"/.test(repairTriaged) && /'unhandled' means the acceptor neither acted nor rejected/.test(repairTriaged));
const repairLegacy = buildRepairPrompt(contract, 'CODE', violation, { mode: 'legacy' });
ok('repair (legacy): unchanged bare-next wording', repairLegacy.includes('module.exports = { init, next }') && !/Determinism flag/.test(repairLegacy));
const gapV2 = buildDomainGapRepairPrompt(contract, 'CODE', ['CHARGE.result = "err5xx" (…)'], {});
ok('domain-gap repair (v2): v2 exports + discipline', gapV2.includes('module.exports = { instance, init, actions, getState, setState }') && DISCIPLINE_RE.test(gapV2));
ok('domain-gap repair (legacy): bare-next exports', buildDomainGapRepairPrompt(contract, 'CODE', ['g'], { mode: 'legacy' }).includes('module.exports = { init, next }'));
const scen = buildScenariosPrompt(contract, 'CODE', {});
ok('scenarios (v2): no-ops described as observable reject(reason) windows and payloads pinned to dataDomain',
  /reject\(reason\)/.test(scen) && /dataDomain/.test(scen));
ok('invariants prompt (v2): predicates documented over the getState() snapshot',
  /getState\(\) snapshot/.test(buildInvariantsPrompt(contract, 'CODE', 'intent', {})));
ok('syntax-fix prompt unchanged shape (mechanical fix only)',
  /Fix ONLY the\s+syntax/.test(buildSyntaxFixPrompt('CODE', 'boom', {})));
ok('DISCIPLINE_SENTENCE export matches the tested wording', DISCIPLINE_RE.test(DISCIPLINE_SENTENCE));

console.log('3) P5 — retry-on-unloadable transport (requestLoadableModule, mocked call)');
const truncated = '```javascript\nmodule.exports = { init: () =>\n```';
const complete = "```javascript\nmodule.exports = { init: () => ({ n: 0 }), next: (s) => s };\n```";
{
  const calls = [];
  const fakeCall = async (stage, prompt) => { calls.push({ stage, prompt }); return calls.length === 1 ? truncated : complete; };
  const res = await requestLoadableModule({ label: 'author', prompt: 'BASE PROMPT', call: fakeCall, path: join(TMP, 'retry-ok.cjs') });
  ok('truncated first rewrite triggers exactly one retry', calls.length === 2 && res.retried === true);
  ok('retry re-issues the ORIGINAL prompt with the appended truncation line',
    calls[1].prompt.startsWith('BASE PROMPT')
    && /Your previous rewrite was truncated\/unloadable: /.test(calls[1].prompt)
    && calls[1].prompt.endsWith('Emit the COMPLETE module.'));
  ok('the retried module loads and is returned', typeof res.loaded.init === 'function' && res.loaded.init().n === 0);
  ok('loadable first attempt does not retry', (await requestLoadableModule({
    label: 'x', prompt: 'P', call: async () => complete, path: join(TMP, 'no-retry.cjs'),
  })).retried === false);
}
{
  let threw = null;
  try {
    await requestLoadableModule({ label: 'author', prompt: 'P', call: async () => truncated, path: join(TMP, 'retry-fail.cjs') });
  } catch (e) { threw = e.message; }
  ok('two unloadable rewrites throw loudly (stage-blocking, never scored)',
    threw !== null && /truncated\/unloadable after 2 attempt\(s\)/.test(threw));
}

console.log('4) P5 — strict validate() gate (validateV2Module)');
ok('the v2 reference spec passes the gate',
  validateV2Module(loadSpec(join(EX, 'specs', 'reference.js'))) !== null);
{
  let threw = null;
  try { validateV2Module({ init: () => ({}), next: (s) => s }); } catch (e) { threw = e.message; }
  ok('a legacy bare-next module is rejected, naming the flag',
    threw !== null && /v2 SAM surface/.test(threw) && /--legacy-bare-next/.test(threw));
}
{
  const failing = {
    instance: () => ({ validate: () => { throw new Error("SamValidationError: intent 'A' has no input domain"); } }),
    init: () => {}, actions: {}, getState: () => ({}), setState: () => {},
  };
  let threw = null;
  try { validateV2Module(failing); } catch (e) { threw = e.message; }
  ok('strict validate() failures propagate (stage-blocking)',
    threw !== null && /SamValidationError/.test(threw));
}
{
  // A NON-STRICT module's validate() RETURNS problems instead of throwing —
  // the gate must fail on the returned array too, or it's vacuous for any
  // module that disobeyed the prompt's `strict: true`.
  const nonStrict = {
    instance: () => ({ validate: () => ['no named intents registered', 'no modelShape declared'] }),
    init: () => {}, actions: {}, getState: () => ({}), setState: () => {},
  };
  let threw = null;
  try { validateV2Module(nonStrict); } catch (e) { threw = e.message; }
  ok('non-strict validate() problems (returned, not thrown) fail the gate',
    threw !== null && /NON-STRICT/.test(threw) && /no named intents/.test(threw));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\nALL ${passed} CHECKS PASSED`);
