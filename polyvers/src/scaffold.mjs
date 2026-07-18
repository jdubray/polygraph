// polyvers migrate scaffold (M2) — generate a migrate.cjs skeleton from the
// shape diff between two versions.
//
// The scaffold is COMPLETE for pure-addition changes (new keys initialized
// from the new contract's initState) and leaves explicit throwing TODO holes
// for retyped keys — a hole a human has not filled must fail the migrate
// gate loudly, never pass as an accidental identity. Removed keys are
// dropped with a note.
//
// Works from contracts alone (contract-first authoring: the new module need
// not exist yet), and stamps CONTRACT hashes — never versionHash, which the
// scaffold's own write would change (versionHash includes migrateHash).
//
// Deterministic, no API key. (An LLM-drafted fill of the TODO holes,
// polygen-style with self-repair against the migrate gate, is the recorded
// follow-up — the scaffold is the contract it would be verified against.)
'use strict';

import { observableKeys } from './artifacts.mjs';
import { diffShape } from './classify.mjs';

/**
 * scaffoldMigrate(oldA, newA) → { code, notes, added, removed, retyped }
 * oldA/newA need only { contract, contractHash } (loadContractOnly suffices).
 * Throws when the shape diff is empty (nothing to migrate).
 */
export function scaffoldMigrate(oldA, newA) {
  // ONE definition of "the shape changed" — the same diff classify() lanes on.
  const { added, removed, retyped, changed } = diffShape(oldA, newA);
  if (!changed) {
    throw new Error('scaffold: the contracts declare no shape difference — nothing to migrate');
  }
  const oldKeys = observableKeys(oldA.contract) ?? [];
  const newKeys = observableKeys(newA.contract) ?? [];
  const oldTypes = new Map((oldA.contract.stateKeys ?? []).map((k) => [k.name, String(k.type ?? '')]));
  const newTypes = new Map((newA.contract.stateKeys ?? []).map((k) => [k.name, String(k.type ?? '')]));
  const carried = newKeys.filter((k) => oldKeys.includes(k) && !retyped.includes(k));

  const init = newA.contract.initState ?? {};
  const notes = [];
  const lines = [];
  lines.push("'use strict';");
  lines.push('// migrate.cjs — SCAFFOLDED by polyvers from the shape diff');
  lines.push(`// (old contract ${oldA.contractHash.slice(0, 12)} → new contract ${newA.contractHash.slice(0, 12)}).`);
  lines.push('// Pure by contract: (oldState) → newState, no I/O, no clock — the migrate');
  lines.push('// gate enforces determinism by double application.');
  lines.push('// HOLE: an unfilled TODO fails the migrate gate loudly — each hole throws');
  lines.push('// independently, so deleting one line cannot silently drop a key.');
  lines.push('const HOLE = (msg) => { throw new Error(msg); };');
  lines.push('module.exports.migrate = function migrate(oldState) {');
  lines.push('  const next = {};');
  if (carried.length) {
    lines.push('  // carried over unchanged');
    for (const k of carried) lines.push(`  next[${JSON.stringify(k)}] = oldState[${JSON.stringify(k)}];`);
  }
  if (added.length) {
    lines.push("  // added in the new shape — initialized from the new contract's initState");
    for (const k of added) {
      if (!(k in init)) notes.push(`added key '${k}' has no initState default — the scaffold throws until a human supplies the value`);
      lines.push(k in init
        ? `  next[${JSON.stringify(k)}] = ${JSON.stringify(init[k])};`
        : `  next[${JSON.stringify(k)}] = HOLE(${JSON.stringify(`TODO(human): value for added key '${k}' (no initState default)`)});`);
    }
  }
  if (removed.length) {
    lines.push(`  // removed from the new shape (intentionally dropped): ${removed.join(', ')}`);
    notes.push(`removed key(s) dropped: ${removed.join(', ')} — if the value must survive (fold into another key), edit before applying`);
  }
  for (const k of retyped) {
    notes.push(`retyped key '${k}' (${oldTypes.get(k)} → ${newTypes.get(k)}) — the scaffold throws until a human writes the conversion`);
    lines.push(`  // retyped: ${oldTypes.get(k)} → ${newTypes.get(k)}`);
    lines.push(`  next[${JSON.stringify(k)}] = HOLE(${JSON.stringify(`TODO(human): convert '${k}' (${oldTypes.get(k)} → ${newTypes.get(k)})`)});`);
  }
  lines.push('  return next;');
  lines.push('};');
  return { code: lines.join('\n') + '\n', notes, added, removed, retyped };
}

export function migrationNoteTemplate(oldA, newA, scaffold) {
  return [
    `# MIGRATION-NOTE — contract ${oldA.contractHash.slice(0, 12)} → ${newA.contractHash.slice(0, 12)}`,
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
