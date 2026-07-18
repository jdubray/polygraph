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
// Version identity is the package's ONE canonical identity —
// loadArtifacts().versionHash (artifacts.mjs) — so `polyvers product`,
// `check`, and `matrix` can never disagree about whether two dirs are the
// same version. That identity carries artifacts.mjs's recorded limitation:
// it hashes each artifact's ENTRY file only, so a module split across
// require()d helper files memoizes by its entry file alone — disclosed in
// every report, because here the hash is load-bearing (it decides which
// pairings share one exploration).
//
// Refusal doctrine: an unloadable/invalid VERSION DIR fails every cell that
// uses it (the other cells still run); a per-pairing refusal from the
// checker (abstraction refused, child has its own mapper, terminal metadata
// missing) fails that CELL. Only operator-input errors that poison every
// cell identically (an unloadable --invariants module) fail the whole run,
// so they read as configuration errors rather than compatibility evidence.
//
// Honest scope, disclosed in every report:
// - each pairing is explored from GENESIS (parent init, no children) under
//   that version pair — the mixed-version histories a mid-rollout fleet
//   holds are covered only insofar as they are reachable from genesis under
//   the pairing; seeding the JOINT space from live fleet snapshots needs a
//   polyrun joint-export (parent + linked children in one snapshot) and is
//   a recorded follow-up (docs/composition-plan.md);
// - the per-machine mid-flight surface is already covered by the seeded
//   semantic gate (`polyvers check --snapshots`), and the protocol/delivery
//   surface by `polyvers matrix` — this closes the joint-interleaving class
//   on top of both, not instead of them.
//
// Deterministic, no API key. A BOUNDED cell is a failing cell unless the
// operator explicitly accepts it — uniform doctrine.
'use strict';

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadArtifacts, findModulePath } from './artifacts.mjs';
import { checkProduct, renderProduct } from '../../polyrun/src/check-product.mjs';

/** Load one version dir through the package's canonical loader; returns
 *  { ok: true, versionHash, paths } or { ok: false, error } — a broken dir
 *  fails its CELLS, never the whole matrix. */
async function loadVersionDir(dir, { needMapper }) {
  try {
    const abs = resolve(dir);
    const a = await loadArtifacts(abs);
    if (needMapper && !a.mapper) {
      throw new Error(`'${abs}' has no effects.cjs — the parent's mapper IS the cascade; the product of a parent that spawns nothing is the single-machine check (\`polyvers check\`)`);
    }
    const mapperPath = join(abs, 'effects.cjs');
    const manifestPath = join(abs, 'effects.manifest.json');
    return {
      ok: true,
      versionHash: a.versionHash,
      paths: {
        module: findModulePath(abs),
        contract: join(abs, 'contract.json'),
        mapper: existsSync(mapperPath) ? mapperPath : null,
        manifest: existsSync(manifestPath) ? manifestPath : null,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

/**
 * runProductMatrix({ parentOldDir, parentNewDir, childOldDir, childNewDir,
 *                    parentMachineId, childMachineId, invariants,
 *                    maxStates?, allowBounded?, abstractChild?,
 *                    abstractMaxStates? })
 * `parentMachineId`/`childMachineId` are the REAL machine ids — they are
 * invariant-visible (joint.parent.machineId), so a placeholder would make
 * identity-guarded compose invariants pass vacuously.
 * `invariants` is the path to an invariants.compose.mjs (semantics §5) —
 * loaded ONCE; an unloadable module is a whole-run configuration error.
 * `abstractChild: true` abstracts the child in every pairing (semantics §7).
 * Returns { ok, cells, uniquePairings, allowBounded }.
 */
export async function runProductMatrix(opts) {
  const {
    parentOldDir, parentNewDir, childOldDir, childNewDir,
    parentMachineId, childMachineId, invariants, maxStates,
    allowBounded = false, abstractChild = false, abstractMaxStates,
  } = opts;
  if (!parentMachineId || !childMachineId) throw new Error('runProductMatrix: parentMachineId and childMachineId are required (real ids — they are invariant-visible in the joint state)');
  if (!invariants) throw new Error('runProductMatrix: an invariants.compose.mjs path is required — a product check with nothing to check would pass vacuously');

  // Operator input, validated ONCE up front: a broken compose module must be
  // one configuration error, never a matrix of per-pairing REFUSED cells.
  let invObj;
  try {
    const invMod = await import(pathToFileURL(resolve(invariants)).href);
    invObj = invMod.default ?? invMod;
  } catch (err) {
    throw new Error(`cannot load the cross-machine invariants module '${invariants}': ${err && err.message}`);
  }

  const parents = [['parent-old', await loadVersionDir(parentOldDir, { needMapper: true })],
                   ['parent-new', await loadVersionDir(parentNewDir, { needMapper: true })]];
  const children = [['child-old', await loadVersionDir(childOldDir, { needMapper: false })],
                    ['child-new', await loadVersionDir(childNewDir, { needMapper: false })]];

  const memo = new Map(); // versionHash×versionHash -> cell body
  const cells = [];
  for (const [pl, p] of parents) {
    for (const [cl, c] of children) {
      if (!p.ok || !c.ok) {
        cells.push({
          pairing: `${pl} × ${cl}`, versionKey: null, ok: false,
          refused: [!p.ok ? `${pl}: ${p.error}` : null, !c.ok ? `${cl}: ${c.error}` : null].filter(Boolean).join('; '),
        });
        continue;
      }
      const key = `${p.versionHash}×${c.versionHash}`;
      if (!memo.has(key)) {
        let body;
        try {
          const result = await checkProduct({
            parent: { machineId: parentMachineId, module: p.paths.module, contract: p.paths.contract, mapper: p.paths.mapper, manifest: p.paths.manifest ?? undefined },
            // mapper passed through so checkProduct's child-mapper refusal
            // FIRES (a child with its own effects.cjs is an unmodeled fleet
            // — certifying it would be unsound).
            children: [{ machineId: childMachineId, module: c.paths.module, contract: c.paths.contract, mapper: c.paths.mapper ?? undefined }],
            invariants: invObj,
            maxStates,
            abstractChildren: abstractChild ? [childMachineId] : [],
            abstractMaxStates,
          });
          body = {
            ok: result.violations.length === 0 && (!result.capHit || allowBounded),
            capHit: result.capHit,
            statesExplored: result.statesExplored,
            violations: result.violations,
            notes: result.notes,
            abstracted: result.abstracted,
            result, // rendered lazily, and only for failing cells
          };
        } catch (err) {
          // A per-pairing refusal from the checker (abstraction refused,
          // child mapper present, terminal metadata missing, model
          // limitation) fails the CELL with the reason.
          body = { ok: false, refused: String(err && err.message) };
        }
        memo.set(key, body);
      }
      cells.push({ pairing: `${pl} × ${cl}`, versionKey: key, ...memo.get(key) });
    }
  }
  return { ok: cells.every((x) => x.ok), cells, uniquePairings: memo.size, allowBounded };
}

/** The --json shape: cells without the internal result object. */
export function productMatrixJson(result) {
  return {
    ok: result.ok,
    uniquePairings: result.uniquePairings,
    allowBounded: result.allowBounded,
    cells: result.cells.map(({ result: _r, ...rest }) => rest),
  };
}

export function renderProductMatrix(result) {
  const lines = ['# polyvers product — parent × child JOINT-state model check per version pairing', ''];
  lines.push(`> ${result.uniquePairings} unique version pairing(s) explored (identical pairings — by the canonical polyvers versionHash, which hashes each artifact's ENTRY file only — reuse one exploration)`);
  lines.push('');
  lines.push('| pairing | verdict | joint states |');
  lines.push('|---|---|---|');
  for (const c of result.cells) {
    const verdict = c.ok
      ? (c.capHit ? 'PASS (BOUNDED — accepted)' : 'PASS')
      : c.refused ? '**REFUSED**' : `**FAIL** (${c.violations.length || 'BOUNDED'})`;
    lines.push(`| ${c.pairing} | ${verdict} | ${c.refused ? '—' : c.statesExplored} |`);
  }
  lines.push('');
  const detailedAs = new Map(); // versionKey -> pairing label that carries the detail
  for (const c of result.cells.filter((x) => !x.ok)) {
    lines.push(`## ${c.pairing}`);
    if (c.versionKey && detailedAs.has(c.versionKey)) {
      lines.push(`(same version pairing as '${detailedAs.get(c.versionKey)}' — same findings)`);
      lines.push('');
      continue;
    }
    if (c.versionKey) detailedAs.set(c.versionKey, c.pairing);
    if (c.refused) {
      lines.push(`REFUSED: ${c.refused}`);
    } else {
      lines.push('```');
      lines.push(renderProduct(c.result));
      lines.push('```');
    }
    lines.push('');
  }
  lines.push(`## Verdict: ${result.ok ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('> Scope note: this is the JOINT product model check per version pairing —');
  lines.push('> the interleaving class the protocol/delivery matrix recorded as open is');
  lines.push('> now checked, from GENESIS under each pairing. Mid-flight JOINT seeding');
  lines.push('> (parent + linked children snapshots) is a recorded follow-up');
  lines.push('> (docs/composition-plan.md); children with their own mappers are refused');
  lines.push('> (grandchildren are out of scope); per-machine mid-flight states are');
  lines.push('> covered by the seeded semantic gate, protocol/delivery by');
  lines.push('> `polyvers matrix`. Version identity hashes entry files only — a module');
  lines.push('> split across require()d helpers memoizes by its entry file.');
  lines.push('');
  return lines.join('\n');
}
