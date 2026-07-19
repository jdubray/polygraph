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
    1: { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
    2: { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
    3: { role: 'follower', term: 0, vote: '0', commit: 0, log: 0 },
  },
};

// ---------------------------------------------------------------------------
// helpers (pure)
// ---------------------------------------------------------------------------

const clone = (n) => ({ role: n.role, term: n.term, vote: n.vote, commit: n.commit, log: n.log });

const same = (a, b) =>
  a.role === b.role && a.term === b.term && a.vote === b.vote && a.commit === b.commit && a.log === b.log;

// The observable state carries only the last log index and the node's current
// term. The term of the last log entry is approximated by the node's term for a
// non-empty log (entries are appended at the appending term) and 0 for an empty
// log -- this matches raftLog.lastEntryID() for the single-term traces the
// harness replays.
const lastLogTerm = (n) => (n.log > 0 ? n.term : 0);

// raftLog.isUpToDate(candLastID)
const isUpToDate = (n, logTerm, index) => {
  const lt = lastLogTerm(n);
  return logTerm > lt || (logTerm === lt && index >= n.log);
};

// r.reset(term) + becomeFollower(term, lead). Only term/vote/role are observable.
const becomeFollower = (n, term) => {
  const next = clone(n);
  if (next.term !== term) {
    next.term = term;
    next.vote = NONE;
  }
  next.role = 'follower';
  return next;
};

// becomeCandidate(): reset(Term+1) then Vote = self.
const becomeCandidate = (n, id) => {
  const next = clone(n);
  next.term = n.term + 1;
  next.vote = id;
  next.role = 'candidate';
  return next;
};

// raftLog.commitTo(commit): never regresses, never exceeds lastIndex.
const commitTo = (n, commit) => {
  const bounded = Math.min(commit, n.log);
  if (bounded > n.commit) n.commit = bounded;
};

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

const control = instance({
  initialState: { nodes: { ...INITIAL_STATE.nodes } },
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
            const froms = node === '1' ? ['2', '3', '1'] : node === '2' ? ['2', '3', '1'] : ['2', '3', '1'];
            for (const from of froms) {
              for (const term of [1, 2]) {
                for (const logTerm of [0, 1]) {
                  for (const index of [0, 1]) {
                    out.push({ node, from, term, logTerm, index });
                  }
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
            for (const from of ['2', '3', '1']) {
              out.push({ node, from, term: 1, commit: 1 });
            }
          }
          return out;
        })(),
      },
    },
    acceptors: {
      // tickElection -> Step(MsgHup) -> hup() -> campaign()
      ElectionTimeout: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const cur = model.nodes[id];
        if (!cur) return reject('unknown-node');
        // hup(): "%x ignoring MsgHup because already leader"
        if (cur.role === 'leader') return reject('already-leader');
        const next = becomeCandidate(cur, id);
        model.nodes = { ...model.nodes, [id]: next };
      },

      // Step(): MsgVote handling (term handling + canVote/isUpToDate)
      HandleVoteRequest: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const cur = model.nodes[id];
        if (!cur) return reject('unknown-node');
        const from = proposal.from;
        const mTerm = proposal.term;

        // m.Term < r.Term: the message is ignored (a rejection response is sent,
        // but no local state changes).
        if (mTerm < cur.term) return reject('stale-term');

        let next = clone(cur);
        // m.Term > r.Term: MsgVote is neither MsgApp/MsgHeartbeat/MsgSnap, so
        // becomeFollower(m.Term, None).
        if (mTerm > cur.term) {
          next = becomeFollower(next, mTerm);
        }

        // canVote: repeat of an existing vote, or no vote cast and no known
        // leader in this term. A leader always knows a leader (itself).
        const canVote = next.vote === from || (next.vote === NONE && next.role !== 'leader');
        const grant = canVote && isUpToDate(next, proposal.logTerm, proposal.index);
        if (grant) {
          // Only real votes are recorded (MsgVote, not MsgPreVote).
          next.vote = from;
        }

        if (same(cur, next)) return reject(grant ? 'vote-already-recorded' : 'vote-rejected');
        model.nodes = { ...model.nodes, [id]: next };
      },

      // Step(MsgProp) -> stepLeader -> appendEntry(); followers/candidates drop
      // or forward the proposal without changing observable state.
      ClientProposal: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const cur = model.nodes[id];
        if (!cur) return reject('unknown-node');
        if (cur.role !== 'leader') return reject('proposal-dropped-not-leader');
        const next = clone(cur);
        next.log = cur.log + 1;
        model.nodes = { ...model.nodes, [id]: next };
      },

      // Step(MsgApp) -> becomeFollower as needed -> handleAppendEntries()
      HandleAppendEntries: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const cur = model.nodes[id];
        if (!cur) return reject('unknown-node');
        const mTerm = proposal.term;
        const index = proposal.index;
        const logTerm = proposal.logTerm;
        const entries = proposal.entries;

        if (mTerm < cur.term) return reject('stale-term');

        let next = clone(cur);
        // Higher term, or a candidate at the same term, steps down to follower
        // with the sender as leader.
        if (mTerm > cur.term) {
          next = becomeFollower(next, mTerm);
        } else if (next.role === 'candidate') {
          next.role = 'follower';
        }

        // handleAppendEntries: prev index already committed -> ack with the
        // committed index, no state change.
        if (index < next.commit) {
          if (same(cur, next)) return reject('append-below-commit');
          model.nodes = { ...model.nodes, [id]: next };
          return;
        }

        // raftLog.maybeAppend: the previous entry must match.
        const matches = index <= next.log && logTerm === (index > 0 ? lastLogTerm(next) : 0);
        if (!matches) {
          // Rejected append: a hint response is sent, no local state change.
          if (same(cur, next)) return reject('append-rejected-log-mismatch');
          model.nodes = { ...model.nodes, [id]: next };
          return;
        }

        const lastNewIndex = index + entries;
        next.log = Math.max(next.log, lastNewIndex);
        // maybeAppend commits to min(m.Commit, lastnewi).
        const bounded = Math.min(proposal.commit, lastNewIndex);
        if (bounded > next.commit) next.commit = bounded;

        if (same(cur, next)) return reject('append-no-op');
        model.nodes = { ...model.nodes, [id]: next };
      },

      // Step(MsgHeartbeat) -> becomeFollower as needed -> handleHeartbeat()
      HandleHeartbeat: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const cur = model.nodes[id];
        if (!cur) return reject('unknown-node');
        const mTerm = proposal.term;

        if (mTerm < cur.term) return reject('stale-term');

        let next = clone(cur);
        if (mTerm > cur.term) {
          next = becomeFollower(next, mTerm);
        } else if (next.role === 'candidate') {
          next.role = 'follower';
        }

        commitTo(next, proposal.commit);

        if (same(cur, next)) return reject('heartbeat-no-op');
        model.nodes = { ...model.nodes, [id]: next };
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
