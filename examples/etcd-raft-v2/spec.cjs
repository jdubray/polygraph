// Reference JS-SAM v2 (strict profile) spec — etcd/raft single-node-step
// model. Fixture for the Polygraph TLC tier (scripts/to-tla.mjs +
// scripts/tla-check.mjs), copied from SysMoBench's
// scripts/harness/etcd/reference_sam_v2_spec.js.
//
// Requires @cognitive-fab/sam-pattern 2.1 (strict profile, next-state
// acceptor semantics).
// Resolution: env POLYGRAPH_SAM (path to a v2 dist bundle, e.g.
// <sam-lib>/dist/SAM.js) -> the plugin's vendored bundle
// (scripts/vendor/sam-pattern.cjs) -> the package name (which must then
// resolve to a v2 install, e.g. via POLYGRAPH_SAM_NODE_PATH — to-tla.mjs
// passes that through NODE_PATH).
'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');

function resolveSamV2() {
  if (process.env.POLYGRAPH_SAM) return process.env.POLYGRAPH_SAM;
  const vendored = path.join(__dirname, '..', '..', 'scripts', 'vendor', 'sam-pattern.cjs');
  if (existsSync(vendored)) return vendored;
  return '@cognitive-fab/sam-pattern';
}

const { createInstance } = require(resolveSamV2());

const instance = createInstance({
  strict: true, hasAsyncActions: false, instanceName: 'etcdraftv2',
});

const follower = () => ({ role: 'follower', term: 0, vote: '0', commit: 0, log: 0 });
const INITIAL_STATE = { nodes: { 1: follower(), 2: follower(), 3: follower() } };

const NODES = ['1', '2', '3'];
const PAIRS = [];
for (const node of NODES) for (const from of NODES) if (from !== node) PAIRS.push([node, from]);

const DOMAINS = {
  ElectionTimeout: NODES.map((node) => ({ node })),
  ClientProposal: NODES.map((node) => ({ node })),
  HandleVoteRequest: PAIRS.flatMap(([node, from]) => [
    { node, from, term: 1, logTerm: 0, index: 0 },
    { node, from, term: 2, logTerm: 1, index: 1 },
  ]),
  HandleAppendEntries: PAIRS.flatMap(([node, from]) => [
    { node, from, term: 1, logTerm: 0, index: 0, entries: 1, commit: 0 },
    { node, from, term: 1, logTerm: 0, index: 1, entries: 1, commit: 1 },
  ]),
  HandleHeartbeat: PAIRS.map(([node, from]) => ({ node, from, term: 1, commit: 1 })),
};

const str = { type: 'string', required: true };
const num = { type: 'number', required: true };

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      nodes: { type: 'object' },
    },
    actions: {
      ElectionTimeout: {
        action: (data) => ({ ...data }),
        schema: { node: str },
        domain: DOMAINS.ElectionTimeout,
      },
      HandleVoteRequest: {
        action: (data) => ({ ...data }),
        schema: { node: str, from: str, term: num, logTerm: num, index: num },
        domain: DOMAINS.HandleVoteRequest,
      },
      ClientProposal: {
        action: (data) => ({ ...data }),
        schema: { node: str },
        domain: DOMAINS.ClientProposal,
      },
      HandleAppendEntries: {
        action: (data) => ({ ...data }),
        schema: { node: str, from: str, term: num, logTerm: num, index: num, entries: num, commit: num },
        domain: DOMAINS.HandleAppendEntries,
      },
      HandleHeartbeat: {
        action: (data) => ({ ...data }),
        schema: { node: str, from: str, term: num, commit: num },
        domain: DOMAINS.HandleHeartbeat,
      },
    },
    acceptors: {
      // Each acceptor computes the updated node record from the frozen
      // pre-state and commits it with a TOP-LEVEL primed write
      // (next.nodes = ...), per the 2.1 next-state contract. An unknown node
      // is an observable no-op: frame `nodes` unchanged rather than reject.
      ElectionTimeout: (model) => (p, { next, unchanged }) => {
        const n = model.nodes[p.node];
        if (!n) return unchanged('nodes');
        const up = { ...n, term: n.term + 1, role: 'candidate', vote: String(p.node) };
        next.nodes = { ...model.nodes, [p.node]: up };
      },
      HandleVoteRequest: (model) => (p, { reject, next, unchanged }) => {
        const n = model.nodes[p.node];
        if (!n) return unchanged('nodes');
        if (p.term < n.term) return reject('stale campaign: lower term');
        const up = { ...n };
        if (p.term > n.term) {
          up.term = p.term;
          up.role = 'follower';
          up.vote = '0';
        }
        const canVote = up.vote === String(p.from) || up.vote === '0';
        const isUpToDate = p.index >= up.log;
        if (canVote && isUpToDate) up.vote = String(p.from);
        next.nodes = { ...model.nodes, [p.node]: up };
      },
      ClientProposal: (model) => (p, { reject, next, unchanged }) => {
        const n = model.nodes[p.node];
        if (!n) return unchanged('nodes');
        if (n.role !== 'leader') return reject('only a leader appends');
        next.nodes = { ...model.nodes, [p.node]: { ...n, log: n.log + 1 } };
      },
      HandleAppendEntries: (model) => (p, { reject, next, unchanged }) => {
        const n = model.nodes[p.node];
        if (!n) return unchanged('nodes');
        if (p.term < n.term) return reject('stale append: lower term');
        const up = { ...n };
        if (p.term > n.term) {
          up.term = p.term;
          up.vote = '0';
        }
        up.role = 'follower';
        if (p.index <= up.log) {
          const lastNew = p.index + p.entries;
          up.log = Math.max(up.log, lastNew);
          up.commit = Math.max(up.commit, Math.min(p.commit, lastNew));
        }
        next.nodes = { ...model.nodes, [p.node]: up };
      },
      HandleHeartbeat: (model) => (p, { reject, next, unchanged }) => {
        const n = model.nodes[p.node];
        if (!n) return unchanged('nodes');
        if (p.term < n.term) return reject('stale heartbeat: lower term');
        const up = { ...n };
        if (p.term > n.term) {
          up.term = p.term;
          up.vote = '0';
        }
        up.role = 'follower';
        up.commit = Math.max(up.commit, Math.min(p.commit, up.log));
        next.nodes = { ...model.nodes, [p.node]: up };
      },
    },
    reactors: [],
  },
});

const { intents } = control;

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };

const init = () => {
  const state = instance({}).state();
  if (state && typeof state.clearError === 'function') state.clearError();
  setState(INITIAL_STATE);
};

const actions = {
  ElectionTimeout: (data = {}) => intents.ElectionTimeout(data),
  HandleVoteRequest: (data = {}) => intents.HandleVoteRequest(data),
  ClientProposal: (data = {}) => intents.ClientProposal(data),
  HandleAppendEntries: (data = {}) => intents.HandleAppendEntries(data),
  HandleHeartbeat: (data = {}) => intents.HandleHeartbeat(data),
};

const checkerIntents = Object.keys(DOMAINS).map((name) => ({
  name,
  intent: actions[name],
  values: DOMAINS[name].map((payload) => [payload]),
}));

module.exports = { instance, init, actions, getState, setState, checkerIntents };
