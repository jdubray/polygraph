# Intent log

> Rendered from `intent-ledger.json` by `polynv report --log` — do not edit; the ledger is the system of record.

## terminal-absorbing:completed — **confirmed**

- source: template · target: transition
- question: 'completed' is declared terminal. Once orderState == 'completed', can ANY action still change the state? The template proposes: terminal states are frozen — every action arriving in 'completed' is an observable no-op.
- evidence (contract.terminalStates): terminalStates includes 'completed' (terminalKey: orderState)
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => pre["orderState"] !== "completed" || sameOn(["orderState","fulfillments","shipmentsDelivered","shipmentsFailed","totalCents","txId","cancelReason"])(pre, post)` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:17.239Z: disposition confirm by jdubray

## terminal-absorbing:partiallyDelivered — **confirmed**

- source: template · target: transition
- question: 'partiallyDelivered' is declared terminal. Once orderState == 'partiallyDelivered', can ANY action still change the state? The template proposes: terminal states are frozen — every action arriving in 'partiallyDelivered' is an observable no-op.
- evidence (contract.terminalStates): terminalStates includes 'partiallyDelivered' (terminalKey: orderState)
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => pre["orderState"] !== "partiallyDelivered" || sameOn(["orderState","fulfillments","shipmentsDelivered","shipmentsFailed","totalCents","txId","cancelReason"])(pre, post)` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:19.340Z: disposition confirm by jdubray

## terminal-absorbing:rejected — **confirmed**

- source: template · target: transition
- question: 'rejected' is declared terminal. Once orderState == 'rejected', can ANY action still change the state? The template proposes: terminal states are frozen — every action arriving in 'rejected' is an observable no-op.
- evidence (contract.terminalStates): terminalStates includes 'rejected' (terminalKey: orderState)
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => pre["orderState"] !== "rejected" || sameOn(["orderState","fulfillments","shipmentsDelivered","shipmentsFailed","totalCents","txId","cancelReason"])(pre, post)` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:21.436Z: disposition confirm by jdubray

## terminal-absorbing:paymentFailed — **confirmed**

- source: template · target: transition
- question: 'paymentFailed' is declared terminal. Once orderState == 'paymentFailed', can ANY action still change the state? The template proposes: terminal states are frozen — every action arriving in 'paymentFailed' is an observable no-op.
- evidence (contract.terminalStates): terminalStates includes 'paymentFailed' (terminalKey: orderState)
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => pre["orderState"] !== "paymentFailed" || sameOn(["orderState","fulfillments","shipmentsDelivered","shipmentsFailed","totalCents","txId","cancelReason"])(pre, post)` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:23.523Z: disposition confirm by jdubray

## terminal-absorbing:cancelled — **confirmed**

- source: template · target: transition
- question: 'cancelled' is declared terminal. Once orderState == 'cancelled', can ANY action still change the state? The template proposes: terminal states are frozen — every action arriving in 'cancelled' is an observable no-op.
- evidence (contract.terminalStates): terminalStates includes 'cancelled' (terminalKey: orderState)
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => pre["orderState"] !== "cancelled" || sameOn(["orderState","fulfillments","shipmentsDelivered","shipmentsFailed","totalCents","txId","cancelReason"])(pre, post)` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:25.438Z: disposition confirm by jdubray

## range:fulfillments — **confirmed**

- source: template · target: state
- question: The contract types 'fulfillments' as 0..2. Must every reachable state keep it in that range? (A reachable value outside it would mean the type annotation is a lie.)
- evidence (contract.stateKeys.fulfillments.type): integer 0..2 — number of shipments this order splits into (0 until submitted)
- pre-check: HOLDS
- predicate versions:
  1. `(s) => typeof s["fulfillments"] === 'number' && s["fulfillments"] >= 0 && s["fulfillments"] <= 2` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:34.255Z: disposition confirm by jdubray

## monotone:fulfillments — **rejected**

- source: template · target: transition
- question: Is 'fulfillments' monotone — can it ever DECREASE across a transition? (If a decrease is legitimate — a reset, an amendment — reject this candidate and the reset becomes a recorded, deliberate answer.)
- evidence (contract.stateKeys.fulfillments.type): integer 0..2 — number of shipments this order splits into (0 until submitted)
- pre-check: FAILS — violated by AMEND
- predicate versions:
  1. `(pre, action, data, post) => post["fulfillments"] >= pre["fulfillments"]` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:39:07.476Z: disposition reject by jdubray — AMEND legitimately lowers the fulfillment count; intended

## range:shipmentsDelivered — **confirmed**

- source: template · target: state
- question: The contract types 'shipmentsDelivered' as 0..2. Must every reachable state keep it in that range? (A reachable value outside it would mean the type annotation is a lie.)
- evidence (contract.stateKeys.shipmentsDelivered.type): integer 0..2 — shipments that completed with outcome 'delivered'
- pre-check: HOLDS
- predicate versions:
  1. `(s) => typeof s["shipmentsDelivered"] === 'number' && s["shipmentsDelivered"] >= 0 && s["shipmentsDelivered"] <= 2` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:36.229Z: disposition confirm by jdubray

## monotone:shipmentsDelivered — **confirmed**

- source: template · target: transition
- question: Is 'shipmentsDelivered' monotone — can it ever DECREASE across a transition? (If a decrease is legitimate — a reset, an amendment — reject this candidate and the reset becomes a recorded, deliberate answer.)
- evidence (contract.stateKeys.shipmentsDelivered.type): integer 0..2 — shipments that completed with outcome 'delivered'
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => post["shipmentsDelivered"] >= pre["shipmentsDelivered"]` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:42.283Z: disposition confirm by jdubray

## range:shipmentsFailed — **confirmed**

- source: template · target: state
- question: The contract types 'shipmentsFailed' as 0..2. Must every reachable state keep it in that range? (A reachable value outside it would mean the type annotation is a lie.)
- evidence (contract.stateKeys.shipmentsFailed.type): integer 0..2 — shipments that completed with outcome 'cancelledShipment'
- pre-check: HOLDS
- predicate versions:
  1. `(s) => typeof s["shipmentsFailed"] === 'number' && s["shipmentsFailed"] >= 0 && s["shipmentsFailed"] <= 2` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:38.219Z: disposition confirm by jdubray

## monotone:shipmentsFailed — **confirmed**

- source: template · target: transition
- question: Is 'shipmentsFailed' monotone — can it ever DECREASE across a transition? (If a decrease is legitimate — a reset, an amendment — reject this candidate and the reset becomes a recorded, deliberate answer.)
- evidence (contract.stateKeys.shipmentsFailed.type): integer 0..2 — shipments that completed with outcome 'cancelledShipment'
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => post["shipmentsFailed"] >= pre["shipmentsFailed"]` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:44.317Z: disposition confirm by jdubray

## nonneg:totalCents — **confirmed**

- source: template · target: state
- question: The contract types 'totalCents' as a non-negative integer. Must every reachable state keep it >= 0?
- evidence (contract.stateKeys.totalCents.type): integer >= 0, order total in cents
- pre-check: HOLDS
- predicate versions:
  1. `(s) => typeof s["totalCents"] === 'number' && s["totalCents"] >= 0` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:40.191Z: disposition confirm by jdubray

## monotone:totalCents — **rejected**

- source: template · target: transition
- question: Is 'totalCents' monotone — can it ever DECREASE across a transition? (If a decrease is legitimate — a reset, an amendment — reject this candidate and the reset becomes a recorded, deliberate answer.)
- evidence (contract.stateKeys.totalCents.type): integer >= 0, order total in cents
- pre-check: FAILS — violated by AMEND
- predicate versions:
  1. `(pre, action, data, post) => post["totalCents"] >= pre["totalCents"]` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:39:05.640Z: disposition reject by jdubray — AMEND legitimately lowers the total (items-unavailable renegotiation); the decrease is intended

## set-once:txId — **confirmed**

- source: template · target: transition
- question: 'txId' starts empty (''). Once it is set to a non-empty value, may it ever change again? The template proposes: set once, then immutable.
- evidence (contract.stateKeys.txId.type + initState): string, payment transaction id ('' until charged) (initState: '')
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => pre["txId"] === "" || post["txId"] === pre["txId"]` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:27.559Z: disposition confirm by jdubray

## set-once:cancelReason — **confirmed**

- source: template · target: transition
- question: 'cancelReason' starts empty (''). Once it is set to a non-empty value, may it ever change again? The template proposes: set once, then immutable.
- evidence (contract.stateKeys.cancelReason.type + initState): string, why the order ended early ('' otherwise) (initState: '')
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => pre["cancelReason"] === "" || post["cancelReason"] === pre["cancelReason"]` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:46.468Z: disposition confirm by jdubray

## reject-in-state:cancel-blocked-while-charging — **confirmed**

- source: template · target: transition
- question: The contract's rule 'cancel-blocked-while-charging' says CANCEL arriving while orderState == 'charging' is rejected. Must that rejection leave the state COMPLETELY unchanged — an observable no-op, never a partial mutation?
- evidence (contract.specialRules['cancel-blocked-while-charging']): CANCEL while orderState == 'charging' is rejected (reason = this rule's name): a charge decision is in flight and must resolve first.
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => !(["CANCEL"].includes(action) && pre["orderState"] === "charging") || sameOn(["orderState","fulfillments","shipmentsDelivered","shipmentsFailed","totalCents","txId","cancelReason"])(pre, post)` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:29.561Z: disposition confirm by jdubray

## reject-in-state:fulfillment-in-progress — **confirmed**

- source: template · target: transition
- question: The contract's rule 'fulfillment-in-progress' says CANCEL arriving while orderState == 'fulfilling' is rejected. Must that rejection leave the state COMPLETELY unchanged — an observable no-op, never a partial mutation?
- evidence (contract.specialRules['fulfillment-in-progress']): CANCEL while orderState == 'fulfilling' is rejected (reason = this rule's name): shipments are already with couriers; per-shipment cancellation is the shipment machine's business, not the order's.
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => !(["CANCEL"].includes(action) && pre["orderState"] === "fulfilling") || sameOn(["orderState","fulfillments","shipmentsDelivered","shipmentsFailed","totalCents","txId","cancelReason"])(pre, post)` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:31.760Z: disposition confirm by jdubray

## emission-at-most-once:fraudCheck — **confirmed**

- source: template · target: emission
- question: The manifest declares effect 'fraudCheck'. Can it ever be emitted TWICE for one instance? (For a payment effect the domain answer is usually "never"; if at-most-once is intended, this becomes an emission invariant for polyrun check-effects.)
- evidence (effects.manifest.json): effects.fraudCheck
- pre-check: HOLDS
- predicate versions:
  1. `null` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:40:48.464Z: disposition confirm by jdubray

## emission-at-most-once:chargeCard — **confirmed**

- source: template · target: emission
- question: The manifest declares effect 'chargeCard'. Can it ever be emitted TWICE for one instance? (For a payment effect the domain answer is usually "never"; if at-most-once is intended, this becomes an emission invariant for polyrun check-effects.)
- evidence (effects.manifest.json): effects.chargeCard
- pre-check: HOLDS
- predicate versions:
  1. `null` (harvest, 2026-07-18T13:37:07.367Z)
- events:
  - 2026-07-18T13:37:07.367Z: harvested
  - 2026-07-18T13:37:07.367Z: precheck
  - 2026-07-18T13:39:13.820Z: disposition confirm by jdubray

## prior:no-charge-without-fraud-pass — **confirmed**

- source: domain-prior · target: transition
- domain prior: payments — "no capture without a prior authorization step" (claude-fable-5, 2026-07-18T13:37:27.705Z)
- question: Payments norm (authorization-before-capture): can a charge ever be recorded (txId set) without the fraud check having passed first — i.e. from any state other than 'charging'?
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => post.txId === pre.txId || (action === 'CHARGE_SUCCEEDED' && pre.orderState === 'charging')` (agent:claude-fable-5, 2026-07-18T13:37:27.705Z)
- events:
  - 2026-07-18T13:37:27.705Z: added by agent:claude-fable-5
  - 2026-07-18T13:37:27.705Z: precheck
  - 2026-07-18T13:39:09.500Z: disposition confirm by jdubray

## prior:cancel-reason-always-recorded — **confirmed**

- source: domain-prior · target: transition
- domain prior: payments — "terminal failure states carry an auditable reason" (claude-fable-5, 2026-07-18T13:37:29.863Z)
- question: Audit norm: when an order ends by cancellation or rejection, must the reason ALWAYS be recorded (cancelReason non-empty in 'cancelled' and 'rejected')?
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => !['cancelled','rejected'].includes(post.orderState) || post.cancelReason !== ''` (agent:claude-fable-5, 2026-07-18T13:37:29.863Z)
- events:
  - 2026-07-18T13:37:29.863Z: added by agent:claude-fable-5
  - 2026-07-18T13:37:29.863Z: precheck
  - 2026-07-18T13:39:11.687Z: disposition confirm by jdubray

## mutation-survivor:drop:AMEND@"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'AMEND' in orderState="awaitingAmend" no longer does anything (guard negated to a reject). Concretely: AMEND({"fulfillments":1,"totalCents":1900}) on {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":1900,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'AMEND' in orderState="awaitingAmend" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:AMEND_WINDOW_EXPIRED@"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'AMEND_WINDOW_EXPIRED' in orderState="awaitingAmend" no longer does anything (guard negated to a reject). Concretely: AMEND_WINDOW_EXPIRED({}) on {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"cancelled","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"amend-window-expired"}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'AMEND_WINDOW_EXPIRED' in orderState="awaitingAmend" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:CANCEL@"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CANCEL' in orderState="awaitingAmend" no longer does anything (guard negated to a reject). Concretely: CANCEL({"reason":"customer-request"}) on {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"cancelled","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"customer-request"}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CANCEL' in orderState="awaitingAmend" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:CANCEL@"fraudCheck" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CANCEL' in orderState="fraudCheck" no longer does anything (guard negated to a reject). Concretely: CANCEL({"reason":"customer-request"}) on {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"cancelled","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"customer-request"}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CANCEL' in orderState="fraudCheck" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:CANCEL@"pending" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CANCEL' in orderState="pending" no longer does anything (guard negated to a reject). Concretely: CANCEL({"reason":"customer-request"}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} (the real machine yields {"orderState":"cancelled","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":"customer-request"}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CANCEL' in orderState="pending" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:CHARGE_FAILED@"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_FAILED' in orderState="charging" no longer does anything (guard negated to a reject). Concretely: CHARGE_FAILED({"reason":"declined"}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"paymentFailed","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"declined"}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_FAILED' in orderState="charging" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:CHARGE_SUCCEEDED@"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_SUCCEEDED' in orderState="charging" no longer does anything (guard negated to a reject). Concretely: CHARGE_SUCCEEDED({"txId":"tx-1"}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_SUCCEEDED' in orderState="charging" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:CHARGE_TIMED_OUT@"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_TIMED_OUT' in orderState="charging" no longer does anything (guard negated to a reject). Concretely: CHARGE_TIMED_OUT({}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"paymentFailed","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"charge-timed-out"}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_TIMED_OUT' in orderState="charging" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:FRAUD_FAILED@"fraudCheck" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'FRAUD_FAILED' in orderState="fraudCheck" no longer does anything (guard negated to a reject). Concretely: FRAUD_FAILED({"reason":"suspicious"}) on {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"rejected","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"suspicious"}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'FRAUD_FAILED' in orderState="fraudCheck" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:FRAUD_PASSED@"fraudCheck" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'FRAUD_PASSED' in orderState="fraudCheck" no longer does anything (guard negated to a reject). Concretely: FRAUD_PASSED({"itemsAvailable":true}) on {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'FRAUD_PASSED' in orderState="fraudCheck" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:SHIPMENT_COMPLETED@"fulfilling" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'SHIPMENT_COMPLETED' in orderState="fulfilling" no longer does anything (guard negated to a reject). Concretely: SHIPMENT_COMPLETED({"childKey":"f1","childState":{"shipState":"delivered"}}) on {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} would yield {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} (the real machine yields {"orderState":"completed","fulfillments":1,"shipmentsDelivered":1,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'SHIPMENT_COMPLETED' in orderState="fulfilling" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:drop:SUBMIT@"pending" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'SUBMIT' in orderState="pending" no longer does anything (guard negated to a reject). Concretely: SUBMIT({"fulfillments":1,"totalCents":2500}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} (the real machine yields {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'SUBMIT' in orderState="pending" no longer does anything (guard negated to a reject)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:retarget:CHARGE_SUCCEEDED@"charging"->"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_SUCCEEDED' in orderState="charging" lands in orderState="awaitingAmend" instead. Concretely: CHARGE_SUCCEEDED({"txId":"tx-1"}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} (the real machine yields {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_SUCCEEDED' in orderState="charging" lands in orderState="awaitingAmend" instead
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:retarget:SUBMIT@"pending"->"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'SUBMIT' in orderState="pending" lands in orderState="awaitingAmend" instead. Concretely: SUBMIT({"fulfillments":1,"totalCents":2500}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'SUBMIT' in orderState="pending" lands in orderState="awaitingAmend" instead
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:widen:AMEND@"charging"<-"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'AMEND' now ACCEPTED in orderState="charging" (applied as it is in orderState="awaitingAmend"). Concretely: AMEND({"fulfillments":1,"totalCents":1900}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":1900,"txId":"","cancelReason":""} (the real machine yields {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'AMEND' now ACCEPTED in orderState="charging" (applied as it is in orderState="awaitingAmend")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:widen:AMEND@"fraudCheck"<-"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'AMEND' now ACCEPTED in orderState="fraudCheck" (applied as it is in orderState="awaitingAmend"). Concretely: AMEND({"fulfillments":1,"totalCents":1900}) on {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":1900,"txId":"","cancelReason":""} (the real machine yields {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'AMEND' now ACCEPTED in orderState="fraudCheck" (applied as it is in orderState="awaitingAmend")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:widen:AMEND@"pending"<-"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'AMEND' now ACCEPTED in orderState="pending" (applied as it is in orderState="awaitingAmend"). Concretely: AMEND({"fulfillments":1,"totalCents":1900}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":1900,"txId":"","cancelReason":""} (the real machine yields {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'AMEND' now ACCEPTED in orderState="pending" (applied as it is in orderState="awaitingAmend")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:widen:AMEND_WINDOW_EXPIRED@"charging"<-"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'AMEND_WINDOW_EXPIRED' now ACCEPTED in orderState="charging" (applied as it is in orderState="awaitingAmend"). Concretely: AMEND_WINDOW_EXPIRED({}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"cancelled","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"amend-window-expired"} (the real machine yields {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'AMEND_WINDOW_EXPIRED' now ACCEPTED in orderState="charging" (applied as it is in orderState="awaitingAmend")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:widen:AMEND_WINDOW_EXPIRED@"fraudCheck"<-"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'AMEND_WINDOW_EXPIRED' now ACCEPTED in orderState="fraudCheck" (applied as it is in orderState="awaitingAmend"). Concretely: AMEND_WINDOW_EXPIRED({}) on {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"cancelled","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"amend-window-expired"} (the real machine yields {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'AMEND_WINDOW_EXPIRED' now ACCEPTED in orderState="fraudCheck" (applied as it is in orderState="awaitingAmend")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:widen:AMEND_WINDOW_EXPIRED@"fulfilling"<-"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'AMEND_WINDOW_EXPIRED' now ACCEPTED in orderState="fulfilling" (applied as it is in orderState="awaitingAmend"). Concretely: AMEND_WINDOW_EXPIRED({}) on {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} would yield {"orderState":"cancelled","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":"amend-window-expired"} (the real machine yields {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'AMEND_WINDOW_EXPIRED' now ACCEPTED in orderState="fulfilling" (applied as it is in orderState="awaitingAmend")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:40:50.298Z: harvested
  - 2026-07-18T13:40:50.298Z: precheck

## mutation-survivor:widen:AMEND_WINDOW_EXPIRED@"pending"<-"awaitingAmend" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'AMEND_WINDOW_EXPIRED' now ACCEPTED in orderState="pending" (applied as it is in orderState="awaitingAmend"). Concretely: AMEND_WINDOW_EXPIRED({}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"cancelled","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":"amend-window-expired"} (the real machine yields {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'AMEND_WINDOW_EXPIRED' now ACCEPTED in orderState="pending" (applied as it is in orderState="awaitingAmend")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:CHARGE_FAILED@"awaitingAmend"<-"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_FAILED' now ACCEPTED in orderState="awaitingAmend" (applied as it is in orderState="charging"). Concretely: CHARGE_FAILED({"reason":"declined"}) on {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"paymentFailed","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"declined"} (the real machine yields {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_FAILED' now ACCEPTED in orderState="awaitingAmend" (applied as it is in orderState="charging")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:CHARGE_FAILED@"fraudCheck"<-"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_FAILED' now ACCEPTED in orderState="fraudCheck" (applied as it is in orderState="charging"). Concretely: CHARGE_FAILED({"reason":"declined"}) on {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"paymentFailed","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"declined"} (the real machine yields {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_FAILED' now ACCEPTED in orderState="fraudCheck" (applied as it is in orderState="charging")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:CHARGE_FAILED@"fulfilling"<-"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_FAILED' now ACCEPTED in orderState="fulfilling" (applied as it is in orderState="charging"). Concretely: CHARGE_FAILED({"reason":"declined"}) on {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} would yield {"orderState":"paymentFailed","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":"declined"} (the real machine yields {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_FAILED' now ACCEPTED in orderState="fulfilling" (applied as it is in orderState="charging")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:CHARGE_FAILED@"pending"<-"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_FAILED' now ACCEPTED in orderState="pending" (applied as it is in orderState="charging"). Concretely: CHARGE_FAILED({"reason":"declined"}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"paymentFailed","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":"declined"} (the real machine yields {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_FAILED' now ACCEPTED in orderState="pending" (applied as it is in orderState="charging")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:CHARGE_TIMED_OUT@"awaitingAmend"<-"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_TIMED_OUT' now ACCEPTED in orderState="awaitingAmend" (applied as it is in orderState="charging"). Concretely: CHARGE_TIMED_OUT({}) on {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"paymentFailed","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"charge-timed-out"} (the real machine yields {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_TIMED_OUT' now ACCEPTED in orderState="awaitingAmend" (applied as it is in orderState="charging")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:CHARGE_TIMED_OUT@"fraudCheck"<-"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_TIMED_OUT' now ACCEPTED in orderState="fraudCheck" (applied as it is in orderState="charging"). Concretely: CHARGE_TIMED_OUT({}) on {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"paymentFailed","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"charge-timed-out"} (the real machine yields {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_TIMED_OUT' now ACCEPTED in orderState="fraudCheck" (applied as it is in orderState="charging")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:CHARGE_TIMED_OUT@"fulfilling"<-"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_TIMED_OUT' now ACCEPTED in orderState="fulfilling" (applied as it is in orderState="charging"). Concretely: CHARGE_TIMED_OUT({}) on {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} would yield {"orderState":"paymentFailed","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":"charge-timed-out"} (the real machine yields {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_TIMED_OUT' now ACCEPTED in orderState="fulfilling" (applied as it is in orderState="charging")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:CHARGE_TIMED_OUT@"pending"<-"charging" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'CHARGE_TIMED_OUT' now ACCEPTED in orderState="pending" (applied as it is in orderState="charging"). Concretely: CHARGE_TIMED_OUT({}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"paymentFailed","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":"charge-timed-out"} (the real machine yields {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'CHARGE_TIMED_OUT' now ACCEPTED in orderState="pending" (applied as it is in orderState="charging")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:FRAUD_FAILED@"awaitingAmend"<-"fraudCheck" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'FRAUD_FAILED' now ACCEPTED in orderState="awaitingAmend" (applied as it is in orderState="fraudCheck"). Concretely: FRAUD_FAILED({"reason":"suspicious"}) on {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"rejected","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"suspicious"} (the real machine yields {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'FRAUD_FAILED' now ACCEPTED in orderState="awaitingAmend" (applied as it is in orderState="fraudCheck")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:FRAUD_FAILED@"charging"<-"fraudCheck" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'FRAUD_FAILED' now ACCEPTED in orderState="charging" (applied as it is in orderState="fraudCheck"). Concretely: FRAUD_FAILED({"reason":"suspicious"}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"rejected","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":"suspicious"} (the real machine yields {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'FRAUD_FAILED' now ACCEPTED in orderState="charging" (applied as it is in orderState="fraudCheck")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:FRAUD_FAILED@"fulfilling"<-"fraudCheck" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'FRAUD_FAILED' now ACCEPTED in orderState="fulfilling" (applied as it is in orderState="fraudCheck"). Concretely: FRAUD_FAILED({"reason":"suspicious"}) on {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} would yield {"orderState":"rejected","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":"suspicious"} (the real machine yields {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'FRAUD_FAILED' now ACCEPTED in orderState="fulfilling" (applied as it is in orderState="fraudCheck")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:FRAUD_FAILED@"pending"<-"fraudCheck" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'FRAUD_FAILED' now ACCEPTED in orderState="pending" (applied as it is in orderState="fraudCheck"). Concretely: FRAUD_FAILED({"reason":"suspicious"}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"rejected","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":"suspicious"} (the real machine yields {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'FRAUD_FAILED' now ACCEPTED in orderState="pending" (applied as it is in orderState="fraudCheck")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:FRAUD_PASSED@"awaitingAmend"<-"fraudCheck" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'FRAUD_PASSED' now ACCEPTED in orderState="awaitingAmend" (applied as it is in orderState="fraudCheck"). Concretely: FRAUD_PASSED({"itemsAvailable":true}) on {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'FRAUD_PASSED' now ACCEPTED in orderState="awaitingAmend" (applied as it is in orderState="fraudCheck")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:FRAUD_PASSED@"charging"<-"fraudCheck" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'FRAUD_PASSED' now ACCEPTED in orderState="charging" (applied as it is in orderState="fraudCheck"). Concretely: FRAUD_PASSED({"itemsAvailable":false}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'FRAUD_PASSED' now ACCEPTED in orderState="charging" (applied as it is in orderState="fraudCheck")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:FRAUD_PASSED@"pending"<-"fraudCheck" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'FRAUD_PASSED' now ACCEPTED in orderState="pending" (applied as it is in orderState="fraudCheck"). Concretely: FRAUD_PASSED({"itemsAvailable":true}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"charging","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} (the real machine yields {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'FRAUD_PASSED' now ACCEPTED in orderState="pending" (applied as it is in orderState="fraudCheck")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:SHIPMENT_COMPLETED@"charging"<-"fulfilling" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'SHIPMENT_COMPLETED' now ACCEPTED in orderState="charging" (applied as it is in orderState="fulfilling"). Concretely: SHIPMENT_COMPLETED({"childKey":"f1","childState":{"shipState":"delivered"}}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"completed","fulfillments":1,"shipmentsDelivered":1,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'SHIPMENT_COMPLETED' now ACCEPTED in orderState="charging" (applied as it is in orderState="fulfilling")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:SUBMIT@"awaitingAmend"<-"pending" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'SUBMIT' now ACCEPTED in orderState="awaitingAmend" (applied as it is in orderState="pending"). Concretely: SUBMIT({"fulfillments":1,"totalCents":2500}) on {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"awaitingAmend","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'SUBMIT' now ACCEPTED in orderState="awaitingAmend" (applied as it is in orderState="pending")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:SUBMIT@"charging"<-"pending" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'SUBMIT' now ACCEPTED in orderState="charging" (applied as it is in orderState="pending"). Concretely: SUBMIT({"fulfillments":1,"totalCents":2500}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'SUBMIT' now ACCEPTED in orderState="charging" (applied as it is in orderState="pending")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:widen:SUBMIT@"fraudCheck"<-"pending" — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: 'SUBMIT' now ACCEPTED in orderState="fraudCheck" (applied as it is in orderState="pending"). Concretely: SUBMIT({"fulfillments":2,"totalCents":2500}) on {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"fraudCheck","fulfillments":2,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): 'SUBMIT' now ACCEPTED in orderState="fraudCheck" (applied as it is in orderState="pending")
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:freeze:fulfillments — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: updates to 'fulfillments' are silently dropped (every post keeps the pre value). Concretely: SUBMIT({"fulfillments":1,"totalCents":2500}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"fraudCheck","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): updates to 'fulfillments' are silently dropped (every post keeps the pre value)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:freeze:shipmentsDelivered — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: updates to 'shipmentsDelivered' are silently dropped (every post keeps the pre value). Concretely: SHIPMENT_COMPLETED({"childKey":"f1","childState":{"shipState":"delivered"}}) on {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} would yield {"orderState":"completed","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} (the real machine yields {"orderState":"completed","fulfillments":1,"shipmentsDelivered":1,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): updates to 'shipmentsDelivered' are silently dropped (every post keeps the pre value)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:freeze:shipmentsFailed — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: updates to 'shipmentsFailed' are silently dropped (every post keeps the pre value). Concretely: SHIPMENT_COMPLETED({"childKey":"f1","childState":{"shipState":"cancelledShipment"}}) on {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} would yield {"orderState":"partiallyDelivered","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""} (the real machine yields {"orderState":"partiallyDelivered","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":1,"totalCents":2500,"txId":"tx-1","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): updates to 'shipmentsFailed' are silently dropped (every post keeps the pre value)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:freeze:totalCents — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: updates to 'totalCents' are silently dropped (every post keeps the pre value). Concretely: SUBMIT({"fulfillments":1,"totalCents":2500}) on {"orderState":"pending","fulfillments":0,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} would yield {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":0,"txId":"","cancelReason":""} (the real machine yields {"orderState":"fraudCheck","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): updates to 'totalCents' are silently dropped (every post keeps the pre value)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## mutation-survivor:freeze:txId — **open**

- source: mutation-survivor · target: transition
- question: NO confirmed invariant constrains this behavior change: updates to 'txId' are silently dropped (every post keeps the pre value). Concretely: CHARGE_SUCCEEDED({"txId":"tx-1"}) on {"orderState":"charging","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} would yield {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"","cancelReason":""} (the real machine yields {"orderState":"fulfilling","fulfillments":1,"shipmentsDelivered":0,"shipmentsFailed":0,"totalCents":2500,"txId":"tx-1","cancelReason":""}). Which rule should forbid it? Supply one (disposition modify, then confirm) — or abandon it as genuinely out-of-intent.
- evidence (mutation-survivor): updates to 'txId' are silently dropped (every post keeps the pre value)
- pre-check: NOT-RUN — no predicate yet — supply the rule via `record --disposition modify`, or abandon as out-of-intent
- events:
  - 2026-07-18T13:41:09.039Z: harvested
  - 2026-07-18T13:41:09.039Z: precheck

## designer:stale-completions-are-noops — **confirmed**

- source: designer · target: transition
- question: Completions/timers arriving in any state other than the one awaiting them must leave the state completely unchanged (at-least-once delivery).
- pre-check: HOLDS
- predicate versions:
  1. `(pre, action, data, post) => { const AW = { FRAUD_PASSED: 'fraudCheck', FRAUD_FAILED: 'fraudCheck', CHARGE_SUCCEEDED: 'charging', CHARGE_FAILED: 'charging', CHARGE_TIMED_OUT: 'charging', AMEND_WINDOW_EXPIRED: 'awaitingAmend', SHIPMENT_COMPLETED: 'fulfilling' }; return !(action in AW) || pre.orderState === AW[action] || ['orderState','fulfillments','shipmentsDelivered','shipmentsFailed','totalCents','txId','cancelReason'].every((k) => pre[k] === post[k]); }` (agent:claude-fable-5, 2026-07-18T13:42:35.881Z)
- events:
  - 2026-07-18T13:42:35.881Z: added by agent:claude-fable-5
  - 2026-07-18T13:42:35.881Z: precheck
  - 2026-07-18T13:42:38.032Z: disposition confirm by jdubray
