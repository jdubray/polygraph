// Positive control: the turnstile reference spec ported to the v2 SAM strict
// profile (sam-lib 2.0.0-alpha) — the same transition semantics as
// examples/turnstile/specs/reference.js, expressed as a strict SAM module:
// declared modelShape, named intents with payload schemas and domains, keyed
// acceptors, and reject(reason) for the contract's special rule instead of a
// silent fall-through. It must score 100% on the corpus; the PUSH-while-LOCKED
// windows replay as classification 'rejected' with the contract-anchored
// reason 'push-while-locked-is-noop'.
//
// The require below resolves to the plugin's VENDORED sam-lib bundle
// (scripts/vendor/sam-pattern.cjs) when loaded through the pipeline's spec
// loader — see scripts/sam-lib.mjs. Running this file directly with node
// would instead pick up whatever is installed in node_modules.
'use strict';

const { createInstance } = require('@cognitive-fab/sam-pattern');

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: 'turnstileV2' });

const INITIAL_STATE = { state: 'LOCKED', coins: 0 };

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
      state: { type: 'string' },
      coins: { type: 'number' },
    },
    actions: {
      COIN: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
      PUSH: { action: (data = {}) => ({ ...data }), schema: {}, domain: [{}] },
    },
    acceptors: {
      // COIN always unlocks and counts the coin (even when already UNLOCKED).
      COIN: (model) => (proposal, { next }) => {
        next.state = 'UNLOCKED';
        next.coins = model.coins + 1;
      },
      // PUSH locks when UNLOCKED; PUSH while LOCKED is the contract's named
      // special rule — an observable rejection, not a silent fall-through.
      PUSH: (model) => (proposal, { reject, next, unchanged }) => {
        if (model.state === 'LOCKED') return reject('push-while-locked-is-noop');
        next.state = 'LOCKED';
        unchanged('coins');
      },
    },
    reactors: [],
  },
});

const { intents } = control;

const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };

const init = () => {
  // NOTE (sam-lib 2.0.0-alpha.1): this machine declares a model key named
  // 'state', which shadows Model.prototype.state — instance({}).state() throws
  // "model.state is not a function" here, so the error-slot clear is
  // best-effort. Strict-profile errors throw at the intent caller anyway.
  try {
    const model = instance({}).state();
    if (model && typeof model.clearError === 'function') model.clearError();
  } catch { /* model key 'state' shadows the accessor — see note above */ }
  setState(INITIAL_STATE);
};

const actions = {
  COIN: (data = {}) => intents.COIN(data),
  PUSH: (data = {}) => intents.PUSH(data),
};

module.exports = { instance, init, actions, getState, setState };
