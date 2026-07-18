// polyvers cross-machine version PRODUCT matrix (composition plan CP-M3) —
// the piece the protocol/delivery matrix (matrix.mjs) recorded as open:
// "no reachable interleaving of parent-vN and child-vM violates a
// cross-machine invariant".
//
// For each rollout-window pairing (parent {old,new} × child {old,new}) this
// runs the FULL joint-state product check (polyrun/src/check-product.mjs):
// exhaustive BFS over (parent, children) joint states, each transition one
// external stimulus plus its deterministic kernel cascade closure, checked
// against the caller's cross-machine invariants plus the built-in doctrine
// classes (reachable poison, unhandled cascade delivery, unnamed rejects,
// childKey collisions). Identical version pairings are explored once (the
// routine child-only-change run explores 2 cells, not 4).
//
// Honest scope, disclosed in every report:
// - each pairing is explored from GENESIS (parent init, no children) under
//   that version pair — the mixed-version histories a mid-rollout fleet
//   holds (parent-old spawned the child, parent-new receives its
//   completion) are covered only insofar as they are reachable from genesis
//   under the pairing; seeding the JOINT space from live fleet snapshots
//   needs a polyrun joint-export (parent + linked children in one snapshot)
//   and is a recorded follow-up (docs/composition-plan.md);
// - the per-machine mid-flight surface is already covered by the seeded
//   semantic gate (`polyvers check --snapshots`), and the protocol/delivery
//   surface by `polyvers matrix` — this closes the joint-interleaving class
//   on top of both, not instead of them.
//
// Deterministic, no API key. A BOUNDED cell is a failing cell unless the
// operator explicitly accepts it — uniform doctrine.
'use strict';

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { findModulePath } from './artifacts.mjs';
import { checkProduct, renderProduct } from '../../polyrun/src/check-product.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Version identity for memoization, from artifact BYTES only (no module
 *  execution): module + contract + mapper + manifest. */
function versionKeyOf(dir, { needMapper }) {
  const abs = resolve(dir);
  const modulePath = findModulePath(abs);
  const contractPath = join(abs, 'contract.json');
  if (!existsSync(contractPath)) throw new Error(`'${abs}' has no contract.json`);
  const mapperPath = join(abs, 'effects.cjs');
  if (needMapper && !existsSync(mapperPath)) {
    throw new Error(`'${abs}' has no effects.cjs — the parent's mapper IS the cascade; the product of a parent that spawns nothing is the single-machine check (\`polyvers check\`)`);
  }
  const manifestPath = join(abs, 'effects.manifest.json');
  const parts = [
    sha256(readFileSync(modulePath)),
    sha256(readFileSync(contractPath)),
    existsSync(mapperPath) ? sha256(readFileSync(mapperPath)) : '',
    existsSync(manifestPath) ? sha256(readFileSync(manifestPath)) : '',
  ];
  return {
    hash: sha256(parts.join('\n')).slice(0, 12),
    modulePath,
    contractPath,
    mapperPath: existsSync(mapperPath) ? mapperPath : null,
    manifestPath: existsSync(manifestPath) ? manifestPath : null,
  };
}

/**
 * runProductMatrix({ parentOldDir, parentNewDir, childOldDir, childNewDir,
 *                    childMachineId, invariants, maxStates?, allowBounded?,
 *                    abstractChild?, abstractMaxStates? })
 * `invariants` is the path to an invariants.compose.mjs (semantics §5).
 * `abstractChild: true` abstracts the child in every pairing (semantics §7).
 * Returns { ok, cells, uniquePairings, allowBounded }.
 */
export async function runProductMatrix(opts) {
  const {
    parentOldDir, parentNewDir, childOldDir, childNewDir,
    childMachineId, invariants, maxStates, allowBounded = false,
    abstractChild = false, abstractMaxStates,
  } = opts;
  if (!childMachineId) throw new Error('runProductMatrix: childMachineId is required (the id the parent mapper spawns)');
  if (!invariants) throw new Error('runProductMatrix: an invariants.compose.mjs path is required — a product check with nothing to check would pass vacuously');

  const parents = [['parent-old', versionKeyOf(parentOldDir, { needMapper: true })],
                   ['parent-new', versionKeyOf(parentNewDir, { needMapper: true })]];
  const children = [['child-old', versionKeyOf(childOldDir, { needMapper: false })],
                    ['child-new', versionKeyOf(childNewDir, { needMapper: false })]];

  const memo = new Map(); // parentHash×childHash -> cell result body
  const cells = [];
  for (const [pl, p] of parents) {
    for (const [cl, c] of children) {
      const key = `${p.hash}×${c.hash}`;
      if (!memo.has(key)) {
        let body;
        try {
          const result = await checkProduct({
            parent: { machineId: 'parent', module: p.modulePath, contract: p.contractPath, mapper: p.mapperPath, ...(p.manifestPath ? { manifest: p.manifestPath } : {}) },
            children: [{ machineId: childMachineId, module: c.modulePath, contract: c.contractPath }],
            invariants,
            ...(maxStates !== undefined ? { maxStates } : {}),
            ...(abstractChild ? { abstractChildren: [childMachineId] } : {}),
            ...(abstractMaxStates !== undefined ? { abstractMaxStates } : {}),
          });
          body = {
            ok: result.violations.length === 0 && (!result.capHit || allowBounded),
            capHit: result.capHit,
            statesExplored: result.statesExplored,
            violations: result.violations,
            notes: result.notes,
            abstracted: result.abstracted,
            rendered: renderProduct(result),
          };
        } catch (err) {
          // A refusal (abstraction refused, terminal metadata missing, child
          // mapper present, …) fails the CELL with the reason — never the
          // whole matrix with a bare stack.
          body = { ok: false, refused: String(err && err.message), capHit: false, statesExplored: 0, violations: [], notes: [] };
        }
        memo.set(key, body);
      }
      cells.push({ pairing: `${pl} × ${cl}`, versionKey: key, ...memo.get(key) });
    }
  }
  return { ok: cells.every((x) => x.ok), cells, uniquePairings: memo.size, allowBounded };
}

export function renderProductMatrix(result) {
  const lines = ['# polyvers product — parent × child JOINT-state model check per version pairing', ''];
  lines.push(`> ${result.uniquePairings} unique version pairing(s) explored (identical pairings reuse one exploration)`);
  lines.push('');
  lines.push('| pairing | verdict | joint states |');
  lines.push('|---|---|---|');
  for (const c of result.cells) {
    const verdict = c.ok
      ? (c.capHit ? 'PASS (BOUNDED — accepted)' : 'PASS')
      : c.refused ? '**REFUSED**' : `**FAIL** (${c.violations.length || (c.capHit ? 'BOUNDED' : '?')})`;
    lines.push(`| ${c.pairing} | ${verdict} | ${c.statesExplored} |`);
  }
  lines.push('');
  const failing = result.cells.filter((c) => !c.ok);
  const seenKey = new Set();
  for (const c of failing) {
    lines.push(`## ${c.pairing}`);
    if (seenKey.has(c.versionKey)) {
      lines.push(`(same version pairing as above — same findings)`);
      lines.push('');
      continue;
    }
    seenKey.add(c.versionKey);
    if (c.refused) {
      lines.push(`REFUSED: ${c.refused}`);
    } else {
      lines.push('```');
      lines.push(c.rendered);
      lines.push('```');
    }
    lines.push('');
  }
  lines.push(`## Verdict: ${result.ok ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('> Scope note: this is the JOINT product model check per version pairing —');
  lines.push('> the interleaving class the protocol/delivery matrix recorded as open is');
  lines.push('> now checked, from genesis under each pairing. Mid-flight JOINT seeding');
  lines.push('> (parent + linked children snapshots) is a recorded follow-up');
  lines.push('> (docs/composition-plan.md); per-machine mid-flight states are covered by');
  lines.push('> the seeded semantic gate, protocol/delivery by `polyvers matrix`.');
  lines.push('');
  return lines.join('\n');
}
