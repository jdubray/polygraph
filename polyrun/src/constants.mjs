// polyrun shared kernel constants — split out of kernel.mjs so PURE consumers
// (check-product.mjs, and through it `polyvers product`) can import them
// without dragging kernel → store → node:sqlite into their module graph.
// node:sqlite does not exist on Node 20/21 and is experimental on 22+; a
// static model checker (and every polyvers command, whose CLI imports the
// product module) must not fail-to-import or emit sqlite warnings over two
// constants.
'use strict';

// FR-8: dispatch cascades (parent → child signal → grandchild …) are capped;
// a deeper chain is a wiring cycle, which is a mapper defect. Shared with
// check-product.mjs so the model checker can never drift from the kernel cap.
export const MAX_CASCADE_DEPTH = 8;

/** Strips SAM-internal (__-prefixed) keys and functions from snapshots — the
 *  ONE observable-projection rule (kernel snapshots, checker projections). */
export const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};
