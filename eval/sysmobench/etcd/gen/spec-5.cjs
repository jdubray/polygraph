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
    1: { role: 'follower', term: 0, vote: NONE, commit: 0, log: 0 },
    2: { role: 'follower', term: 0, vote: NONE, commit: 0, log: 0 },
    3: { role: 'follower', term: 0, vote: NONE, commit: 0, log: 0 },
  },
};

// ---------------------------------------------------------------------------
// helpers (pure)
// ---------------------------------------------------------------------------

const getNode = (model, id) => (model.nodes ? model.nodes[id] : undefined);

const copy = (n) => ({ role: n.role, term: n.term, vote: n.vote, commit: n.commit, log: n.log });

const same = (a, b) =>
  a.role === b.role && a.term === b.term && a.vote === b.vote && a.commit === b.commit && a.log === b.log;

// last entry term of a node's log, approximated from the observable state:
// an empty log has term 0; otherwise the tail was written in the node's
// current term (entries are stamped with r.Term on append).
const lastTerm = (n) => (n.log > 0 ? n.term : 0);

// raftLog.isUpToDate(candLastID)
const isUpToDate = (n, candTerm, candIndex) =>
  candTerm > lastTerm(n) || (candTerm === lastTerm(n) && candIndex >= n.log);

// raftLog.matchTerm(entryID{term,index}) for the prev entry of a MsgApp
const matchTerm = (n, index, term) => {
  if (index === 0) return term === 0;
  if (index > n.log) return false;
  return term <= n.term;
};

// r.becomeFollower(term, lead) — only the observable part
const becomeFollower = (n, term) => {
  if (n.term !== term) {
    n.term = term;
    n.vote = NONE;
  }
  n.role = 'follower';
};

// r.becomeCandidate()
const becomeCandidate = (n, id) => {
  n.term += 1;
  n.vote = id;
  n.role = 'candidate';
};

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

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
        domain: [
          { node: '1', from: '2', term: 1, logTerm: 0, index: 0 },
          { node: '1', from: '2', term: 1, logTerm: 0, index: 1 },
          { node: '1', from: '2', term: 1, logTerm: 1, index: 0 },
          { node: '1', from: '2', term: 1, logTerm: 1, index: 1 },
          { node: '1', from: '2', term: 2, logTerm: 0, index: 0 },
          { node: '1', from: '2', term: 2, logTerm: 0, index: 1 },
          { node: '1', from: '2', term: 2, logTerm: 1, index: 0 },
          { node: '1', from: '2', term: 2, logTerm: 1, index: 1 },
          { node: '1', from: '3', term: 1, logTerm: 0, index: 0 },
          { node: '1', from: '3', term: 1, logTerm: 0, index: 1 },
          { node: '1', from: '3', term: 1, logTerm: 1, index: 0 },
          { node: '1', from: '3', term: 1, logTerm: 1, index: 1 },
          { node: '1', from: '3', term: 2, logTerm: 0, index: 0 },
          { node: '1', from: '3', term: 2, logTerm: 0, index: 1 },
          { node: '1', from: '3', term: 2, logTerm: 1, index: 0 },
          { node: '1', from: '3', term: 2, logTerm: 1, index: 1 },
          { node: '1', from: '1', term: 1, logTerm: 0, index: 0 },
          { node: '1', from: '1', term: 1, logTerm: 0, index: 1 },
          { node: '1', from: '1', term: 1, logTerm: 1, index: 0 },
          { node: '1', from: '1', term: 1, logTerm: 1, index: 1 },
          { node: '1', from: '1', term: 2, logTerm: 0, index: 0 },
          { node: '1', from: '1', term: 2, logTerm: 0, index: 1 },
          { node: '1', from: '1', term: 2, logTerm: 1, index: 0 },
          { node: '1', from: '1', term: 2, logTerm: 1, index: 1 },
          { node: '2', from: '2', term: 1, logTerm: 0, index: 0 },
          { node: '2', from: '2', term: 1, logTerm: 0, index: 1 },
          { node: '2', from: '2', term: 1, logTerm: 1, index: 0 },
          { node: '2', from: '2', term: 1, logTerm: 1, index: 1 },
          { node: '2', from: '2', term: 2, logTerm: 0, index: 0 },
          { node: '2', from: '2', term: 2, logTerm: 0, index: 1 },
          { node: '2', from: '2', term: 2, logTerm: 1, index: 0 },
          { node: '2', from: '2', term: 2, logTerm: 1, index: 1 },
          { node: '2', from: '3', term: 1, logTerm: 0, index: 0 },
          { node: '2', from: '3', term: 1, logTerm: 0, index: 1 },
          { node: '2', from: '3', term: 1, logTerm: 1, index: 0 },
          { node: '2', from: '3', term: 1, logTerm: 1, index: 1 },
          { node: '2', from: '3', term: 2, logTerm: 0, index: 0 },
          { node: '2', from: '3', term: 2, logTerm: 0, index: 1 },
          { node: '2', from: '3', term: 2, logTerm: 1, index: 0 },
          { node: '2', from: '3', term: 2, logTerm: 1, index: 1 },
          { node: '2', from: '1', term: 1, logTerm: 0, index: 0 },
          { node: '2', from: '1', term: 1, logTerm: 0, index: 1 },
          { node: '2', from: '1', term: 1, logTerm: 1, index: 0 },
          { node: '2', from: '1', term: 1, logTerm: 1, index: 1 },
          { node: '2', from: '1', term: 2, logTerm: 0, index: 0 },
          { node: '2', from: '1', term: 2, logTerm: 0, index: 1 },
          { node: '2', from: '1', term: 2, logTerm: 1, index: 0 },
          { node: '2', from: '1', term: 2, logTerm: 1, index: 1 },
          { node: '3', from: '2', term: 1, logTerm: 0, index: 0 },
          { node: '3', from: '2', term: 1, logTerm: 0, index: 1 },
          { node: '3', from: '2', term: 1, logTerm: 1, index: 0 },
          { node: '3', from: '2', term: 1, logTerm: 1, index: 1 },
          { node: '3', from: '2', term: 2, logTerm: 0, index: 0 },
          { node: '3', from: '2', term: 2, logTerm: 0, index: 1 },
          { node: '3', from: '2', term: 2, logTerm: 1, index: 0 },
          { node: '3', from: '2', term: 2, logTerm: 1, index: 1 },
          { node: '3', from: '3', term: 1, logTerm: 0, index: 0 },
          { node: '3', from: '3', term: 1, logTerm: 0, index: 1 },
          { node: '3', from: '3', term: 1, logTerm: 1, index: 0 },
          { node: '3', from: '3', term: 1, logTerm: 1, index: 1 },
          { node: '3', from: '3', term: 2, logTerm: 0, index: 0 },
          { node: '3', from: '3', term: 2, logTerm: 0, index: 1 },
          { node: '3', from: '3', term: 2, logTerm: 1, index: 0 },
          { node: '3', from: '3', term: 2, logTerm: 1, index: 1 },
          { node: '3', from: '1', term: 1, logTerm: 0, index: 0 },
          { node: '3', from: '1', term: 1, logTerm: 0, index: 1 },
          { node: '3', from: '1', term: 1, logTerm: 1, index: 0 },
          { node: '3', from: '1', term: 1, logTerm: 1, index: 1 },
          { node: '3', from: '1', term: 2, logTerm: 0, index: 0 },
          { node: '3', from: '1', term: 2, logTerm: 0, index: 1 },
          { node: '3', from: '1', term: 2, logTerm: 1, index: 0 },
          { node: '3', from: '1', term: 2, logTerm: 1, index: 1 },
        ],
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
        domain: [
          { node: '1', from: '2', term: 1, logTerm: 0, index: 0, entries: 1, commit: 0 },
          { node: '1', from: '2', term: 1, logTerm: 0, index: 0, entries: 1, commit: 1 },
          { node: '1', from: '2', term: 1, logTerm: 0, index: 1, entries: 1, commit: 0 },
          { node: '1', from: '2', term: 1, logTerm: 0, index: 1, entries: 1, commit: 1 },
          { node: '1', from: '3', term: 1, logTerm: 0, index: 0, entries: 1, commit: 0 },
          { node: '1', from: '3', term: 1, logTerm: 0, index: 0, entries: 1, commit: 1 },
          { node: '1', from: '3', term: 1, logTerm: 0, index: 1, entries: 1, commit: 0 },
          { node: '1', from: '3', term: 1, logTerm: 0, index: 1, entries: 1, commit: 1 },
          { node: '1', from: '1', term: 1, logTerm: 0, index: 0, entries: 1, commit: 0 },
          { node: '1', from: '1', term: 1, logTerm: 0, index: 0, entries: 1, commit: 1 },
          { node: '1', from: '1', term: 1, logTerm: 0, index: 1, entries: 1, commit: 0 },
          { node: '1', from: '1', term: 1, logTerm: 0, index: 1, entries: 1, commit: 1 },
          { node: '2', from: '2', term: 1, logTerm: 0, index: 0, entries: 1, commit: 0 },
          { node: '2', from: '2', term: 1, logTerm: 0, index: 0, entries: 1, commit: 1 },
          { node: '2', from: '2', term: 1, logTerm: 0, index: 1, entries: 1, commit: 0 },
          { node: '2', from: '2', term: 1, logTerm: 0, index: 1, entries: 1, commit: 1 },
          { node: '2', from: '3', term: 1, logTerm: 0, index: 0, entries: 1, commit: 0 },
          { node: '2', from: '3', term: 1, logTerm: 0, index: 0, entries: 1, commit: 1 },
          { node: '2', from: '3', term: 1, logTerm: 0, index: 1, entries: 1, commit: 0 },
          { node: '2', from: '3', term: 1, logTerm: 0, index: 1, entries: 1, commit: 1 },
          { node: '2', from: '1', term: 1, logTerm: 0, index: 0, entries: 1, commit: 0 },
          { node: '2', from: '1', term: 1, logTerm: 0, index: 0, entries: 1, commit: 1 },
          { node: '2', from: '1', term: 1, logTerm: 0, index: 1, entries: 1, commit: 0 },
          { node: '2', from: '1', term: 1, logTerm: 0, index: 1, entries: 1, commit: 1 },
          { node: '3', from: '2', term: 1, logTerm: 0, index: 0, entries: 1, commit: 0 },
          { node: '3', from: '2', term: 1, logTerm: 0, index: 0, entries: 1, commit: 1 },
          { node: '3', from: '2', term: 1, logTerm: 0, index: 1, entries: 1, commit: 0 },
          { node: '3', from: '2', term: 1, logTerm: 0, index: 1, entries: 1, commit: 1 },
          { node: '3', from: '3', term: 1, logTerm: 0, index: 0, entries: 1, commit: 0 },
          { node: '3', from: '3', term: 1, logTerm: 0, index: 0, entries: 1, commit: 1 },
          { node: '3', from: '3', term: 1, logTerm: 0, index: 1, entries: 1, commit: 0 },
          { node: '3', from: '3', term: 1, logTerm: 0, index: 1, entries: 1, commit: 1 },
          { node: '3', from: '1', term: 1, logTerm: 0, index: 0, entries: 1, commit: 0 },
          { node: '3', from: '1', term: 1, logTerm: 0, index: 0, entries: 1, commit: 1 },
          { node: '3', from: '1', term: 1, logTerm: 0, index: 1, entries: 1, commit: 0 },
          { node: '3', from: '1', term: 1, logTerm: 0, index: 1, entries: 1, commit: 1 },
        ],
      },
      HandleHeartbeat: {
        action: (data = {}) => ({ ...data }),
        schema: {
          node: { type: 'string', required: true },
          from: { type: 'string', required: true },
          term: { type: 'number', required: true },
          commit: { type: 'number', required: true },
        },
        domain: [
          { node: '1', from: '2', term: 1, commit: 1 },
          { node: '1', from: '3', term: 1, commit: 1 },
          { node: '1', from: '1', term: 1, commit: 1 },
          { node: '2', from: '2', term: 1, commit: 1 },
          { node: '2', from: '3', term: 1, commit: 1 },
          { node: '2', from: '1', term: 1, commit: 1 },
          { node: '3', from: '2', term: 1, commit: 1 },
          { node: '3', from: '3', term: 1, commit: 1 },
          { node: '3', from: '1', term: 1, commit: 1 },
        ],
      },
    },

    acceptors: {
      // MsgHup -> r.hup(campaignElection) -> r.campaign() -> becomeCandidate()
      ElectionTimeout: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const cur = getNode(model, id);
        if (!cur) return reject('unknown-node');
        if (cur.role === 'leader') return reject('ignoring-MsgHup-already-leader');

        const n = copy(cur);
        becomeCandidate(n, String(id));
        if (same(n, cur)) return reject('no-op');
        model.nodes = { ...model.nodes, [id]: n };
      },

      // Step(): term handling, then the MsgVote case.
      HandleVoteRequest: (model) => (proposal, { reject }) => {
        const p = proposal || {};
        const id = p.node;
        const cur = getNode(model, id);
        if (!cur) return reject('unknown-node');
        const from = String(p.from);
        const mTerm = p.term;
        const mLogTerm = p.logTerm;
        const mIndex = p.index;

        if (typeof mTerm !== 'number' || typeof mLogTerm !== 'number' || typeof mIndex !== 'number') {
          return reject('malformed-message');
        }

        const n = copy(cur);

        if (mTerm < n.term) {
          // ignored: lower-term MsgVote (no observable state change)
          return reject('ignored-lower-term-MsgVote');
        }
        if (mTerm > n.term) {
          // default branch of Step: becomeFollower(m.Term, None)
          becomeFollower(n, mTerm);
        }

        // canVote: repeat vote, or no vote cast yet and no known leader.
        // A leader in the current term is its own lead, so it never has a
        // free vote to give at that term.
        const votedFree = n.vote === NONE && n.role !== 'leader';
        const canVote = n.vote === from || votedFree;

        if (canVote && isUpToDate(n, mLogTerm, mIndex)) {
          // grant: MsgVote records the vote (electionElapsed is not observable)
          n.vote = from;
        }
        // else: rejection response only, no state change

        if (same(n, cur)) return reject('vote-rejected-no-state-change');
        model.nodes = { ...model.nodes, [id]: n };
      },

      // MsgProp on the leader: appendEntry(...) then bcastAppend().
      ClientProposal: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const cur = getNode(model, id);
        if (!cur) return reject('unknown-node');
        if (cur.role !== 'leader') return reject('proposal-dropped-no-leader');

        const n = copy(cur);
        n.log += 1;
        model.nodes = { ...model.nodes, [id]: n };
      },

      // MsgApp: term handling, becomeFollower, then handleAppendEntries.
      HandleAppendEntries: (model) => (proposal, { reject }) => {
        const p = proposal || {};
        const id = p.node;
        const cur = getNode(model, id);
        if (!cur) return reject('unknown-node');
        const mTerm = p.term;
        const mLogTerm = p.logTerm;
        const mIndex = p.index;
        const mEntries = p.entries;
        const mCommit = p.commit;

        if (
          typeof mTerm !== 'number' ||
          typeof mLogTerm !== 'number' ||
          typeof mIndex !== 'number' ||
          typeof mEntries !== 'number' ||
          typeof mCommit !== 'number'
        ) {
          return reject('malformed-message');
        }

        const n = copy(cur);

        if (mTerm < n.term) {
          // stale MsgApp: only a MsgAppResp is emitted, no state change
          return reject('ignored-lower-term-MsgApp');
        }
        if (mTerm > n.term) {
          becomeFollower(n, mTerm); // lead = m.From
        } else if (n.role === 'leader') {
          // stepLeader has no MsgApp case: no-op
          return reject('leader-ignores-MsgApp');
        } else if (n.role === 'candidate') {
          becomeFollower(n, mTerm); // stepCandidate: becomeFollower(m.Term, m.From)
        }

        // handleAppendEntries
        if (mIndex < n.commit) {
          // already committed past this append: ack with committed index only
          if (same(n, cur)) return reject('append-below-commit');
          model.nodes = { ...model.nodes, [id]: n };
          return;
        }

        if (matchTerm(n, mIndex, mLogTerm)) {
          const lastNewIndex = mIndex + mEntries;
          n.log = lastNewIndex;
          // raftLog.commitTo(min(m.Commit, lastNewIndex)), monotonic
          const target = Math.min(mCommit, lastNewIndex);
          if (target > n.commit) n.commit = target;
        }
        // else: rejected MsgApp with a hint; no log/commit change

        if (same(n, cur)) return reject('append-rejected-no-state-change');
        model.nodes = { ...model.nodes, [id]: n };
      },

      // MsgHeartbeat: term handling, becomeFollower, then handleHeartbeat.
      HandleHeartbeat: (model) => (proposal, { reject }) => {
        const p = proposal || {};
        const id = p.node;
        const cur = getNode(model, id);
        if (!cur) return reject('unknown-node');
        const mTerm = p.term;
        const mCommit = p.commit;

        if (typeof mTerm !== 'number' || typeof mCommit !== 'number') {
          return reject('malformed-message');
        }

        const n = copy(cur);

        if (mTerm < n.term) {
          return reject('ignored-lower-term-MsgHeartbeat');
        }
        if (mTerm > n.term) {
          becomeFollower(n, mTerm); // lead = m.From
        } else if (n.role === 'leader') {
          return reject('leader-ignores-MsgHeartbeat');
        } else if (n.role === 'candidate') {
          becomeFollower(n, mTerm);
        }

        // raftLog.commitTo(m.Commit): monotonic, never past the local last index
        const target = Math.min(mCommit, n.log);
        if (target > n.commit) n.commit = target;

        if (same(n, cur)) return reject('heartbeat-no-state-change');
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
