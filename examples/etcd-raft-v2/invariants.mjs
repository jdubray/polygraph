// State invariants for the etcd/raft v2 fixture, written as plain JS
// predicates over the observable state — the Polygraph invariants format
// (see templates/contract.schema.json "invariants").
//
// These stay inside scripts/to-tla.mjs's translatable invariant subset
// (Object.values/keys/entries + every/some quantification, field reads,
// comparisons, includes() membership), so the TLC tier can carry them into
// the transpiled module as TLA+ INVARIANTs. check.mjs consumes the same
// predicates directly in JS.
export const stateInvariants = [
  {
    // every leader is unique within its term
    name: 'OneLeaderPerTerm',
    pred: (s) =>
      Object.entries(s.nodes).every(([i, a]) =>
        Object.entries(s.nodes).every(([j, b]) =>
          i === j || !(a.role === 'leader' && b.role === 'leader' && a.term === b.term))),
  },
  {
    // a node never commits past the end of its log
    name: 'CommitWithinLog',
    pred: (s) => Object.values(s.nodes).every((n) => n.commit <= n.log),
  },
  {
    // votedFor is a known node id or '0' (none)
    name: 'ValidVote',
    pred: (s) =>
      Object.values(s.nodes).every(
        (n) => n.vote === '0' || Object.keys(s.nodes).includes(n.vote)),
  },
];

export const transitionInvariants = [];
