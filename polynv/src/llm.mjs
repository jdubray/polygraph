// polynv harvest sources 5–6, headless (M1): frontier-model domain priors
// and LLM code-reading, via the pipeline's existing Anthropic call
// (scripts/generate.mjs callMessages — fetchImpl injectable for tests).
//
// In-session these sources need no API key (the interviewing model supplies
// them through `polynv add` — see the skill); this module is the HEADLESS
// path only. Everything it returns is a CANDIDATE: model-drafted predicates
// are labeled by source, pre-checked like every other candidate, and enter
// invariants.mjs only through the designer's attributed disposition —
// generation never holds acceptance (plan §1). Executing a model-drafted
// predicate in the pre-check is execution parity with the rest of the
// pipeline (LLM-generated spec modules run under check.mjs routinely).
'use strict';

import { callMessages, DEFAULT_MAX_TOKENS } from '../../scripts/generate.mjs';
import { compileJs } from './nf.mjs';

export function buildPrompt(contract, { moduleSource = null, intent = null } = {}) {
  const L = [];
  L.push('You are eliciting INVARIANT CANDIDATES for a state machine. Two independent tasks:');
  L.push('');
  L.push('1. DOMAIN PRIORS — from the vocabulary below, identify the application domain and enumerate the invariants CANONICAL to that domain (the rules any practitioner would expect), INDEPENDENT of what the code does. kind: "domain-prior"; include "domain" and "norm" fields.');
  L.push('2. CODE READING — from the contract' + (moduleSource ? ' and module source' : '') + ', propose invariants the implementation appears to intend. kind: "code-reading".');
  L.push('');
  L.push('Contract (JSON):');
  L.push(JSON.stringify(contract, null, 2));
  if (intent) { L.push(''); L.push('Feature intent (prose):'); L.push(intent); }
  if (moduleSource) { L.push(''); L.push('Module source:'); L.push('```'); L.push(moduleSource); L.push('```'); }
  L.push('');
  L.push('Reply with ONLY a JSON array (no prose, no fences). Each element:');
  L.push('{ "id": "prior:<kebab-slug>" or "llm:<kebab-slug>", "kind": "domain-prior"|"code-reading",');
  L.push('  "target": "state"|"transition",');
  L.push('  "question": "<the invariant, phrased as a closed question to the designer about THIS machine>",');
  L.push('  "js": "<predicate: (s) => ... for state, (pre, action, data, post) => ... for transition, over the contract stateKeys only>",');
  L.push('  "domain": "<domain>", "norm": "<the norm as you state it>" }');
  L.push('Rules: predicates must be pure, total, and reference only declared state keys / action names / data fields. 5-15 candidates. Do not restate the contract\'s own specialRules verbatim — they are already templated.');
  return L.join('\n');
}

/**
 * Parse the model's reply into candidate objects for the ledger. STRICT:
 * a malformed element is dropped WITH a note (never silently), a
 * non-parsing predicate is dropped with a note — the designer sees exactly
 * what the model proposed and what was rejected at the door.
 */
export function parseCandidates(text, { model, date }) {
  let arr;
  try {
    arr = JSON.parse(text.trim().replace(/^```(json)?\n?|```$/g, ''));
  } catch (e) {
    throw new Error(`model reply is not a JSON array: ${e && e.message}`);
  }
  if (!Array.isArray(arr)) throw new Error('model reply is not a JSON array');
  const candidates = [];
  const notes = [];
  for (const [i, c] of arr.entries()) {
    const where = `element ${i} (${c && c.id ? c.id : 'no id'})`;
    if (!c || typeof c !== 'object' || !c.id || !c.question || !c.js || !['state', 'transition'].includes(c.target)) {
      notes.push(`${where}: missing id/question/js/target — dropped`); continue;
    }
    if (!['domain-prior', 'code-reading'].includes(c.kind)) { notes.push(`${where}: unknown kind '${c.kind}' — dropped`); continue; }
    try { compileJs(c.js); } catch (e) { notes.push(`${where}: predicate rejected (${e.message}) — dropped`); continue; }
    candidates.push({
      id: c.id,
      source: c.kind === 'domain-prior' ? 'domain-prior' : 'llm-code-reading',
      target: c.target,
      nf: { kind: 'js', target: c.target, js: c.js },
      js: c.js,
      question: c.question,
      evidence: { from: c.kind === 'domain-prior' ? 'model domain knowledge' : 'model code reading', quote: c.norm ?? null },
      provenance: c.kind === 'domain-prior' ? { domain: c.domain ?? null, norm: c.norm ?? null, model, date } : { model, date },
    });
  }
  return { candidates, notes };
}

// maxTokens defaults to the pipeline's DEFAULT_MAX_TOKENS (32000), NOT a
// local number: reasoning models spend budget on a thinking block before any
// answer text, and a low ceiling aborts with zero output (review finding).
export async function harvestLlm({ contract, moduleSource, intent, model, apiKey, maxTokens = DEFAULT_MAX_TOKENS, fetchImpl }) {
  if (!apiKey) throw new Error('harvest --llm needs ANTHROPIC_API_KEY');
  if (!model) throw new Error('harvest --llm needs --model (no default)');
  const prompt = buildPrompt(contract, { moduleSource, intent });
  const r = await callMessages({ prompt, model, maxTokens, apiKey, fetchImpl });
  if (!r.ok) throw new Error(`model call failed: ${r.error}`);
  return parseCandidates(r.text, { model, date: new Date().toISOString() });
}
