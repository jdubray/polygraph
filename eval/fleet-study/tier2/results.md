# Fleet study · Tier 2 — three version changes against a captured fleet

Corpus: `C:\Users\jjdub\code\polygraph\examples\fleet-study-stripe\out`
Provenance: simulated (offline: the machine generated this corpus — NOT admissible as Tier 2 evidence)
Fleet: 400 subscriptions · 11 distinct states · 1357 trace windows
**Admissible as Tier 2 evidence: NO**

Each change is run twice: once before any migration exists, and once with the
migration an operator authored from the scaffold. Both are results — the first
says what the tool demanded, the second says whether the work satisfied it.

| change | lanes fired | migration | pre-migration | post-migration | final | predicted | held? | findings | ms (classify / checks) |
|---|---|---|---|---|---|---|---|---|---|
| v2-addition | vocabulary, semantic | none needed | PASS | n/a | **PASS** | PASS | yes | 0 | 2705 / 2198 |
| v2-dunning | shape, migration, intent, semantic | authored | FAIL (1) | FAIL (4) | **FAIL** | FAIL | yes | 5 | 2067 / 5532 |
| v2-shape | shape, migration, intent, semantic | authored | FAIL (1) | PASS | **PASS** | PASS | yes | 1 | 2317 / 5566 |

Corpus: 11 distinct fleet states.

## What each change is

- **v2-addition** — pure addition: a REFUND_ISSUED action; nothing removed, no existing transition or invariant altered.
  Predicted PASS: adding vocabulary cannot strand a live state: no fleet record carries the new action, and every existing transition is untouched
- **v2-dunning** — rules + intent: the retry budget drops from 3 to 2, and the invariants tighten with it.
  Predicted FAIL: the fleet already holds records mid-dunning, and no migration can make them legal without making a billing decision — so the failure should SURVIVE a correct migration. This is the archetypal fleet event and the one the study exists to exhibit
  Gates still red after migration: migrate, invariants-pointwise, semantic-model-check.
- **v2-shape** — shape: `cents` splits into `amountCents` + `currency`.
  Predicted PASS: the old shape cannot round-trip unmigrated, but the rename is faithful and total — so a correct migration should CLEAR it. A shape change that stayed red after a correct migration would mean the gate was measuring something other than shape
  Gates still red after migration: none.

> Cost: every run above is local and deterministic and needs **no API key**.
> The only human cost is authoring the migrations, which is recorded in each
> `migrate.cjs` — both were scaffolded by the tool and both needed a hand edit,
> one a rename the scaffold could not infer, one a policy decision it correctly
> refused to make.
> Findings are unadjudicated here; see `adjudication.md`.
