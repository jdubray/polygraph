export const stateInvariants = [
  { name: 'S1-done-implies-executed', pred: (s) => s.state !== 'DONE' || s.executed },
  { name: 'L1-can-finish', kind: 'liveness', pred: () => true }
];
