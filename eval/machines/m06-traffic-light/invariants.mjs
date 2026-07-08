// Clean machine. Correct intent: the light is always one of the three valid
// colours. This HOLDS for the faithful model — no violation (false-alarm control).
export const stateInvariants = [
  { name: 'light-is-valid-colour', pred: (s) => ['red', 'green', 'yellow'].includes(s.light) },
];
export const transitionInvariants = [];
