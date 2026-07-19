// SysMoBench etcd — map the library's event stream into replay windows.
//
//   node map-traces.mjs [--in traces/etcd.ndjson] [--out corpus]
//
// The harness records what etcd Raft's own tracing facility emits: one event
// per state-machine transition, on one node, carrying that node's observable
// state. Polygraph replays (pre, action, post) windows over the WHOLE fleet.
// This file is the join between them, and it is the part of the pipeline where
// judgment enters, so the judgment is written down rather than buried.
//
// WINDOW BOUNDARIES, AND WHY NOT ONE EVENT PER WINDOW. A single logical action
// produces a BURST of events on one node, and the state carried by an event is
// the state at the moment its trace call fires — which can precede that same
// action's own effects. Concretely, from a captured trace:
//
//     49 n1 Replicate                 log=3
//     50 n1 SendAppendEntriesResponse log=4      <- the append lands here
//     54 n1 Ready                     log=4
//
// Treating event 49 as a complete window would record a ClientProposal that
// left the log unchanged, and the spec would be marked non-conforming for
// correctly appending. So a window opens at a TRIGGER event and closes when
// that node's burst ends: at the next trigger, or when another node acts.
//
// UNMAPPED EVENTS STILL MOVE STATE. Ready, Commit, BecomeFollower,
// BecomeLeader, ApplyConfChange and the Send* family are not actions in the
// contract, but they do change what a node observably is. They are applied to
// the fleet exactly like triggers. Within a burst that attributes their effect
// to the action that caused them, which is correct; between bursts it means a
// window's `pre` already carries the drift, which is also correct — no action
// is then blamed for it.
//
// CHAIN INTEGRITY IS THE SELF-CHECK. Windows are emitted over one shared fleet
// state in sequence, so post(n) must equal pre(n+1). scripts/validate_corpus.mjs
// checks exactly that, and a chain break means THIS FILE is wrong, not the spec.
'use strict';

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) { console.error(`--${n} needs a value`); process.exit(2); }
  return v;
};
const IN = resolve(flag('in', join(here, 'traces', 'etcd.ndjson')));
const OUT = resolve(flag('out', join(here, 'corpus')));

// The library reports roles as StateFollower / StateCandidate / StateLeader /
// StatePreCandidate. The contract's vocabulary is lowercase and has no
// pre-candidate. An UNKNOWN role must fail loudly: silently passing a role the
// contract never declared through to the corpus would make every downstream
// comparison meaningless.
const ROLE = {
  StateFollower: 'follower',
  StateCandidate: 'candidate',
  StateLeader: 'leader',
  StatePreCandidate: 'preCandidate',
};

/**
 * Trigger events, and the contract action each stands for.
 *
 * `ReceiveAppendEntriesRequest` is deliberately NOT a single mapping. The
 * library funnels MsgApp, MsgHeartbeat and MsgSnap into that one event name
 * (see traceReceiveMessage), so the contract's HandleAppendEntries and
 * HandleHeartbeat are distinguished ONLY by msg.type. Getting this wrong
 * produces a corpus that looks healthy while testing the wrong transitions.
 */
function triggerFor(e) {
  switch (e.name) {
    case 'BecomeCandidate':
      return { action: 'ElectionTimeout', data: { node: e.nid } };
    case 'Replicate':
      return { action: 'ClientProposal', data: { node: e.nid } };
    case 'ReceiveRequestVoteRequest':
      return { action: 'HandleVoteRequest', data: {
        node: e.nid, from: e.msg.from, term: e.msg.term,
        logTerm: e.msg.logTerm, index: e.msg.index } };
    case 'ReceiveAppendEntriesRequest':
      if (e.msg?.type === 'MsgHeartbeat') {
        return { action: 'HandleHeartbeat', data: {
          node: e.nid, from: e.msg.from, term: e.msg.term, commit: e.msg.commit } };
      }
      if (e.msg?.type === 'MsgApp') {
        return { action: 'HandleAppendEntries', data: {
          node: e.nid, from: e.msg.from, term: e.msg.term, logTerm: e.msg.logTerm,
          index: e.msg.index, entries: e.msg.entries, commit: e.msg.commit } };
      }
      // MsgSnap shares the event name but is outside the declared action set.
      return null;
    default:
      return null;
  }
}

const events = readFileSync(IN, 'utf-8').trim().split('\n')
  .filter(Boolean).map((l) => JSON.parse(l))
  .sort((a, b) => a.seq - b.seq);
if (!events.length) { console.error(`no events in ${IN}`); process.exit(2); }

const ids = [...new Set(events.map((e) => e.nid))].sort();
const fleet = Object.fromEntries(ids.map((id) => [id,
  { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 }]));

/** The observable node state an event reports. Pure — mutates nothing. */
function stateFromEvent(e) {
  const role = ROLE[e.role];
  if (!role) { console.error(`unknown role '${e.role}' at seq ${e.seq} — refusing to guess`); process.exit(1); }
  return { role, term: e.state.term, vote: String(e.state.vote), commit: e.state.commit, log: e.log };
}
function applyEvent(e) { fleet[e.nid] = stateFromEvent(e); }
const snapshot = () => ({ nodes: JSON.parse(JSON.stringify(fleet)) });

/**
 * The state node `nid` reaches once the burst starting at index `i` completes.
 *
 * A burst ends at that NODE'S OWN `Ready`, which is Raft's own batch boundary:
 * the point at which the node has finished processing and hands back the state
 * to persist. Crucially the scan SKIPS OVER other nodes' events, because the
 * trace interleaves nodes and a burst is not contiguous.
 *
 * An earlier version closed the burst at the first event belonging to a
 * different node, and it was wrong in a way worth recording. Node 3's vote
 * burst was events 42, 43, 44 and 46 — with node 2's Ready at 45 sitting in the
 * middle. Closing at 45 dropped event 46, the Ready carrying the persisted
 * `vote=1`, so the window recorded a HandleVoteRequest that granted no vote and
 * the vote reappeared later as unexplained drift. The spec would have been
 * marked non-conforming for correctly recording a vote.
 */
function burstEnd(i, nid) {
  let last = events[i];
  for (let j = i + 1; j < events.length; j++) {
    if (events[j].nid !== nid) continue;      // another node's event: not ours
    if (triggerFor(events[j])) break;          // this node's next action
    last = events[j];
    if (events[j].name === 'Ready') break;     // batch boundary
  }
  return last;
}

const windows = [];
const skipped = {};
for (let i = 0; i < events.length; i++) {
  const e = events[i];
  const t = triggerFor(e);
  if (!t) { applyEvent(e); skipped[e.name] = (skipped[e.name] ?? 0) + 1; continue; }

  // SINGLE-NODE-STEP. The spec under test is, by its own header, an
  // "etcd/raft single-node-step model": one action changes one node. So a
  // window's post differs from its pre in EXACTLY the acting node. Other
  // nodes are genuinely moving concurrently, and their movement is honestly
  // recorded — in the `pre` of the later windows where it becomes visible,
  // never smuggled into this action's post as though this action caused it.
  //
  // `post` is DERIVED from the burst-end event and never written back into
  // `fleet`, which advances strictly in stream order. Doing it the other way
  // round — stamping the burst-end state into the fleet at window creation —
  // let the main loop then re-apply that burst's own intermediate events and
  // REWIND the node: node 2's granted vote read back as `vote: "1"` in one
  // window's post and `vote: "0"` in the next window's pre, a vote un-granting
  // itself, which Raft cannot do. A corpus is ground truth or it is nothing,
  // so the ordering has to be exact.
  const pre = snapshot();
  const post = JSON.parse(JSON.stringify(pre));
  post.nodes[e.nid] = stateFromEvent(burstEnd(i, e.nid));
  windows.push({ pre, action: t.action, data: t.data, post });
  applyEvent(e);
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'etcd_raft_3node.ndjson'), windows.map((w) => JSON.stringify(w)).join('\n') + '\n');

const byAction = windows.reduce((a, w) => ({ ...a, [w.action]: (a[w.action] ?? 0) + 1 }), {});
console.log(`${events.length} events -> ${windows.length} windows`);
console.log('\nwindows by action:');
for (const [k, v] of Object.entries(byAction).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);
const declared = ['ElectionTimeout', 'HandleVoteRequest', 'ClientProposal', 'HandleAppendEntries', 'HandleHeartbeat'];
const missing = declared.filter((a) => !byAction[a]);
console.log(`\ndeclared actions with NO window: ${missing.length ? missing.join(', ') : '(none)'}`);
console.log('\nnon-trigger events absorbed into bursts:');
for (const [k, v] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(30)} ${v}`);
if (missing.length) {
  console.error('\nFAILED: a declared action has no window — the corpus cannot exercise it');
  process.exitCode = 1;
}
