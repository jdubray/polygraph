# Tier 3 protocol — archaeology against Medusa

Pre-registered for FS-M4 of [`fleet-study-plan.md`](fleet-study-plan.md).
**Committed before any version pair is run.** Written so that a reader can tell,
after the fact, that the numbers were not tuned toward the answer.

Plan §6 fixes the target (Medusa, TypeScript, 2–3 released version pairs) and
the scoring rule (the maintainers' own record is ground truth). This document
adds what §6 leaves open, and what a reviewer would otherwise be right to
attack.

## 1. The threat §6 does not address

Ground truth in Tier 3 is external: the maintainers shipped a migration, or an
issue reports upgrade breakage. That part is sound.

**The model is not external.** Medusa's order lifecycle has to be
hand-translated into a SAM v2 module before `polyvers` can say anything about
it, and whoever writes that translation controls which findings are even
expressible. Two failure modes follow, and they are not symmetric:

- **A false TP.** The translation is written after looking at the version-N+1
  diff, so it encodes exactly the distinction the migration addresses. The tool
  then "detects" something the translator planted. This inflates recall and is
  the more dishonest of the two.
- **An unfair miss.** The translation omits a field the real change touched, so
  the tool cannot see the defect. Scored naively this reads as a tool
  limitation when it is a modeling artifact.

The whole tier is worthless if the translation is allowed to float. So:

## 2. The translation is frozen before the diff is read

For each version pair (N, N+1), in this order, no step revisited:

1. **Translate version N only.** Author `next.cjs`, `contract.json`, and
   `invariants.mjs` from version N's source and documentation. The version N+1
   diff, its migrations, and its release notes are **not read** during this
   step.
2. **Validate the translation against version N's own behaviour**, not against
   the study's needs:
   - every status enum member in version N's source appears in the contract's
     state domain, or its omission is recorded with a reason;
   - the module model-checks clean from `init` (a translation that violates its
     own invariants is wrong before it is useful);
   - the transitions are cross-checked against version N's tests or service
     code, and the mapping is recorded per transition.
3. **Freeze.** Commit the translation with its validation record. The commit
   hash is cited in the results table.
4. **Only then** read version N+1, translate it by the same rule, and run
   `polyvers`.

If step 4 reveals that the version-N translation was wrong — a transition that
does not exist, a status member missed — the fix is **a new commit that says
what was wrong and why**, and the pair is re-run from the frozen point. Silent
amendment of a frozen translation invalidates the pair, and a pair whose
translation was amended after the diff was read is reported as such rather than
dropped.

## 2a. AMENDMENT (FS-M4 selection phase) — §2 and §4 conflicted

§2 forbids reading the N+1 diff before translating version N. §4 requires
selecting candidate pairs on the maintainer record — which member changed, and
whether a migration shipped — *before* any pair is run. **Those cannot both be
satisfied.** Selection is impossible without reading the very artifact §2
withholds. The conflict is a defect in this document as first committed, and
per §2's own amendment rule it is fixed by saying what was wrong rather than by
quietly rewriting.

**Resolution.** The freeze applies to the N+1 **source translation**, not to the
maintainer record. Selection may read: which status member changed, whether a
migration shipped, and what the maintainers said about it. Selection may **not**
read version N+1's source in the detail needed to translate it. The version-N
translation is then validated against version N's own behaviour (§2 step 2),
which is an objective check that does not depend on what selection revealed.

**Declared contamination.** Both surviving pairs were selected by reading their
migrations, so the version-N translations are authored with knowledge that
`failed`/`completed` (Pair A) and `pending_authorization` (Pair B) are coming.
This is recorded rather than repaired, and the bias direction is stated so a
reader can discount it correctly:

For a **recall** study this contamination is dangerous — it invites planting the
distinction the migration addresses, then "detecting" it. For a **precision**
study, which is what FS-M4 became, the risk runs the other way. The way to
manufacture a clean PASS is to model version N's status domain *loosely*, so
that added members cannot conflict with anything. The countermeasure is
therefore to model version N **as tightly as its source allows** — the exact
declared members, no wildcards, invariants taken from version N's own service
code. A tight domain is the setup most likely to produce a false positive when
members are added, so tight modelling is the **adversarial** choice here.

If `polyvers` passes these pairs against a tight version-N model, the result is
stronger for the tightness, not weaker. Any looseness in a translation is a
defect to be reported, not a convenience.

## 3. Scoring, beyond §6's rule

§6's four buckets stand (TP / TI / FP by maintainer artifact). Tier 3 adds:

- **MISS** — the maintainers shipped a migration for a state-machine change and
  `polyvers` reported nothing. Misses are the number a reviewer will look for
  first, and a study that cannot report them is not measuring recall.
- Every MISS is classified as **in-projection** (the change touched a field the
  contract declares, so the tool should have caught it — a real limitation) or
  **out-of-projection** (the change touched a field outside `stateKeys`, so it
  is invisible *by construction*). The second is not a tool failure but it is
  also not a free pass: it is exactly the observable-projection bound the paper
  must state, and the count is evidence for how much that bound costs in
  practice.

That last number is the most useful thing this tier can produce, and it only
exists if misses are hunted as deliberately as hits.

## 4. Pre-registered null result

If Medusa's released version pairs turn out to contain **no state-machine
change with a maintainer migration**, or the translations cannot be validated
against version N's behaviour, Tier 3 reports that and the paper cites Tiers 1
and 2 only. A negative Tier 3 is published in the repo either way.

The failure mode to avoid is drifting toward whichever pairs happen to produce
findings. **The candidate pairs are selected and committed before any pair is
run**, on the basis of the maintainer record alone (a state-machine change plus
a shipped migration), never on whether `polyvers` says something interesting
about them. A pair that is selected and then produces nothing is reported as a
MISS or a clean result, not quietly replaced.

## 5. What the fleet is here

§6 says the fleet for each pair is generated by running the app at version N.
Where standing up a given Medusa version is not practical, the fallback is a
corpus derived from **version N's own test fixtures and seed data** — which is
still independent of this project, but is a weaker tier than a live fleet and
is labelled `provenance: upstream-fixtures` in the manifest, never `live`.

The corpus-provenance discipline from Tiers 1 and 2 applies unchanged: a
synthesized corpus is circular and is never admissible as Tier 3 evidence.

## 6. Deliverable

`eval/fleet-study/tier3/` — per-pair reports, the version-pair matrix, and a
ground-truth mapping table linking every TP to the upstream migration or issue
by URL, every MISS to the artifact it failed to name, and every translation to
its frozen commit.
