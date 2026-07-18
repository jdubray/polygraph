# polyvers product — parent × child JOINT-state model check per version pairing

> 2 unique version pairing(s) explored (identical pairings — by the canonical polyvers versionHash, which hashes each artifact's ENTRY file only — reuse one exploration)

| pairing | verdict | joint states |
|---|---|---|
| parent-old × child-old | PASS | 45 |
| parent-old × child-new | PASS | 45 |
| parent-new × child-old | PASS | 45 |
| parent-new × child-new | PASS | 45 |

## Verdict: PASS

> Scope note: this is the JOINT product model check per version pairing —
> the interleaving class the protocol/delivery matrix recorded as open is
> now checked, from GENESIS under each pairing. Mid-flight JOINT seeding
> (parent + linked children snapshots) is a recorded follow-up
> (docs/composition-plan.md); children with their own mappers are refused
> (grandchildren are out of scope); per-machine mid-flight states are
> covered by the seeded semantic gate, protocol/delivery by
> `polyvers matrix`. Version identity hashes entry files only — a module
> split across require()d helpers memoizes by its entry file.
