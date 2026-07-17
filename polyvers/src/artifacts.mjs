// polyvers artifact loader — one version of a machine is a directory holding
// the artifact family: contract.json (required), the SAM v2 module (required;
// next.cjs, machine.cjs, or the only .cjs in the dir), invariants.mjs
// (optional), effects.manifest.json (optional).
//
// Loading is content-first: every artifact gets a sha256 so version identity
// can be derived, not declared. Deterministic, no API key.
'use strict';

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function findModulePath(dir) {
  for (const name of ['next.cjs', 'machine.cjs']) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  const cjs = readdirSync(dir).filter((f) => f.endsWith('.cjs'));
  if (cjs.length === 1) return join(dir, cjs[0]);
  throw new Error(`cannot locate the machine module in '${dir}' — expected next.cjs, machine.cjs, or exactly one .cjs file${cjs.length ? ` (found: ${cjs.join(', ')})` : ''}`);
}

/**
 * Load one version's artifact family from a directory.
 * Returns { dir, contract, contractHash, modulePath, moduleHash, module,
 *           invariantsPath?, invariantsHash?, invariants?, manifestPath?,
 *           manifestHash?, manifest?, versionHash }.
 * The module is loaded fresh (require cache busted) so old and new versions
 * of the same filename never alias each other.
 */
export async function loadArtifacts(dir) {
  const abs = resolve(dir);
  const contractPath = join(abs, 'contract.json');
  if (!existsSync(contractPath)) throw new Error(`'${abs}' has no contract.json`);
  const contractBytes = readFileSync(contractPath);
  const contract = JSON.parse(contractBytes.toString('utf-8'));

  const modulePath = findModulePath(abs);
  const moduleBytes = readFileSync(modulePath);
  // Bust the require cache: `polyvers check --old a/ --new b/` loads two
  // modules that both `require('@cognitive-fab/sam-pattern')` and both may be
  // named next.cjs; each must get its own module instance.
  delete require_.cache[require_.resolve(modulePath)];
  const module = require_(modulePath);

  const out = {
    dir: abs,
    contract,
    contractHash: sha256(contractBytes),
    modulePath,
    moduleHash: sha256(moduleBytes),
    module,
  };

  const invariantsPath = join(abs, 'invariants.mjs');
  if (existsSync(invariantsPath)) {
    const bytes = readFileSync(invariantsPath);
    out.invariantsPath = invariantsPath;
    out.invariantsHash = sha256(bytes);
    // Cache-bust dynamic import the same way require is busted above: a query
    // string keyed on content hash keeps same-content loads cached while
    // guaranteeing different contents never alias.
    const mod = await import(`${pathToFileURL(invariantsPath).href}?h=${out.invariantsHash}`);
    out.invariants = mod.stateInvariants ?? mod.invariants ?? [];
  }

  const manifestPath = join(abs, 'effects.manifest.json');
  if (existsSync(manifestPath)) {
    const bytes = readFileSync(manifestPath);
    out.manifestPath = manifestPath;
    out.manifestHash = sha256(bytes);
    out.manifest = JSON.parse(bytes.toString('utf-8'));
  }

  // Version identity: hash of the artifact hashes, in a fixed order. Two
  // dirs with byte-identical artifacts are the same version, wherever they
  // live and whatever the machine is called.
  out.versionHash = sha256([out.contractHash, out.moduleHash, out.invariantsHash ?? '', out.manifestHash ?? ''].join('\n')).slice(0, 12);
  return out;
}

/** Observable keys, by the same convention the polyrun kernel uses. */
export function observableKeys(contract) {
  return Array.isArray(contract.stateKeys) ? contract.stateKeys.map((k) => k.name) : null;
}
