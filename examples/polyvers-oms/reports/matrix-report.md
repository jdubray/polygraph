# polyvers matrix — parent × child version pairings

> parent-old: 33 state(s)
> parent-new: 33 state(s)
> child-old: 4 state(s)
> child-new: 4 state(s)

| pairing | verdict |
|---|---|
| parent-old × child-old | PASS |
| parent-old × child-new | PASS |
| parent-new × child-old | PASS |
| parent-new × child-new | PASS |

## Verdict: PASS

> Scope note: this is the spawn/completion PROTOCOL and DELIVERY matrix —
> nothing either side can deliver across the version boundary is unhandled.
> The full product-space model check (joint interleavings against
> cross-machine invariants) is `polyvers product` — a delivery-clean
> pairing can still fail it (e.g. a narrowed cancel window), so run both.

