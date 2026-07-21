// Adapters: a Polygraph artifacts directory → viz-model (spec §4.3). The only
// Polygraph-coupled stage. An optional `polyviz.annotations.json` in the dir
// supplies narrative overrides (titles, labels) the raw artifacts don't carry.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { adaptCompat } from './compat.mjs';
import { deriveMachine } from './machine.mjs';
import { adaptInvariants } from './invariants.mjs';
import { adaptCounterexample, rejectReason } from './counterexample.mjs';

// Bounded recursive search for a named artifact file (reports often nest under
// reports/<changeId>/). Returns the first match, or null.
function findFile(dir, name, depth = 3) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name);
  if (depth > 0) {
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        const found = findFile(join(dir, e.name), name, depth - 1);
        if (found) return found;
      }
    }
  }
  return null;
}

// All matches of a named file (bounded depth), for picking among several.
function findAllFiles(dir, name, depth = 3, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) if (e.isFile() && e.name === name) acc.push(join(dir, e.name));
  if (depth > 0) {
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        findAllFiles(join(dir, e.name), name, depth - 1, acc);
      }
    }
  }
  return acc;
}

function loadAnnotations(dir) {
  const p = findFile(dir, 'polyviz.annotations.json', 1);
  return p ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

const DEFAULT_META = { brand: 'COGNITIVE FAB · POLYGRAPH', footer: "verify, don't review", theme: 'dark' };

/**
 * Build a viz-model from a Polygraph/polyvers artifacts directory. Each
 * recognized artifact contributes one section. Throws if none are found.
 */
export async function adaptDir(dir, { log = () => {} } = {}) {
  const ann = loadAnnotations(dir);
  const model = { meta: { ...DEFAULT_META, ...(ann.meta ?? {}) } };
  const matched = [];

  // machine ← contract.json + its SAM module (transitions derived by BFS).
  const contractPath = findFile(dir, 'contract.json');
  if (contractPath) {
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    const modulePath = resolveModulePath(contractPath, contract);
    if (modulePath) {
      const { states, transitions } = deriveMachine(contract, modulePath, { log });
      model.machine = { ...(ann.machine ?? {}), states, transitions };
      matched.push('contract.json + module → machine');
    } else {
      log(`polyviz: found contract.json but no transition module (next.cjs) — skipping machine`);
    }

    // invariants ← the module referenced by contract.invariants (or invariants.mjs).
    const invPath = findFile(dirname(contractPath), contract.invariants ?? 'invariants.mjs', 0)
      ?? findFile(dir, 'invariants.mjs');
    if (invPath) {
      model.invariants = await adaptInvariants(invPath, { annotations: ann.invariants ?? {} });
      matched.push('invariants.mjs → invariants');
    }
  }

  // counterexample ← a findings.json with a failure, resolved to its trace file.
  // Prefer a findings.json that actually reports failures (a clean run has none).
  const findingsFiles = findAllFiles(dir, 'findings.json');
  const cePath = findingsFiles.find((p) => (JSON.parse(readFileSync(p, 'utf8')).findings ?? []).length) ?? findingsFiles[0];
  if (cePath) {
    const findings = JSON.parse(readFileSync(cePath, 'utf8'));
    const fail = (findings.findings ?? [])[0];
    const traceName = ann.counterexample?.trace ?? fail?.scenario;
    const tracePath = traceName ? findFile(dir, traceName) : null;
    if (tracePath) {
      const trace = readFileSync(tracePath, 'utf8');
      model.trace = adaptCounterexample(trace, {
        annotations: ann.counterexample ?? {},
        violationIndex: ann.counterexample?.violationIndex ?? fail?.index,
        reason: rejectReason(fail?.classifications?.find((c) => /rejected/.test(c)))
      });
      matched.push(`${traceName} → counterexample`);
    } else if (traceName) {
      log(`polyviz: findings.json names scenario "${traceName}" but its trace file was not found — skipping counterexample`);
    }
  }

  // compat ← polyvers compat-report.json.
  const compatPath = findFile(dir, 'compat-report.json');
  if (compatPath) {
    const report = JSON.parse(readFileSync(compatPath, 'utf8'));
    model.compat = adaptCompat(report, { annotations: ann.compat ?? {}, log });
    matched.push('compat-report.json → compat');
  }

  if (!matched.length) {
    throw new Error(`no recognized Polygraph artifacts in ${dir} (looked for: contract.json, invariants.mjs, compat-report.json)`);
  }
  log(`polyviz: adapted ${matched.join('; ')}`);
  return model;
}

// Resolve the SAM/next module next to a contract (next.cjs by convention).
function resolveModulePath(contractPath, contract) {
  const dir = dirname(contractPath);
  const candidates = [contract.module, contract.spec, 'next.cjs', 'next.js', 'spec.cjs'].filter(Boolean);
  for (const name of candidates) {
    const p = findFile(dir, name, 0);
    if (p) return p;
  }
  return null;
}
