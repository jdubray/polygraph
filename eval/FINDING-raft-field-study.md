# FINDING — hashicorp/raft field study (July 2026)

First full field application of the verify loop to an external, production
codebase: [hashicorp/raft](https://github.com/hashicorp/raft). Two machines
verified end-to-end — the **role state machine** (Follower / Candidate /
Leader / Shutdown, `raft.go`) and the **commit-index advancement** machine
(`commitment.go`). Working trees: `C:\Users\jjdub\code\osssm\polygraph-raft`
and `...\polygraph-raft-commitment` (contracts, corpora, controls, generated
specs, and per-target `REPORT.md` with source-line citations).

**Headline: no defects found in hashicorp/raft.** Every disagreement was
either a bug in our own hand-written control (caught by the positive-control
step) or a real, intentional design detail (pre-vote deliberately defers the
term bump — "without actually changing our state" — so an observer can catch
either side of it).

## Run summary

| | role machine | commitment machine |
|---|---|---|
| corpus (real, instrumented live 3-node cluster) | 67 windows | 25 windows |
| positive control (hand-written) | 54/67 (13 = the pre-vote timing) | 25/25 (exhaustive, 64 states) |
| negative control (one broken rule) | 44/67 — expected delta | 22/25 — expected delta |
| real run (opus-4.8, n=5) | 35 consistent / 22 spec-error / 10 code-finding / 1 inv | 14 consistent / 11 spec-error / 0 code-finding / 0 inv |
| verdict | timing subtlety, understood; 1 inv unreachable in real code | 4/5 specs shared one misreading; caught by the vote |

## Lessons — each drives a plugin enhancement (see docs/verify-enhancements-plan.md)

1. **The checker is blind behind init-time-fixed fields.** In the commitment
   contract, `startIndex` never changes via any action, so Part 2's BFS from
   `init()` structurally cannot reach the `startIndex=5` scenario that gates
   the safety rule. We proved it: with the safety gate deleted, the model
   check still reported **0 violations** — only replay against the real trace
   caught the injected bug. The tool gave no indication of this blind spot.
   → automatic frozen-field warning (plan M1).

2. **No guardrail against runaway exploration.** The role machine's
   `ElectionTimeout` mints a fresh state forever (term keeps incrementing);
   the default 100,000-state cap meant a 15+ minute run killed by hand.
   → drift detection + progress heartbeat (plan M2).

3. **N-way voting is the safety net, but the vote's own signal is silent.**
   4 of 5 independently generated specs made the *identical* mistake on
   `commitment.go` (collapsed two separately-gated effects — always-update
   `matchIndexes` vs. conditionally-advance `commitIndex` — into one
   all-or-nothing gate). A single generation would have baked that in as
   "verified". The 4-vs-1 split only surfaced because we read the specs by
   hand. → spec-vs-spec agreement report (plan M3).

4. **Negative controls are manual and easy to half-do.** Each one meant
   hand-editing a copy of the control spec and eyeballing which windows
   should now fail. → scripted mutation helper (plan M4).

5. **Traces are the verification, and capture is a craft.** Polling state
   every ~2 ms silently missed *every* Candidate occupancy (elections resolve
   faster); only the library's own Observer event subscription captured them.
   And without real traces there is no Part 1 at all — you are grading your
   own homework. → skill guidance (plan M5).

6. **Cross-model triangulation is a tactic, not a default.** fable-5's five
   generations converged more tightly than opus-4.8's on both machines here —
   useful as a tiebreaker when one model's specs disagree a lot with each
   other, not evidence for a standing model preference.

7. **The positive control earns its keep.** Both hand-written controls
   started with real bugs (a missing Shutdown guard; a wrong invariant).
   "Write it yourself first" is where you find your own misunderstanding
   before reading any generated output.
