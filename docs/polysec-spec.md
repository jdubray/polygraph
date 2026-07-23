# PolySec — a security lens for the Polygraph toolset

**Spec draft v0.1 — exploratory.** This document turns a design conversation
into a plugin specification. It reuses the Polygraph artifact family and
engines wherever they already do the work, and names new tools only where
security asks a question the correctness tools do not. It is a *first draft
meant to be argued with*, not a committed design.

Developed against **Polygraph** (Cognitive Fab LLC). PolySec is a **lens over
the same substrate**, not a fork: it verifies and monitors the *same* SAM v2
strict-profile state machines, consumes the *same* `{pre, action, data, post}`
windows, and inherits the *same* doctrines (controls before trust, observable
rejection, no silent-clean paths, ground truth is executed code).

---

## 0. Scope disclosure (read this first, in the Polygraph tradition)

PolySec is a **consistency check and a monitor, not a proof of security**.
Concretely, and stated before any capability is claimed:

- It reasons over the **control-flow layer** — states, transitions, and
  predicates over declared, finite state. It does **not** find implementation
  vulnerabilities (memory safety, injection, parser bugs). The Hugging Face
  escape began with a flaw *inside* a package-installer tool; PolySec would not
  have found that flaw. It would have flagged that the installer's permission
  model let a benign state reach network egress without a mediated transition —
  a *design* finding, one layer above the bug that realized it.
- Every guarantee is relative to (a) the **invariants** you declared — your
  intent, which no tool derives — and (b) the **observable projection** — the
  state variables the contract names. A malicious flow that changes no declared
  variable is invisible here. That residual is real, it is *smaller and more
  structured* than the raw attack surface, and PolySec's job is to shrink it to
  the trusted computing base and hand what remains to another method.
- "Exhaustive" always means **exhaustive over the finite declared domains**,
  never over unbounded real data. Behavior depending on unbounded counters,
  amounts, or strings is checked only at declared representative values.
- A single security invariant is complete as a statement of *that* intent.
  Whether your **portfolio** of invariants covers "secure" is open-ended in the
  way security always is — and is *measured*, not assumed, by the adequacy
  grades below.

---

## 1. The conceptual spine

Everything downstream rests on four claims established in design and worth
stating once, plainly.

**Security bugs in stateful systems are reachable-bad-state bugs.** An
authentication bypass is an application-data-accepting state reached without an
authenticating transition; a data leak is a state where a secret coexists with
an egress capability. These are predicates over state — the same objects
Polygraph model-checks. The lineage is the protocol-state-machine security work
(TLS/DTLS state fuzzing): security properties expressed as reachability and
ordering over a state machine.

**An invariant is a predicate over state, not over paths — so you never
enumerate channels.** "The secret never reaches the network" does not care
*which* egress fired. Any transition — modeled, unmodeled, or attacker-drilled —
that lands the state in the forbidden region is caught by the check on the
post-state. The completeness you need is the invariant's (which you have, it is
intent) plus the state's (which you engineer). Unknown transitions are handled
by modeling the adversary as **maximal nondeterminism (havoc)** over the
non-mediated state variables and checking the invariant against
`modeled ∪ havoc`.

**Prevention lives in the acceptor; correction lives in the nap.** SAM gives two
native extension points. The **acceptor** rejects a proposal that would violate
`φ` — the default-deny mediated control point, where controllable/modeled paths
are stopped before the mutation lands. The **nap** (next-action predicate) fires
when the state is *already* in the danger region — the residual reached through
a havoc/unmodeled edge — and drives forward toward a desired state. Push
everything provable into the acceptor; let the nap be the safety net for what
the state can still diagnose after the fact.

**SAM is memoryless, and that is licensed by state adequacy.** The nap is a pure
function of the present control state; there is no history to consult. You get
to forget the path because the path already deposited everything that matters
into the state — the taint bit, the capability grant, the compromise flag. The
Markov property *is* the requirement that the present state is a sufficient
statistic for the past, and it holds exactly when every consequence-bearing
effect is carried in a present variable. Recovery is therefore **containment,
not restoration**: from a state that honestly carries `compromised = true`, the
best reachable desired state still wears the flag. A corrective nap that can
clear a genuine compromise flag has an inadequate state, not a clever recovery.

The design target is not "the forbidden region is unreachable" (unprovable over
a masked machine) and not "detect and contain" (too weak). It is
**fully-mediated reachability**: *every modeled path to the forbidden region
traverses a controllable, default-deny gate.* The residual then decomposes into
exactly two attackable things — gate **bypasses** (checkable) and **unmodeled
channels** (made to fail closed by default-deny) — plus the irreducible
**side-channel** frontier that lives below the state-machine layer.

---

## 2. Use cases (the guiding posts)

Five, with the model sandbox as the anchor. Each names the machine, the
forbidden region, where prevention sits (acceptor), the residual and its sensor,
and the correction (nap). They exist to keep the spec honest: every tool below
must earn its place against at least one of these.

### UC-1 — Model sandbox / agent control-plane (anchor)

An agent runs in a sandbox with tool access mediated through a broker. The
control-plane state tracks what the agent has touched: untrusted content
ingested, sensitive data read, outbound channels available.

- **Forbidden region — the lethal trifecta.**
  `¬(untrusted_ingested ∧ sensitive_readable ∧ egress_enabled)`. No reachable
  state holds all three at once.
- **Prevention (acceptor).** Every capability grant and every tool call is a
  mediated proposal; the acceptor is default-deny — an unrecognized tool or an
  egress request from a tainted state is `reject(reason)`, not a silent no-op.
- **Residual + sensor.** A manufactured edge (a vuln in the broker, à la the
  package installer) could enable egress without a modeled transition. The
  coupling sensor: reaching a `downloaded` / `external-fetch` state is evidence
  egress is live even if no egress transition was observed.
- **Correction (nap).** On a diagnosed trifecta or a bypass alarm: revoke
  capabilities, quarantine the sandbox, kill the instance. Forward-only; the
  compromise flag persists.

### UC-2 — Secret custody / non-interference

API keys, credentials, PII. The property is confidentiality, and it must be
solved **upstream**, because information commits at *read*, not at *send*.

- **Forbidden region.** `¬(tainted ∧ egress_capable)`, where `tainted` flips at
  the **mediated read** of the secret and propagates through the model.
- **Prevention (acceptor).** The secret is never in a plaintext state the
  untrusted computation can read; access is only through a capability acquired
  by a mediated transition that sets `tainted`.
- **Residual + sensor.** Implicit flows and side channels that move information
  without a modeled read — the irreducible frontier. Sensors can cover *some*
  proxies (unexpected `tainted` propagation, egress volume) but not timing/cache
  channels; this is the honest hand-off to the TCB.
- **Correction (nap).** Rotate the compromised secret, revoke the derived
  capabilities, mark `secret_compromised` (never cleared by recovery).

### UC-3 — Authentication & privilege state machine

The TLS-lineage classic, generalized: no privileged action before the
authenticating transition.

- **Forbidden region.** `¬(privileged_effect_taken ∧ ¬authenticated)`; and
  ordering invariants — `handshake_complete` precedes any
  `application_data_accepted`.
- **Prevention (acceptor).** Privileged actions are rejected in every
  pre-auth state; the acceptor encodes the required order.
- **Residual + sensor.** State-machine confusion — a message accepted in a
  state where the designer did not expect it (the SKIP-TLS shape). The
  **havoc check** is the design-time hunter here: does any adversarial
  interleaving reach a privileged state without the auth transition?
- **Correction (nap).** Tear down the session to `unauthenticated`; this one is
  genuinely reversible (no external damage) — restoration *is* available.

### UC-4 — Capability / consent broker (MCP-style tool mediation)

A broker mediates a fleet of tools/connectors an agent may call, with approval
gates and monotone grants.

- **Forbidden region.** Non-monotone or unapproved capability: a capability
  active without a recorded approval; a downgrade-then-reuse; two capabilities
  whose *composition* is forbidden even though each alone is allowed.
- **Prevention (acceptor).** Default-deny broker: only enumerated
  (capability, approval) pairs pass; everything else is a named reject.
- **Residual + sensor.** Composition hazards invisible to single-capability
  reasoning — caught by the **joint/product** check across the tools' machines.
- **Correction (nap).** Revoke the offending grant, require re-approval, freeze
  the broker for that principal.

### UC-5 — Agent fleet / swarm monitoring

The Hugging Face attack profile: thousands of short-lived sandboxes,
self-migrating command-and-control on public services. Each action is locally
benign; the malice is only visible in aggregate.

- **Forbidden region — cross-instance.** "No set of sandboxes collectively opens
  more than N distinct outbound hosts in a window"; "no two live instances share
  a migrated C2 identity"; "no instance reaches `network-enabled` outside an
  approved window."
- **Prevention (acceptor).** Per-instance acceptors cap what one instance can
  do; the fleet property needs an aggregating monitor, not a per-instance gate.
- **Residual + sensor.** The whole point: the signal is a **fleet invariant**
  over the joint/aggregated state, sensed at runtime from the combined journal.
- **Correction (nap).** Fleet-level shield: freeze the cohort, revoke a shared
  credential, quarantine by C2 fingerprint.

---

## 3. Functional spec

### 3.1 What PolySec does

Two workflows over one substrate.

**Design-time (`harden`).** Given a SAM v2 machine, a contract, security
invariants, and a security manifest, PolySec proves the forbidden region is
**fully mediated** and drives an architecture-repair loop until it is:

1. Model-check the security invariants from `init` (reuses the Polygraph
   checker) — the reachable-bad-state hunt with a shortest counterexample.
2. **Havoc check** — add maximal nondeterminism over the declared *adversarial*
   variables and re-check; a counterexample means a security-relevant variable
   is not mediated. Repair: route its mutation through an acceptor gate (or move
   the secret upstream), then re-check.
3. **Fully-mediated (gate-deletion) check** — delete the designated gate
   transitions and test reachability to the forbidden region; a surviving path
   is a **bypass**, reported with the shortest witness.
4. **Recovery-convergence check** — from every state in the danger region,
   confirm a desired state is reachable via controllable corrective actions
   without transiting `¬φ`, and that the corrective naps are nonblocking (no
   cycles). A recovery controller that can get stuck is worse than none.

The loop converges when: no from-init violation, no havoc counterexample (every
variable `φ` reads is mediated), no bypass path, and recovery converges.

**Runtime (`guard`).** Given a running fleet (polyrun) or a captured journal,
PolySec runs a **diagnoser** and a **shield**:

1. Maintain the **belief set** — the set of states consistent with the observed
   projection of the `{pre, action, data, post}` stream.
2. Raise an alarm on the configured semantics: **possible** (some consistent
   state is in the forbidden region — early, false-positive-tolerant) or
   **certain** (all consistent states are — late, sound). Coupling invariants
   (the sensors) shrink the belief set toward certainty.
3. On alarm, fire the corrective nap (revoke / quarantine / kill / rotate) —
   forward-only, memoryless.
4. For fleets, evaluate **cross-instance invariants** over the aggregated
   journal and apply fleet-level shields.

### 3.2 Security invariant classes

| class | shape | example | primary tool |
|---|---|---|---|
| **reachability / ordering** | forbidden region unreachable; event order enforced | no privileged action pre-auth | model check + havoc |
| **confidentiality / taint** | `¬(tainted ∧ egress_capable)`; taint set at mediated read | secret never egresses | taint discipline + havoc |
| **capability monotonicity** | grants monotone; forbidden compositions | no unapproved capability | model check + product |
| **cross-instance / fleet** | property over joint/aggregated state | no collective over-egress | product / fleet monitor |

### 3.3 The gates and grades PolySec introduces

- **Fully-mediated verdict** — a pass/fail with the two witnesses (havoc
  counterexample; bypass path). This is the headline design-time gate.
- **Diagnosability gate** — *before* shipping a monitor, decide whether a
  violation is even detectable from the observable projection within `k` steps.
  A non-diagnosable invariant returns the ambiguous state pair as a witness and
  the instruction "add a sensor to the projection" — never a silently blind
  monitor.
- **Diagnostic-adequacy grade** — the security analog of polynv's mutation
  adequacy. Inject a catalogue of **wormhole** mutants (edges from benign states
  into the forbidden region, standing in for manufactured/unmodeled
  transitions); report the fraction the sensor set diagnoses. Survivors are the
  next sensors to add. Blind spot stated: wormholes that trip no declared
  variable are undetectable by construction (the side-channel frontier).
- **Recovery-convergence verdict** — the corrective naps reach a desired set
  from the whole danger region, nonblocking, without transiting `¬φ`. Records
  explicitly when the reachable desired set excludes pristine states
  (containment, not restoration).

### 3.4 Human-in-the-loop (unchanged doctrine)

Invariants and the security manifest are **intent** — proposed by tooling,
confirmed only by a human, recorded append-only (extends `intent-ledger.json`).
The partition of state into *protected* vs *adversarial*, the choice of gates,
and the desired-state targets for recovery are design judgments; the tools make
them cheap to exercise and impossible to skip silently, but never decide them.

### 3.5 Outputs

A `security-report.{json,md}` in the compat-report tradition: the fully-mediated
verdict with witnesses, the diagnosability result per invariant, the
diagnostic-adequacy grade with survivors, the recovery-convergence verdict, and
the trust tier each was measured against — deterministic, PR-gateable, `$0` API
for everything that only checks/explores.

### 3.6 Non-goals

- Not an implementation-vulnerability scanner (no memory safety, injection,
  parser bugs — those are the TCB hand-off).
- Not a side-channel analyzer (timing/cache/physical flows are below the layer).
- Not a claim beyond the observable projection or the finite declared domains.
- Not a replacement for a reference-monitor's own verification — PolySec
  *concentrates* risk into that monitor; verifying its implementation is a
  separate, stronger method.

---

## 4. Technical spec

### 4.1 Artifact family (reuse + new)

| artifact | status | role in PolySec |
|---|---|---|
| `contract.json` | **reuse** | observable scope; PolySec reads the projection from it |
| SAM v2 module (`next.cjs`) | **reuse** | acceptors = gates, naps = correctors; no substrate change |
| `invariants.mjs` | **reuse** | security invariants live here alongside correctness ones |
| traces (`*.ndjson`) | **reuse** | ground truth for diagnosability & sensor grading |
| polyrun journal | **reuse** | the diagnoser's runtime event stream |
| `intent-ledger.json` | **reuse/extend** | records manifest dispositions, attributed |
| **`security.json`** | **new** | the security manifest (see 4.2) — a sidecar in the `effects.manifest.json` tradition |
| **`sensors.mjs`** | **new** | coupling invariants: state predicates that flag *evidence* of a masked edge (belief-set shrinkers) |
| **corrective naps** | **new (in-module)** | forward recovery/containment actions, first-class and convergence-checked |
| **`security-report.{json,md}`** | **new** | the verdicts of 3.3 |

### 4.2 The `security.json` manifest

The one new declarative artifact. It partitions and designates, and nothing in
it is derived without human confirmation:

```jsonc
{
  "projection": ["txState", "tainted", "egress", "capabilities"], // runtime-observable subset
  "protected":  ["tainted", "capabilities"],   // mutated ONLY through mediated acceptor gates
  "adversarial":["externalInput", "network"],  // havoc-writable: assume worst
  "forbiddenRegions": [
    { "name": "lethal-trifecta",
      "predicate": "untrusted && sensitive && egress" }
  ],
  "gates": ["grantCapability", "enableEgress"],  // acceptor transitions that mediate the forbidden region
  "taint":  { "sources": ["readSecret"], "sinks": ["enableEgress"] },
  "recovery": {
    "desiredStates": "safePredicate",           // may exclude pristine when a compromise flag is set
    "correctiveNaps": ["revoke", "quarantine", "kill"]
  },
  "alarm": { "lethal-trifecta": "possible" }     // "possible" | "certain", per region
}
```

### 4.3 Tool inventory (reuse vs new)

| capability | mechanism | reuse or new |
|---|---|---|
| reachable-bad-state hunt + shortest counterexample | `scripts/check.mjs` (BFS from init) | **reuse** |
| security invariant templates + interview | polynv `harvest` / `questions` + a security template pack | **reuse + extend** |
| state equality, spec loading | `stable()` in `load-spec.mjs`, `sam-adapter.cjs` | **reuse** |
| adversary/havoc exploration | new mode over the checker: augment with a havoc transition on `adversarial` vars | **new** (`polysec harden --adversary`) |
| fully-mediated / non-bypassability | gate-deletion re-reachability over the checker | **new** (`polysec harden` step) |
| diagnosability (twin-plant / observer over projection) | new construction over the SAM module | **new** (`polysec diagnose`) |
| diagnostic-adequacy grade | polynv mutation harness + a **wormhole** operator family, scored against `sensors.mjs` | **reuse + extend** (`polysec grade`) |
| recovery convergence + nonblocking | reachability + cycle check over the corrective sub-machine | **new** (checker mode) |
| runtime diagnoser + shield | belief-set estimator over the journal; fire corrective nap on alarm | **new** (`polyrun guard`) |
| cross-instance / fleet invariants | `polyrun check-product` (joint) + polyvers fleet snapshots + journal aggregation | **reuse** |
| version-aware drift = intrusion | `polyrun audit` (replay journal through module) | **reuse** |
| architecture self-repair loop | polygen's repair loop, extended to insert gates/naps | **reuse + extend** |

The headline: **most of PolySec is reuse.** The genuinely new pieces are four
gates (havoc, fully-mediated, diagnosability, recovery-convergence), one grade
(diagnostic adequacy), one runtime component (`guard`), and one manifest
(`security.json`).

### 4.4 New gates specified

**Havoc / adversary check.** Partition declared state into `P` (protected) and
`A` (adversarial) from `security.json`. Build the augmented machine
`modeled ∪ havoc`, where `havoc` is one action that nondeterministically sets
every `A` variable to any value in its declared (finite) domain. BFS from `init`
over the augmented machine, evaluating security invariants on every state. A
counterexample that uses the havoc edge names the unmediated variable `X`:
*"`φ` violable via unmediated write to `X`."* Repair by routing `X` through an
acceptor gate (moving it into `P`) or hoisting a secret upstream. Converges when
no havoc counterexample survives. Honest note: havoc **over-approximates**, so it
can raise spurious counterexamples (false positives, the safe direction) —
triaged like any Polygraph finding.

**Fully-mediated (gate-deletion) check.** From `security.json.gates`, delete
those transitions from the machine and run reachability to each forbidden
region. A surviving path is a **bypass**; emit the shortest one as the witness.
Relationship to havoc: havoc asks *"are the right variables mediated at all?"*;
gate-deletion asks *"is the mediation non-bypassable in the modeled machine?"*
Both must pass for a fully-mediated verdict.

**Diagnosability gate.** Given the observable projection `π`, determine whether
entering a forbidden region (or a masked edge firing) is detectable from `π`
within a bounded `k`. Construct the observer/twin-plant (two copies synchronized
on observable events); if two runs with identical observable projections can
straddle the region — one inside, one outside — unboundedly, the invariant is
**non-diagnosable**; return the ambiguous state pair and the instruction to add a
variable to `π`. Decidable and tractable over finite domains.

**Recovery-convergence check.** Over the corrective sub-machine (naps in the
danger region, controllable actions only), verify the desired set is reachable
from every danger state without transiting `¬φ`, and that no nap-cycle exists
(nonblocking). Record when the reachable desired set excludes pristine states —
the containment-not-restoration case — as a first-class result, not a warning.

### 4.5 Runtime architecture (`polyrun guard`)

polyrun already mediates every step (one transaction per dispatch; the journal
*is* the `{pre, action, data, post}` stream), so the checker-mediation the
diagnoser needs is free. `guard` adds:

- a **belief-set estimator** consuming the journal, maintaining the set of
  states consistent with the observed projection and the `sensors.mjs` coupling
  invariants;
- an **alarm** on the per-region semantics (`possible` / `certain`);
- a **shield** that, on alarm, presents the corrective nap through the same
  kernel dispatch — so recovery is itself a verified, journaled transition;
- a **fleet aggregator** evaluating cross-instance invariants over the combined
  journal, with fleet-level shields.

`guard` needs **no API key** — it is estimation and exploration over local
state, consistent with polyrun's free-and-deterministic story.

### 4.6 Plugin surface (mirrors the Polygraph layout)

| you type | what it is | when |
|---|---|---|
| `/polysec:harden` | design **skill** | prove a machine's forbidden region is fully mediated; drive the repair loop |
| `polysec harden` | design **command / CLI** | run havoc + gate-deletion + recovery checks over existing artifacts |
| `/polysec:diagnose` | **command** | diagnosability gate + diagnostic-adequacy grade for the monitor |
| `polyrun guard` | runtime **CLI** | run the diagnoser + shield over a live fleet or journal |
| `polysec` | **subagent** | hand off the whole harden loop (author gates/naps, re-check) — extends the polygen agent |

### 4.7 Doctrines (security-specific, added to the repo-wide set)

1. **Prevention in the acceptor, correction in the nap.** Two mechanisms, two
   points; do not conflate them.
2. **Fully-mediated over unreachable.** You cannot promise unreachable over a
   masked machine; you promise every path to danger passes a gate.
3. **Default-deny or it does not count.** A mediator whose else-branch reaches
   anything but a safe state is a finding — unmodeled channels must fail closed.
4. **State adequacy is the price of memorylessness.** Every consequence-bearing
   effect must be carried in a present variable, or the Markov argument is
   unsound.
5. **Recovery is containment, not restoration.** A nap that clears a genuine
   compromise flag has an inadequate state, not a clever recovery.
6. **Diagnosability before monitoring.** If a violation is not detectable from
   the projection, say so and add a sensor — never ship a blind monitor.
7. **The residual is the TCB.** Mediation concentrates risk into a small core;
   name it, and hand its implementation to memory-safety, fuzzing, or audit.

---

## 5. Open questions (the honest to-do)

- **Havoc granularity.** Per-variable havoc over-approximates; is a
  *rate-limited* or *typed* adversary (only certain transitions, not any value)
  a better precision/soundness trade, and does it stay sound?
- **Belief-set blow-up.** The estimator is worst-case exponential in the plant;
  finite domains bound it, but a real fleet may need abstraction/PCT the way
  `check-product` already does. Reuse that machinery?
- **Sensor authoring.** `sensors.mjs` is a new human-judgment surface. Can
  polynv's harvest propose coupling invariants (state-property + precedence
  mining already exist) so sensors arrive pre-checked like invariants?
- **Fleet ground truth.** The diagnostic-adequacy grade needs a wormhole
  catalogue; the fleet-study plan's tiered ground-truth discipline (seeded /
  live / archaeology) should apply here too — seed wormholes, adjudicate blind.
- **Taint soundness.** Implicit flows evade a state bit set only at explicit
  reads. Document the boundary; do not imply non-interference where only access
  control holds.

---

## 6. First build (smallest end-to-end slice)

UC-1, the model sandbox, as the `examples/` anchor mirroring the OMS quartet:

1. A small `capability` SAM v2 module: states track `untrusted`, `sensitive`,
   `egress`, `capabilities`; acceptors are default-deny gates.
2. `security.json` declaring the trifecta forbidden region, the gates, the
   protected/adversarial partition, and a `kill`/`quarantine` recovery.
3. `polysec harden`: show the from-init check clean, then a **havoc**
   counterexample when `egress` is left adversarial, then the repair (route
   `egress` through a gate), then a **gate-deletion bypass** when a second path
   exists, then the fully-mediated verdict once both pass.
4. `polysec diagnose`: the diagnosability gate on the trifecta, then a
   diagnostic-adequacy grade of one coupling sensor (`downloaded ⇒ possible
   egress`) against a family of injected wormholes — e.g. 3/10, with survivors.
5. `polyrun guard`: replay a journal where a wormhole fires; the belief-set
   estimator alarms on the sensor before egress is directly observed; the shield
   kills the sandbox; the compromise flag persists through recovery.

One page, one loop, every new tool exercised once, and it answers the question
that started this: *could this have caught the Hugging Face escape at the design
level?* — with the honest answer already built in (the design finding, yes; the
installer's implementation bug, no — that is the TCB hand-off).
