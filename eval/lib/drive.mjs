// Shared deterministic driver for the eval machines. Wraps a pure
// next(state, action, data) machine with the plugin's own withTracing helper so
// each scenario emits a {pre, action, data, post} NDJSON corpus — exactly the
// Step-2 mechanism a real user would use. No API, no randomness.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { withTracing } from '../../scripts/instrument/trace-emitter.mjs';

/** Drive one scenario (an ordered [action, data] list) into one .ndjson file. */
export function driveScenario(mod, project, file, steps) {
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
  let state = mod.init();
  const step = withTracing(
    (action, data) => { state = mod.next(state, action, data); return state; },
    () => project(state),
    file,
  );
  for (const [action, data] of steps) step(action, data ?? {});
}

/** Drive many named scenarios into <dir>/<name>.ndjson. */
export function driveAll(mod, project, dir, scenarios) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, steps] of Object.entries(scenarios)) {
    driveScenario(mod, project, `${dir}/${name}.ndjson`, steps);
  }
}
