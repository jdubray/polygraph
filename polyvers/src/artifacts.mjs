// polyvers artifact loader — one version of a machine is a directory holding
// the artifact family: contract.json (required), the SAM v2 module (required;
// next.cjs, machine.cjs, or the only .cjs in the dir), invariants.mjs
// (optional), effects.manifest.json (optional).
//
// Loading is content-first: every artifact gets a sha256 so version identity
// can be derived, not declared. Deterministic, no API key.
//
// Known M0 limitation (recorded): versionHash covers the four artifact files
// only. A machine module that requires local helper files is hashed and
// compared by its entry file alone — polygen output is single-file, and
// multi-file machines are out of scope until the dependency graph is walked.
'use strict';

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSpec } from '../../scripts/load-spec.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function findModulePath(dir) {
  for (const name of ['next.cjs', 'machine.cjs']) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  // migrate.cjs and effects.cjs are sibling ARTIFACTS, never the machine —
  // without this exclusion, adding either beside a custom-named machine
  // module would make the dir unloadable (multiple .cjs files), bricking the
  // very `polyvers check` that must run next.
  const cjs = readdirSync(dir).filter((f) => f.endsWith('.cjs') && f !== 'migrate.cjs' && f !== 'effects.cjs');
  if (cjs.length === 1) return join(dir, cjs[0]);
  throw new Error(`cannot locate the machine module in '${dir}' — expected next.cjs, machine.cjs, or exactly one .cjs file besides migrate.cjs/effects.cjs${cjs.length ? ` (found: ${cjs.join(', ')})` : ''}`);
}

/**
 * Contracts-only load — for the scaffold workflow, which runs BEFORE the new
 * version's module exists (contract-first authoring) and must neither execute
 * machine code nor demand invariants.
 */
export function loadContractOnly(dir) {
  const abs = resolve(dir);
  const contractPath = join(abs, 'contract.json');
  if (!existsSync(contractPath)) throw new Error(`'${abs}' has no contract.json`);
  const bytes = readFileSync(contractPath);
  return { contract: JSON.parse(bytes.toString('utf-8')), contractHash: sha256(bytes) };
}

/**
 * Load one version's artifact family from a directory.
 * Returns { contract, contractHash, module, moduleHash,
 *           invariants?, transitionInvariants?, invariantsHash?,
 *           manifest?, manifestHash?, versionHash }.
 *
 * The machine module is loaded through the pipeline's ONE loader
 * (scripts/load-spec.mjs): every call compiles a fresh module instance (old
 * and new versions can never alias), require of the SAM library is pinned to
 * the vendored bundle (the compat verdict compares machine versions, never
 * library versions), and module console output goes to stderr (a top-level
 * console.log cannot corrupt `--json` stdout).
 */
export async function loadArtifacts(dir) {
  const abs = resolve(dir);
  const contractPath = join(abs, 'contract.json');
  if (!existsSync(contractPath)) throw new Error(`'${abs}' has no contract.json`);
  const contractBytes = readFileSync(contractPath);
  const contract = JSON.parse(contractBytes.toString('utf-8'));

  const modulePath = findModulePath(abs);
  const moduleBytes = readFileSync(modulePath);
  const module = loadSpec(modulePath);

  const out = {
    contract,
    contractHash: sha256(contractBytes),
    moduleHash: sha256(moduleBytes),
    module,
  };

  const invariantsPath = join(abs, 'invariants.mjs');
  if (existsSync(invariantsPath)) {
    const bytes = readFileSync(invariantsPath);
    out.invariantsHash = sha256(bytes);
    // Content-hash query keeps same-content loads cached while guaranteeing
    // different contents never alias. (Recorded limitation: the suffix does
    // not propagate to the invariants module's own relative imports — like
    // versionHash, the intent artifact is treated as single-file at M0.)
    const mod = await import(`${pathToFileURL(invariantsPath).href}?h=${out.invariantsHash}`);
    out.invariants = mod.stateInvariants ?? mod.invariants ?? [];
    out.transitionInvariants = mod.transitionInvariants ?? [];
    // A present-but-empty intent artifact must fail loudly, not gate
    // vacuously: a renamed export (default export, a typo) would otherwise
    // yield zero predicates and a green invariants-pointwise over 0 checks.
    if (out.invariants.length === 0 && out.transitionInvariants.length === 0) {
      throw new Error(`'${invariantsPath}' exports no invariants — expected stateInvariants (and/or transitionInvariants) arrays of {name, pred}; refusing to gate vacuously against an empty intent artifact`);
    }
  }

  const manifestPath = join(abs, 'effects.manifest.json');
  if (existsSync(manifestPath)) {
    const bytes = readFileSync(manifestPath);
    out.manifestHash = sha256(bytes);
    out.manifest = JSON.parse(bytes.toString('utf-8'));
  }

  // effects.cjs (optional, M3): the pure effect mapper — needed by the
  // cross-machine matrix (spawn discovery) and part of version identity (the
  // machine∘mapper composition is what actually runs).
  const mapperPath = join(abs, 'effects.cjs');
  if (existsSync(mapperPath)) {
    const bytes = readFileSync(mapperPath);
    out.mapperHash = sha256(bytes);
    const mod = loadSpec(mapperPath);
    if (typeof mod.effects !== 'function') {
      throw new Error(`'${mapperPath}' does not export effects(pre, action, data, post, stepKind) — a present mapper artifact must be callable, not decorative`);
    }
    out.mapper = mod.effects;
  }

  // migrate.cjs (optional, M2): the pure shape migration for THIS version —
  // module.exports.migrate(oldState) → newState. Loaded through the same
  // pinned loader as the machine module. Part of version identity: shipping
  // the same machine with a different migration is a different version.
  const migratePath = join(abs, 'migrate.cjs');
  if (existsSync(migratePath)) {
    const bytes = readFileSync(migratePath);
    out.migrateHash = sha256(bytes);
    const mod = loadSpec(migratePath);
    if (typeof mod.migrate !== 'function') {
      throw new Error(`'${migratePath}' does not export migrate(oldState) — a present migration artifact must be callable, not decorative`);
    }
    out.migrate = mod.migrate;
  }

  // Version identity: hash of the artifact hashes, in a fixed order. Two
  // dirs with byte-identical artifacts are the same version, wherever they
  // live and whatever the machine is called.
  out.versionHash = sha256([out.contractHash, out.moduleHash, out.invariantsHash ?? '', out.manifestHash ?? '', out.migrateHash ?? '', out.mapperHash ?? ''].join('\n')).slice(0, 12);
  return out;
}

/** Observable keys, by the same convention the polyrun kernel uses. */
export function observableKeys(contract) {
  return Array.isArray(contract.stateKeys) ? contract.stateKeys.map((k) => k.name) : null;
}

/** The effective terminal key, by the kernel's convention: an explicit
 *  terminalKey, else the FIRST stateKey's name. */
export function terminalKeyOf(contract) {
  return contract.terminalKey
    ?? (Array.isArray(contract.stateKeys) && contract.stateKeys[0] && contract.stateKeys[0].name)
    ?? null;
}

/** The kernel's terminal predicate, derived once (polyrun registerMachine
 *  convention): terminalStates over the effective terminal key. Returns null
 *  when the contract declares no terminal metadata — callers must treat that
 *  as "cannot enumerate", never as "no terminal states exist". */
export function isTerminalOf(contract) {
  const key = terminalKeyOf(contract);
  const values = new Set(contract.terminalStates ?? []);
  if (!key || values.size === 0) return null;
  return (state) => values.has(state[key]);
}

/** The ONE bridge from artifact invariant fields to the checker's input
 *  shape — every check() caller (gate and test alike) goes through this so
 *  the mapping can never silently diverge into a vacuous {undefined}. */
export function invariantsOf(artifacts) {
  return {
    stateInvariants: artifacts.invariants ?? [],
    transitionInvariants: artifacts.transitionInvariants ?? [],
  };
}
