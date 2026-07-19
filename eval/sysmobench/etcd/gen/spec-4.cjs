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

// ---------------------------------------------------------------------------
// helpers (pure)
// ---------------------------------------------------------------------------

// The observable log is only a last-index counter, so the term of the last
// entry is approximated: an empty log has last term 0, a non-empty log carries
// the node's current term (entries are appended at the local term and the term
// only ever moves forward).
const lastLogTerm = (n) => (n.log > 0 ? n.term : 0);

// raft.reset(term) + becomeFollower(term, lead)
const becomeFollower = (n, term) => {
  const bumped = n.term !== term;
  return {
    ...n,
    role: 'follower',
    term,
    vote: bumped ? NONE : n.vote,
  };
};

// raftLog.isUpToDate(candLastID)
const isUpToDate = (n, logTerm, index) => {
  const lt = lastLogTerm(n);
  return logTerm > lt || (logTerm === lt && index >= n.log);
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
        domain: (() => {
          const out = [];
          for (const node of ['1', '2', '3']) {
            for (const from of ['2', '3', '1']) {
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
      // raft.tickElection -> Step(MsgHup) -> hup() -> campaign() -> becomeCandidate()
      ElectionTimeout: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const n = id != null ? model.nodes[id] : undefined;
        if (!n) return reject('unknown-node');
        // hup(): "%x ignoring MsgHup because already leader"
        if (n.role === 'leader') return reject('already-leader');

        // becomeCandidate(): reset(Term+1) then Vote = self.
        const updated = { ...n, role: 'candidate', term: n.term + 1, vote: id };
        model.nodes = { ...model.nodes, [id]: updated };
      },

      // Step(): term handling, then the MsgVote case.
      HandleVoteRequest: (model) => (proposal, { reject }) => {
        const p = proposal || {};
        const id = p.node;
        const n = id != null ? model.nodes[id] : undefined;
        if (!n) return reject('unknown-node');
        if (typeof p.term !== 'number' || typeof p.index !== 'number' || typeof p.logTerm !== 'number') {
          return reject('malformed-proposal');
        }

        // The candidate's log recency must be judged against the log as it is
        // BEFORE any term bump caused by this same message.
        const upToDate = isUpToDate(n, p.logTerm, p.index);

        let next = n;
        if (p.term < n.term) {
          // "ignored a %s message with lower term" -> only a rejection response
          // is emitted; no observable state changes.
          return reject('stale-term');
        }
        if (p.term > n.term) {
          // MsgVote with a higher term: becomeFollower(m.Term, None).
          next = becomeFollower(n, p.term);
        }

        // canVote: repeat of a vote already cast, or no vote yet in this term.
        // (The leader-known check is not observable here; a node that has just
        // stepped down to the new term has neither a vote nor a leader.)
        const canVote = next.vote === p.from || next.vote === NONE;

        if (canVote && upToDate) {
          // Grant: MsgVote records the vote (electionElapsed reset is not
          // observable).
          next = { ...next, vote: p.from };
        } else if (next === n) {
          // Nothing changed at all: the rejection response is the only effect.
          return reject(canVote ? 'candidate-log-not-up-to-date' : 'already-voted-this-term');
        }

        model.nodes = { ...model.nodes, [id]: next };
      },

      // stepLeader(MsgProp) -> appendEntry(); followers/candidates drop or
      // forward the proposal, which is not observable locally.
      ClientProposal: (model) => (proposal, { reject }) => {
        const id = proposal && proposal.node;
        const n = id != null ? model.nodes[id] : undefined;
        if (!n) return reject('unknown-node');
        if (n.role !== 'leader') return reject('not-leader');

        const updated = { ...n, log: n.log + 1 };
        model.nodes = { ...model.nodes, [id]: updated };
      },

      // Step() term handling + stepFollower/stepCandidate(MsgApp) ->
      // handleAppendEntries().
      HandleAppendEntries: (model) => (proposal, { reject }) => {
        const p = proposal || {};
        const id = p.node;
        const n = id != null ? model.nodes[id] : undefined;
        if (!n) return reject('unknown-node');
        if (
          typeof p.term !== 'number' ||
          typeof p.index !== 'number' ||
          typeof p.logTerm !== 'number' ||
          typeof p.entries !== 'number' ||
          typeof p.commit !== 'number'
        ) {
          return reject('malformed-proposal');
        }

        if (p.term < n.term) {
          // Lower-term MsgApp: only a MsgAppResp is emitted.
          return reject('stale-term');
        }

        const prevTerm = lastLogTerm(n);

        let next = n;
        if (p.term > n.term) {
          // MsgApp with higher term: becomeFollower(m.Term, m.From).
          next = becomeFollower(n, p.term);
        } else if (n.role !== 'follower') {
          // stepCandidate(MsgApp): becomeFollower(m.Term, m.From) at the same
          // term (leaders never see a same-term MsgApp).
          next = { ...n, role: 'follower' };
        }

        // handleAppendEntries(): a stale prefix is answered with the commit
        // index and nothing is appended.
        if (p.index < next.commit) {
          if (next === n) return reject('append-below-commit');
          model.nodes = { ...model.nodes, [id]: next };
          return;
        }

        // raftLog.maybeAppend(): the prev entry must match.
        const matches = p.index <= next.log && p.logTerm === (p.index === 0 ? 0 : prevTerm);
        if (!matches) {
          // Rejected MsgApp: a hint is returned, the log is untouched.
          if (next === n) return reject('log-mismatch-at-prev-entry');
          model.nodes = { ...model.nodes, [id]: next };
          return;
        }

        const lastNewIndex = p.index + p.entries;
        const newLog = Math.max(next.log, lastNewIndex);
        // commitTo(min(m.Commit, lastnewi)) — monotonic.
        const newCommit = Math.max(next.commit, Math.min(p.commit, lastNewIndex));

        next = { ...next, log: newLog, commit: newCommit };
        model.nodes = { ...model.nodes, [id]: next };
      },

      // Step() term handling + stepFollower/stepCandidate(MsgHeartbeat) ->
      // handleHeartbeat().
      HandleHeartbeat: (model) => (proposal, { reject }) => {
        const p = proposal || {};
        const id = p.node;
        const n = id != null ? model.nodes[id] : undefined;
        if (!n) return reject('unknown-node');
        if (typeof p.term !== 'number' || typeof p.commit !== 'number') {
          return reject('malformed-proposal');
        }

        if (p.term < n.term) return reject('stale-term');

        let next = n;
        if (p.term > n.term) {
          next = becomeFollower(n, p.term);
        } else if (n.role === 'candidate') {
          next = { ...n, role: 'follower' };
        } else if (n.role === 'leader') {
          // stepLeader has no MsgHeartbeat case: the message is dropped.
          return reject('leader-ignores-heartbeat');
        }

        // raftLog.commitTo(m.Commit): only advances, and never past the last
        // index of the local log.
        const target = Math.min(p.commit, next.log);
        if (target > next.commit) {
          next = { ...next, commit: target };
        }

        if (next === n) return reject('heartbeat-no-op');
        model.nodes = { ...model.nodes, [id]: next };
      },
    },
    reactors: [],
  },
});

const { intents } = control;

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };
const init = () => { setState(INITIAL_STATE); };

const actions = {
  ElectionTimeout: (data = {}) => intents.ElectionTimeout(data),
  HandleVoteRequest: (data = {}) => intents.HandleVoteRequest(data),
  ClientProposal: (data = {}) => intents.ClientProposal(data),
  HandleAppendEntries: (data = {}) => intents.HandleAppendEntries(data),
  HandleHeartbeat: (data = {}) => intents.HandleHeartbeat(data),
};

module.exports = { instance, init, actions, getState, setState };
