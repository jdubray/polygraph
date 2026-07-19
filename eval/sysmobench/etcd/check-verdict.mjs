// Classify a `scripts/check.mjs` run from its output. Shared by mutate.mjs and
// score-generated.mjs so the two report the same thing the same way.
//
// THIS EXISTS BECAUSE A LOOSE MATCH SILENTLY INVERTED A MEASUREMENT. Both
// harnesses originally tested `/violat/i` against the output — which matches
// the word "violations" inside check.mjs's CLEAN message:
//
//     no invariant violations reachable ✓
//
// So every run classified as "violated", the mutation score read 8/8, and the
// generated-spec table reported the reference specification itself as
// violating an invariant it does not violate. The control row is what exposed
// it: the reference was scored on identical terms precisely so a broken
// measurement could not pass as a finding.
//
// Match the exact markers instead, clean first, and treat anything
// unrecognised as an error rather than guessing.
'use strict';

/** @returns {'clean'|'bounded'|'violated'|'error'} */
export function classifyCheck(out) {
  const s = String(out ?? '');
  // Clean is checked FIRST and by its exact phrase: it contains the substring
  // "violations", so any looser test misreads it as a failure.
  if (/no invariant violations reachable/i.test(s)) {
    // A clean result over a truncated space is not a pass — this project's
    // doctrine, enforced rather than assumed.
    return /CAP HIT/i.test(s) ? 'bounded' : 'clean';
  }
  if (/\d+\s+invariant violation\(s\)/i.test(s) || /^\s*✗\s/m.test(s)) return 'violated';
  return 'error';
}
