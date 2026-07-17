// polyrun continuous audit (M2, FR-7.2) — the production drift detector.
//
// The journal IS a Polygraph trace corpus: every accepted step is a window
// {pre, action, data, post}. The audit replays each window through the
// machine module via the pipeline's own adapter semantics (reset-then-merge,
// rejection = observable no-op) and reports any window where the module,
// today, disagrees with what production recorded — i.e. drift between the
// deployed composition and the verified model (a hot-patched module, manual
// DB edits, or a bug in the harness itself).
//
// Pure local execution, no API key (NFR-6).
'use strict';

import { createRequire } from 'node:module';
import { stable } from '../../scripts/load-spec.mjs';

const require_ = createRequire(import.meta.url);
const { makeSamAdapter } = require_('../../scripts/sam-adapter.cjs');

/**
 * Audit instances of one machine. Options: { runtime, machineId,
 * sinceMs? (only steps at >= sinceMs), instanceId? (just one) }.
 * Returns { instancesAudited, windowsReplayed, mismatches: [...] }.
 */
export async function auditMachine({ runtime, machineId, sinceMs = 0, instanceId }) {
  const machine = runtime.machines.get(machineId);
  if (!machine) throw new Error(`unknown machine '${machineId}'`);
  const adapter = makeSamAdapter(machine.mod);

  const instances = instanceId
    ? [await runtime.store.getInstance(instanceId)].filter(Boolean)
    : await runtime.list(machineId);

  const mismatches = [];
  let windowsReplayed = 0;

  for (const inst of instances) {
    const journal = await runtime.getJournal(inst.instance_id);
    for (const row of journal) {
      if (row.at < sinceMs) continue;
      if (row.action === '$create') continue;
      if (row.step_kind === 'accepted') {
        windowsReplayed += 1;
        let replayed;
        try {
          replayed = adapter.next(row.pre, row.action, row.data);
        } catch (err) {
          mismatches.push({ instanceId: inst.instance_id, seq: row.seq, action: row.action, kind: 'replay-threw', detail: err.message });
          continue;
        }
        if (stable(replayed) !== stable(row.post)) {
          mismatches.push({
            instanceId: inst.instance_id, seq: row.seq, action: row.action,
            kind: 'post-mismatch',
            detail: `journal post ${JSON.stringify(row.post)} vs module ${JSON.stringify(replayed)}`,
          });
        }
      } else if (row.step_kind === 'rejected' && !['terminal', 'poisoned'].includes(row.reject_reason ?? '')) {
        // A journaled rejection must still BE a rejection today (post == pre
        // under replay). A module that now ACCEPTS it has drifted too.
        windowsReplayed += 1;
        try {
          const replayed = adapter.next(row.pre, row.action, row.data);
          if (stable(replayed) !== stable(row.pre)) {
            mismatches.push({
              instanceId: inst.instance_id, seq: row.seq, action: row.action,
              kind: 'reject-now-accepts',
              detail: `journaled as rejected('${row.reject_reason}') but module now transitions to ${JSON.stringify(replayed)}`,
            });
          }
        } catch (err) {
          // ONLY a schema throw is expected here (the kernel journals
          // SamSchemaError payloads as clean rejections; replay re-fires the
          // intent and the schema throw recurs). Anything else — action
          // removed from the surface, acceptor now throwing where it used to
          // reject, mutate-then-reject defects — is drift.
          if (!err || err.name !== 'SamSchemaError') {
            mismatches.push({ instanceId: inst.instance_id, seq: row.seq, action: row.action, kind: 'replay-threw', detail: String(err && err.message) });
          }
        }
      } else if (row.step_kind === 'unhandled') {
        // An action journaled as unhandled must still be unhandled: a module
        // that now transitions on it has drifted.
        windowsReplayed += 1;
        try {
          const replayed = adapter.next(row.pre, row.action, row.data);
          if (stable(replayed) !== stable(row.pre)) {
            mismatches.push({
              instanceId: inst.instance_id, seq: row.seq, action: row.action,
              kind: 'unhandled-now-transitions',
              detail: `journaled as unhandled but module now transitions to ${JSON.stringify(replayed)}`,
            });
          }
        } catch { /* still not in the surface / still unhandled — consistent */ }
      }
    }
  }

  return { instancesAudited: instances.length, windowsReplayed, mismatches };
}

export function renderAudit(machineId, result) {
  const lines = [];
  lines.push(`audit ${machineId}: ${result.instancesAudited} instance(s), ${result.windowsReplayed} window(s) replayed`);
  if (result.mismatches.length === 0) {
    lines.push('drift: NONE — production journal matches the module');
  } else {
    for (const m of result.mismatches) {
      lines.push(`DRIFT ${m.kind} at ${m.instanceId}#${m.seq} ${m.action}: ${m.detail}`);
    }
  }
  return lines.join('\n');
}
