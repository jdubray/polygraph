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

// None (no leader / no vote) is encoded as the string '0', matching raft.None.
const NONE = '0';

const INITIAL_STATE = {
  nodes: {
    '1': { role: 'follower', term: 0, vote: NONE, commit: 0, log: 0 },
    '2': { role: 'follower', term: 0, vote: NONE, commit: 0, log: 0 },
    '3': { role: 'follower', term: 0, vote: NONE, commit: 0, log: 0 },
  },
};

const clone = (n) => ({ role: n.role, term: n.term, vote: n.vote, commit: n.commit, log: n.log });

// r.raftLog.lastEntryID() approximation: index is the entry count, term is the
// term the local node was in when it last appended (0 for an empty log).
const lastLogTerm = (n) => (n.log > 0 ? n.term : 0);

// r.raftLog.isUpToDate(candLastID)
const isUpToDate = (n, logTerm, index) => {
  const lt = lastLogTerm(n);
  return logTerm > lt || (logTerm === lt && index >= n.log);
};

// r.reset(term) — Vote is cleared only when the term actually changes.
const reset = (n, term) => {
  if (n.term !== term) {
    n.term = term;
    n.vote = NONE;
  }
};

// r.becomeFollower(term, lead)
const becomeFollower = (n, term) => {
  reset(n, term);
  n.role = 'follower';
};

const same = (a, b) =>
  a.role === b.role && a.term === b.term && a.vote === b.vote && a.commit === b.commit && a.log === b.log;

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
      // MsgHup -> r.hup(campaignElection) -> r.campaign -> becomeCandidate
      ElectionTimeout: (model) => (proposal, { reject }) => {
        const id = String(proposal && proposal.node);
        const prev = model.nodes[id];
        if (!prev) return reject('unknown-node');
        // r.hup: "%x ignoring MsgHup because already leader"
        if (prev.role === 'leader') return reject('already-leader');

        const n = clone(prev);
        // becomeCandidate: reset(r.Term + 1) then Vote = r.id
        reset(n, n.term + 1);
        n.vote = id;
        n.role = 'candidate';

        model.nodes = { ...model.nodes, [id]: n };
      },

      // Step(): term handling, then the MsgVote branch.
      HandleVoteRequest: (model) => (proposal, { reject }) => {
        const id = String(proposal && proposal.node);
        const prev = model.nodes[id];
        if (!prev) return reject('unknown-node');

        const from = String(proposal.from);
        const mTerm = Number(proposal.term);
        const logTerm = Number(proposal.logTerm);
        const index = Number(proposal.index);

        // m.Term < r.Term: ignored (a rejection message is sent, no state change).
        if (mTerm < prev.term) return reject('stale-term');

        const n = clone(prev);
        // Note: the up-to-date check compares against the log as it was before
        // any term bump, so capture it first.
        const upToDate = isUpToDate(prev, logTerm, index);

        // m.Term > r.Term: default branch -> becomeFollower(m.Term, None).
        if (mTerm > n.term) becomeFollower(n, mTerm);

        // canVote = r.Vote == m.From || (r.Vote == None && r.lead == None)
        const canVote = n.vote === from || n.vote === NONE;

        if (canVote && upToDate) {
          // Grant: r.electionElapsed = 0; r.Vote = m.From (MsgVote only).
          n.vote = from;
        }
        // else: rejection response only; no further state change.

        if (same(prev, n)) return reject('vote-not-granted-no-change');
        model.nodes = { ...model.nodes, [id]: n };
      },

      // MsgProp on the leader -> appendEntry -> log grows by one entry.
      ClientProposal: (model) => (proposal, { reject }) => {
        const id = String(proposal && proposal.node);
        const prev = model.nodes[id];
        if (!prev) return reject('unknown-node');
        // stepCandidate / stepFollower with no leader drop the proposal
        // (ErrProposalDropped); only a leader appends.
        if (prev.role !== 'leader') return reject('not-leader');

        const n = clone(prev);
        n.log = n.log + 1;
        model.nodes = { ...model.nodes, [id]: n };
      },

      // MsgApp -> becomeFollower(m.Term, m.From) then handleAppendEntries.
      HandleAppendEntries: (model) => (proposal, { reject }) => {
        const id = String(proposal && proposal.node);
        const prev = model.nodes[id];
        if (!prev) return reject('unknown-node');

        const mTerm = Number(proposal.term);
        const logTerm = Number(proposal.logTerm);
        const index = Number(proposal.index);
        const entries = Number(proposal.entries);
        const mCommit = Number(proposal.commit);

        // m.Term < r.Term: ignored (only an MsgAppResp is sent back).
        if (mTerm < prev.term) return reject('stale-term');

        const n = clone(prev);
        const prevLastTerm = lastLogTerm(prev);

        // m.Term > r.Term -> becomeFollower(m.Term, m.From);
        // m.Term == r.Term -> stepCandidate/stepFollower also set the leader and
        // (for a candidate) step down to follower.
        if (mTerm > n.term) becomeFollower(n, mTerm);
        else n.role = n.role === 'leader' ? n.role : 'follower';

        // a.prev.index < r.raftLog.committed -> ack committed, no change.
        if (index < n.commit) {
          if (same(prev, n)) return reject('append-below-commit');
          model.nodes = { ...model.nodes, [id]: n };
          return;
        }

        // r.raftLog.maybeAppend: the prev entry must match. With a
        // count-only log, the match condition is index <= log and the term at
        // that index agreeing (term 0 for the empty prefix).
        const prevMatches = index <= prev.log && (index === 0 ? logTerm === 0 : logTerm <= prevLastTerm);
        if (!prevMatches) {
          // Rejected MsgApp: a hint is returned, no local state change beyond
          // any term/role step-down above.
          if (same(prev, n)) return reject('append-rejected');
          model.nodes = { ...model.nodes, [id]: n };
          return;
        }

        const lastNewIndex = index + entries;
        n.log = lastNewIndex;
        // commitTo(min(m.Commit, lastnewi)), monotonic.
        const newCommit = Math.min(mCommit, lastNewIndex);
        if (newCommit > n.commit) n.commit = newCommit;

        if (same(prev, n)) return reject('append-no-change');
        model.nodes = { ...model.nodes, [id]: n };
      },

      // MsgHeartbeat -> becomeFollower(m.Term, m.From) then handleHeartbeat.
      HandleHeartbeat: (model) => (proposal, { reject }) => {
        const id = String(proposal && proposal.node);
        const prev = model.nodes[id];
        if (!prev) return reject('unknown-node');

        const mTerm = Number(proposal.term);
        const mCommit = Number(proposal.commit);

        if (mTerm < prev.term) return reject('stale-term');

        const n = clone(prev);
        if (mTerm > n.term) becomeFollower(n, mTerm);
        else n.role = n.role === 'leader' ? n.role : 'follower';

        // r.raftLog.commitTo(m.Commit) — never past the local last index, and
        // never backwards.
        const newCommit = Math.min(mCommit, n.log);
        if (newCommit > n.commit) n.commit = newCommit;

        if (same(prev, n)) return reject('heartbeat-no-change');
        model.nodes = { ...model.nodes, [id]: n };
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
  setState(JSON.parse(JSON.stringify(INITIAL_STATE)));
};

const actions = {
  ElectionTimeout: (data = {}) => intents.ElectionTimeout(data),
  HandleVoteRequest: (data = {}) => intents.HandleVoteRequest(data),
  ClientProposal: (data = {}) => intents.ClientProposal(data),
  HandleAppendEntries: (data = {}) => intents.HandleAppendEntries(data),
  HandleHeartbeat: (data = {}) => intents.HandleHeartbeat(data),
};

module.exports = { instance, init, actions, getState, setState };
