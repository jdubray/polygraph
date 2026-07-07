// The turnstile from examples/turnstile/, implemented as a real
// @cognitive-fab/sam-pattern instance and instrumented with withSamTracing.
//
// Observable semantics (identical to examples/turnstile/specs/reference.js):
//   COIN                -> UNLOCKED, coins + 1
//   PUSH while UNLOCKED -> LOCKED  (coins unchanged)
//   PUSH while LOCKED    -> no-op  (state and coins unchanged)
//
// sam-pattern intents are async, so callers await each dispatch. Actions carry
// their name in `__name` (the convention this library exposes to acceptors when
// actions are plain functions); withSamTracing reads `__actionName ?? __name`,
// so it works whether you register plain functions (name in `__name`) or
// [label, fn] tuples (library sets `__actionName`).
import SAMPattern from '@cognitive-fab/sam-pattern';
import { withSamTracing } from '../../scripts/instrument/sam-emitter.mjs';

const { createInstance } = SAMPattern;

/** Build a fresh, traced turnstile instance emitting to `file`. */
export function makeTurnstile(file) {
  const instance = createInstance({ instanceName: 'turnstile', hasAsyncActions: false });

  // observable-state projection — ONLY the contract's keys
  const project = (m) => ({ state: m.state, coins: m.coins });

  const component = {
    actions: [
      () => ({ __name: 'COIN' }),
      () => ({ __name: 'PUSH' }),
    ],
    acceptors: [
      (model) => (proposal) => {
        if (proposal.__name === 'COIN') {
          model.state = 'UNLOCKED';
          model.coins = model.coins + 1;
        } else if (proposal.__name === 'PUSH' && model.state === 'UNLOCKED') {
          model.state = 'LOCKED';
        }
        // PUSH while LOCKED: no branch fires -> observable no-op
      },
    ],
    reactors: [],
  };

  const { intents } = instance({
    initialState: { state: 'LOCKED', coins: 0 },
    component: withSamTracing(component, project, file),
  });

  const [coin, push] = intents;
  return { coin, push };
}

// CLI: emit a normal + no-op scenario to the given file.
if (import.meta.url.replace(/\\/g, '/').endsWith(String(process.argv[1]).replace(/\\/g, '/'))) {
  const file = process.argv[2] || 'turnstile-sam.ndjson';
  const t = makeTurnstile(file);
  await t.coin();  // LOCKED   -> UNLOCKED (coins 1)
  await t.push();  // UNLOCKED -> LOCKED
  await t.push();  // LOCKED   -> LOCKED  (no-op)
  await t.coin();  // LOCKED   -> UNLOCKED (coins 2)
  console.log(`wrote turnstile-sam windows to ${file}`);
}
