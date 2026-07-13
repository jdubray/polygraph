// ONE resolution point for the SAM library (sam-lib / @cognitive-fab/sam-pattern).
//
// The v2 strict profile the plugin targets is 2.0.0-alpha.x, which is VENDORED
// at scripts/vendor/sam-pattern.cjs (see the provenance header there). Every
// consumer — the v2 replayer, the checker adapter, the spec loaders — resolves
// the library through this module (or through SAM_LIB_PATH for require-level
// patching), so switching to the published npm package later is a one-line
// change here.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the vendored CommonJS bundle (for require()-patch loaders). */
export const SAM_LIB_PATH = join(HERE, 'vendor', 'sam-pattern.cjs');

/** Module specifiers that must resolve to the vendored bundle inside specs. */
export const SAM_LIB_SPECIFIERS = ['@cognitive-fab/sam-pattern', 'sam-pattern', 'sam-lib'];

const requireCjs = createRequire(import.meta.url);

/** The vendored library itself ({ createInstance, SamSchemaError, ... }). */
export const samLib = requireCjs(SAM_LIB_PATH);
export const { createInstance } = samLib;
