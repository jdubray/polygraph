'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');

function resolveSamV2() {
  if (process.env.POLYGRAPH_SAM) return process.env.POLYGRAPH_SAM;
  const vendored = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'vendor', 'sam-pattern.cjs');
  if (existsSync(vendored)) return vendored;
  return '@cognitive-fab/sam-pattern';
}

const { createInstance } = require(resolveSamV2());

const instance = createInstance({ strict: true, hasAsyncActions: false });

const NONE = '0';

const INITIAL_STATE = {
  nodes: {
    '1': { role: 'follower', term: 0, vote: NONE, commit: 0, log: 0 },
    '2': { role: 'follower', term: 0, vote: NONE, commit: 0, log: 0 },
    '3': { role: 'follower', term: 0, vote: NONE, commit: 0, log: 0 },
  },
};

// --- helpers (pure) -------------------------------------------------------

const clone = (n) => ({ role: n.role, term: n.term, vote: n.vote, commit: n.commit, log: n.log });

const same = (a, b) =>
  a.role === b.role && a.term === b.term && a.vote === b.vote && a.commit === b.commit && a.log === b.log;

// term of the entry at index i in this node's log. Index 0 is the empty
// sentinel (term 0); every materialized entry is modeled as carrying the
// node's current term (the observable state keeps only a log length).
const entryTerm = (n, i) => {
  if (i === 0) return 0;
  if (i > n.log) return -1; // out of bounds: never matches
  return n.term;
};

// raftLog.isUpToDate: candidate's last entry id >= ours.
const isUpToDate = (n, logTerm, index) => {
  const myLastTerm = entryTerm(n, n.log);
  return logTerm > myLastTerm || (logTerm === myLastTerm && index >= n.log);
};

// (*raft).becomeFollower(term, lead)
const becomeFollower = (n, term) => {
  if (n.term !== term) {
    n.term = term;
    n.vote = NONE; // reset(): Vote = None on a term change
  }
  n.role = 'follower';
};

// Common prologue of (*raft).Step for a message carrying m.Term.
// Returns 'ignored' when the message is dropped without any state change,
// otherwise 'stepped' (the node may have stepped down as a side effect).
const stepTerm = (n, msgTerm, isAppendLike) => {
  if (msgTerm === 0) return 'stepped'; // local message
  if (msgTerm > n.term) {
    becomeFollower(n, msgTerm);
    return 'stepped';
  }
  if (msgTerm < n.term) return 'ignored';
  // m.Term == r.Term: MsgApp/MsgHeartbeat from the leader of this term make a
  // candidate / pre-candidate revert to follower (stepCandidate).
  if (isAppendLike && n.role !== 'follower' && n.role !== 'leader') {
    becomeFollower(n, msgTerm);
  }
  return 'stepped';
};

const commitTo = (n, commit) => {
  // raftLog.commitTo only ever raises the commit index, and never past the
  // last index of the local log.
  const target = Math.min(commit, n.log);
  if (target > n.commit) n.commit = target;
};

const put = (model, id, node) => {
  model.nodes = { ...model.nodes, [id]: node };
};

// --- component ------------------------------------------------------------

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      nodes: { type: 'object' },
    },
    actions: {
      ElectionTimeout: {
        action: (data = {}) => ({ ...data }),
        schema: { node: { type: 'string', required: true } },
        domain: [{ node: '1' }, { node: '2' }, { node: '3' }],
      },
      HandleVoteRequest: {
        action: (data = {}) => ({ ...data }),
        schema: {
          node: { type: 'string', required: true },
          from: { type: 'string', required: true },
          term: { type: 'number', required: true },
          logTerm: { type: 'number', required: true },
          index: { type: 'number', required: true },
        },
        domain: (() => {
          const out = [];
          for (const node of ['1', '2', '3']) {
            for (const from of ['2', '3', '1']) {
              for (const term of [1, 2]) {
                for (const logTerm of [0, 1]) {
                  for (const index of [0, 1]) out.push({ node, from, term, logTerm, index });
                }
              }
            }
          }
          return out;
        })(),
      },
      ClientProposal: {
        action: (data = {}) => ({ ...data }),
        schema: { node: { type: 'string', required: true } },
        domain: [{ node: '1' }, { node: '2' }, { node: '3' }],
      },
      HandleAppendEntries: {
        action: (data = {}) => ({ ...data }),
        schema: {
          node: { type: 'string', required: true },
          from: { type: 'string', required: true },
          term: { type: 'number', required: true },
          logTerm: { type: 'number', required: true },
          index: { type: 'number', required: true },
          entries: { type: 'number', required: true },
          commit: { type: 'number', required: true },
        },
        domain: (() => {
          const out = [];
          for (const node of ['1', '2', '3']) {
            for (const from of ['2', '3', '1']) {
              for (const index of [0, 1]) {
                for (const commit of [0, 1]) {
                  out.push({ node, from, term: 1, logTerm: 0, index, entries: 1, commit });
                }
              }
            }
          }
          return out;
        })(),
      },
      HandleHeartbeat: {
        action: (data = {}) => ({ ...data }),
        schema: {
          node: { type: 'string', required: true },
          from: { type: 'string', required: true },
          term: { type: 'number', required: true },
          commit: { type: 'number', required: true },
        },
        domain: (() => {
          const out = [];
          for (const node of ['1', '2', '3']) {
            for (const from of ['2', '3', '1']) out.push({ node, from, term: 1, commit: 1 });
          }
          return out;
        })(),
      },
    },
    acceptors: {
      // (*raft).tickElection -> MsgHup -> hup() -> campaign(campaignElection)
      ElectionTimeout: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const prev = model.nodes ? model.nodes[id] : undefined;
        if (!prev) return reject('unknown-node');
        // hup(): "ignoring MsgHup because already leader"
        if (prev.role === 'leader') return reject('already-leader');

        // becomeCandidate(): reset(Term+1) then Vote = self.
        const n = clone(prev);
        n.term = prev.term + 1;
        n.role = 'candidate';
        n.vote = id;
        put(model, id, n);
      },

      // Step: MsgVote handling (term prologue + canVote / isUpToDate).
      HandleVoteRequest: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const prev = model.nodes ? model.nodes[id] : undefined;
        if (!prev) return reject('unknown-node');
        const { from, term, logTerm, index } = proposal;

        const n = clone(prev);
        if (stepTerm(n, term, false) === 'ignored') {
          // m.Term < r.Term: rejection response only, no state change.
          return reject('stale-term');
        }

        // canVote: repeat of a vote already cast, or we have not voted yet
        // (and know of no leader in this term).
        const canVote = n.vote === from || (n.vote === NONE && n.role !== 'leader');
        if (canVote && isUpToDate(n, logTerm, index)) {
          // MsgVote (not pre-vote): record the vote.
          n.vote = from;
        }
        // Otherwise a rejection response is sent; no further state change.

        if (same(n, prev)) return reject('vote-not-granted');
        put(model, id, n);
      },

      // stepLeader/MsgProp -> appendEntry; every other role drops or forwards.
      ClientProposal: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const prev = model.nodes ? model.nodes[id] : undefined;
        if (!prev) return reject('unknown-node');
        if (prev.role !== 'leader') return reject('proposal-dropped-not-leader');

        const n = clone(prev);
        n.log = prev.log + 1;
        put(model, id, n);
      },

      // Step term prologue + (*raft).handleAppendEntries.
      HandleAppendEntries: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const prev = model.nodes ? model.nodes[id] : undefined;
        if (!prev) return reject('unknown-node');
        const { term, logTerm, index, entries, commit } = proposal;

        const n = clone(prev);
        if (stepTerm(n, term, true) === 'ignored') return reject('stale-term');

        if (n.role === 'leader') {
          // stepLeader has no MsgApp case; the message is ignored.
          if (same(n, prev)) return reject('leader-ignores-append');
          put(model, id, n);
          return;
        }

        // stepFollower: r.lead = m.From, then handleAppendEntries.
        if (index < n.commit) {
          // Already-committed prefix: respond with the commit index only.
          if (same(n, prev)) return reject('append-below-commit');
          put(model, id, n);
          return;
        }

        if (entryTerm(n, index) === logTerm) {
          // maybeAppend succeeded: truncate at index and append `entries`.
          n.log = index + entries;
          commitTo(n, commit);
        }
        // else: rejected MsgApp with a conflict hint; no log change.

        if (same(n, prev)) return reject('append-rejected');
        put(model, id, n);
      },

      // Step term prologue + (*raft).handleHeartbeat.
      HandleHeartbeat: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const prev = model.nodes ? model.nodes[id] : undefined;
        if (!prev) return reject('unknown-node');
        const { term, commit } = proposal;

        const n = clone(prev);
        if (stepTerm(n, term, true) === 'ignored') return reject('stale-term');

        if (n.role === 'leader') {
          // stepLeader has no MsgHeartbeat case; ignored.
          if (same(n, prev)) return reject('leader-ignores-heartbeat');
          put(model, id, n);
          return;
        }

        commitTo(n, commit);

        if (same(n, prev)) return reject('heartbeat-no-op');
        put(model, id, n);
      },
    },
    reactors: [],
  },
});

const { intents } = control;

const getState = () => instance({}).getState();
const setState = (snapshot) => {
  instance({}).setState(snapshot);
};

const init = () => {
  setState(INITIAL_STATE);
};

const actions = {
  ElectionTimeout: (data = {}) => intents.ElectionTimeout(data),
  HandleVoteRequest: (data = {}) => intents.HandleVoteRequest(data),
  ClientProposal: (data = {}) => intents.ClientProposal(data),
  HandleAppendEntries: (data = {}) => intents.HandleAppendEntries(data),
  HandleHeartbeat: (data = {}) => intents.HandleHeartbeat(data),
};

module.exports = { instance, init, actions, getState, setState };
