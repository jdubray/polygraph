// polyvers snapshot corpus — the states a compatibility gate runs against.
//
// Three sources, in descending order of honesty (the report records which
// one was used — provenance is part of the verdict):
//   live      — a polyrun database via its config (M1; not wired in M0)
//   archive   — `polyrun archive` output, or plain ndjson/json state dumps
//   synthesized — BFS-reachable states of the OLD machine (weakest tier:
//                 it can only contain states the old model says are
//                 reachable, which is exactly the assumption a landmine
//                 violates; still far better than an empty corpus)
//
// Deterministic, no API key.
'use strict';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import samAdapter from '../../scripts/sam-adapter.cjs';
import { stable } from '../../scripts/load-spec.mjs';

const { isSamV2Module, makeSamAdapter, domainFromManifest } = samAdapter;

/** One corpus entry: { id, state, source }. */

function fromNdjsonFile(path) {
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim());
  const out = [];
  if (!lines.length) return out;
  const first = JSON.parse(lines[0]);
  if (first && first.archived) {
    // `polyrun archive` layout: line 0 is {archived: <instance row>} whose
    // .state is the final persisted snapshot; the rest is the journal.
    out.push({ id: `${path}#archived:${first.archived.instance_id ?? '?'}`, state: first.archived.state, source: 'archive' });
    // Journal post-states are additional real snapshots the machine held —
    // each was persisted at some seq, so each must survive the gate too.
    for (const line of lines.slice(1)) {
      const row = JSON.parse(line);
      if (row && row.post && row.step_kind !== 'rejected' && row.stepKind !== 'rejected') {
        out.push({ id: `${path}#seq:${row.seq ?? '?'}`, state: row.post, source: 'archive' });
      }
    }
  } else {
    // Plain ndjson: each line is a bare state object.
    lines.forEach((line, i) => out.push({ id: `${path}#${i}`, state: JSON.parse(line), source: 'archive' }));
  }
  return out;
}

/**
 * Load a snapshot corpus from a path: a directory of *.ndjson (archive
 * exports or state dumps), a single .ndjson, or a .json array of states.
 * Duplicate states (by stable()) are collapsed — the gates are pointwise,
 * so one representative per distinct state suffices and keeps reports short.
 */
export function loadCorpus(path) {
  const abs = resolve(path);
  const entries = [];
  if (statSync(abs).isDirectory()) {
    for (const f of readdirSync(abs).sort()) {
      if (f.endsWith('.ndjson')) entries.push(...fromNdjsonFile(join(abs, f)));
      else if (f.endsWith('.json')) {
        const arr = JSON.parse(readFileSync(join(abs, f), 'utf-8'));
        if (!Array.isArray(arr)) throw new Error(`${join(abs, f)}: a .json corpus file must be an array of states`);
        arr.forEach((state, i) => entries.push({ id: `${f}#${i}`, state, source: 'archive' }));
      }
    }
  } else if (abs.endsWith('.ndjson')) {
    entries.push(...fromNdjsonFile(abs));
  } else if (abs.endsWith('.json')) {
    const arr = JSON.parse(readFileSync(abs, 'utf-8'));
    if (!Array.isArray(arr)) throw new Error(`${abs}: a .json corpus file must be an array of states`);
    arr.forEach((state, i) => entries.push({ id: `${abs}#${i}`, state, source: 'archive' }));
  } else {
    throw new Error(`unsupported corpus path '${abs}' (expected a directory, .ndjson, or .json array)`);
  }
  return dedupe(entries);
}

/**
 * Synthesize a corpus: every BFS-reachable state of the OLD machine, driven
 * through the same sam-adapter + manifest-declared domain the model checker
 * uses. Labeled 'synthesized' so the report can say so.
 */
export function synthesizeCorpus(oldModule, { maxStates = 20000 } = {}) {
  if (!isSamV2Module(oldModule)) {
    throw new Error('synthesize: the old machine module does not export the v2 SAM surface { instance, init, actions, getState, setState }');
  }
  const mod = makeSamAdapter(oldModule);
  const { steps } = domainFromManifest(oldModule);
  if (!steps.length) throw new Error('synthesize: the old module\'s manifest() yields no explorable (action, data) steps — an empty corpus would pass every gate vacuously');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const init = mod.init();
  const seen = new Map([[stable(init), init]]);
  const queue = [init];
  let head = 0;
  let truncated = false;
  outer: while (head < queue.length) {
    const s = queue[head++];
    for (const { action, data } of steps) {
      const post = mod.next(clone(s), action, data);
      const key = stable(post);
      if (!seen.has(key)) {
        if (seen.size >= maxStates) { truncated = true; break outer; }
        seen.set(key, post);
        queue.push(post);
      }
    }
  }
  const entries = [...seen.values()].map((state, i) => ({ id: `synthesized#${i}`, state, source: 'synthesized' }));
  return { entries, truncated };
}

function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const k = stable(e.state);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
