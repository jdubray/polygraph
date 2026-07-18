// check-product fixture config — the CLI entry point for the compose pair:
//   polyrun check-product --config polyrun/test/fixtures/compose/polyrun.config.mjs \
//     --parent po --invariants polyrun/test/fixtures/compose/invariants.compose.mjs
// Swap the shipment module for ../shipment-machine.cjs (+ ../shipment-contract.json)
// to see the lag-child cross-machine violations.
'use strict';

export default {
  store: { sqlite: ':memory:' },
  machines: [
    {
      machineId: 'po',
      module: 'parent-po.cjs',
      contract: 'parent-po.contract.json',
      effects: { mapper: 'parent-po.effects.cjs', manifest: 'parent-po.effects.manifest.json' },
    },
    {
      machineId: 'shipment',
      module: 'ship-good.cjs',
      contract: 'ship-good.contract.json',
    },
  ],
  handlers: {},
};
