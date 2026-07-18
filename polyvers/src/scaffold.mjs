// polyvers migrate scaffold (M2) — generate a migrate.cjs skeleton from the
// shape diff between two versions.
//
// The scaffold is COMPLETE for pure-addition changes (new keys initialized
// from the new contract's initState) and leaves explicit throwing TODO holes
// for retyped keys — a hole a human has not filled must fail the migrate
// gate loudly, never pass as an accidental identity. Removed keys are
// dropped with a note.
//
// Deterministic, no API key. (An LLM-drafted fill of the TODO holes,
// polygen-style with self-repair against the migrate gate, is the recorded
// follow-up — the scaffold is the contract it would be verified against.)
'use strict';

import { observableKeys } from './artifacts.mjs';

/**
 * scaffoldMigrate(oldA, newA) → { code, notes }
 * Throws when the shape diff is empty (nothing to migrate).
 */
export function scaffoldMigrate(oldA, newA) {
  const oldKeys = observableKeys(oldA.contract) ?? [];
  const newKeys = observableKeys(newA.contract) ?? [];
  const added = newKeys.filter((k) => !oldKeys.includes(k));
  const removed = oldKeys.filter((k) => !newKeys.includes(k));
  const oldTypes = new Map((oldA.contract.stateKeys ?? []).map((k) => [k.name, String(k.type ?? '')]));
  const newTypes = new Map((newA.contract.stateKeys ?? []).map((k) => [k.name, String(k.type ?? '')]));
  const retyped = oldKeys.filter((k) => newKeys.includes(k) && oldTypes.get(k) !== newTypes.get(k));
  if (!added.length && !removed.length && !retyped.length) {
    throw new Error('scaffold: the contracts declare no shape difference — nothing to migrate');
  }
  const carried = newKeys.filter((k) => oldKeys.includes(k) && !retyped.includes(k));

  const init = newA.contract.initState ?? {};
  const notes = [];
  const lines = [];
  lines.push("'use strict';");
  lines.push(`// migrate.cjs — SCAFFOLDED by polyvers from the shape diff`);
  lines.push(`// ${oldA.versionHash} → ${newA.versionHash}.`);
  lines.push('// Pure by contract: (oldState) → newState, no I/O, no clock — the migrate');
  lines.push('// gate enforces determinism by double application.');
  lines.push('module.exports.migrate = function migrate(oldState) {');
  lines.push('  const next = {};');
  if (carried.length) {
    lines.push(`  // carried over unchanged`);
    for (const k of carried) lines.push(`  next[${JSON.stringify(k)}] = oldState[${JSON.stringify(k)}];`);
  }
  if (added.length) {
    lines.push(`  // added in the new shape — initialized from the new contract's initState`);
    for (const k of added) {
      if (!(k in init)) notes.push(`added key '${k}' has no initState default — the scaffold throws until a human supplies the value`);
      lines.push(k in init
        ? `  next[${JSON.stringify(k)}] = ${JSON.stringify(init[k])};`
        : `  next[${JSON.stringify(k)}] = (() => { throw new Error(${JSON.stringify(`TODO(human): value for added key '${k}' (no initState default)`)}); })();`);
    }
  }
  if (removed.length) {
    lines.push(`  // removed from the new shape (intentionally dropped): ${removed.join(', ')}`);
    notes.push(`removed key(s) dropped: ${removed.join(', ')} — if the value must survive (fold into another key), edit before applying`);
  }
  for (const k of retyped) {
    notes.push(`retyped key '${k}' (${oldTypes.get(k)} → ${newTypes.get(k)}) — the scaffold throws until a human writes the conversion`);
    lines.push(`  // retyped: ${oldTypes.get(k)} → ${newTypes.get(k)}`);
    lines.push(`  next[${JSON.stringify(k)}] = (() => { throw new Error(${JSON.stringify(`TODO(human): convert '${k}' (${oldTypes.get(k)} → ${newTypes.get(k)})`)}); })();`);
  }
  lines.push('  return next;');
  lines.push('};');
  return { code: lines.join('\n') + '\n', notes, added, removed, retyped };
}

export function migrationNoteTemplate(oldA, newA, scaffold) {
  return [
    `# MIGRATION-NOTE — ${oldA.versionHash} → ${newA.versionHash}`,
    '',
    '## Why the shape changed',
    '',
    'TODO(human): one paragraph.',
    '',
    '## What each hole maps',
    '',
    ...(scaffold.notes.length ? scaffold.notes.map((n) => `- ${n}`) : ['- (scaffold was complete — pure addition)']),
    '',
    '## Meaning-gap instances',
    '',
    'TODO(human): named instances (if any) with no honest image in the new',
    'shape, and what was decided about them. Delete this section if none.',
    '',
  ].join('\n');
}
