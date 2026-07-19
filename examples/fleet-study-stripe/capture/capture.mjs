// Fleet-study capture harness (docs/fleet-study-plan.md §5, FS-M2).
//
//   node examples/fleet-study-stripe/capture/capture.mjs --offline [--fleet 400] [--seed 7]
//   node examples/fleet-study-stripe/capture/capture.mjs --live    [--fleet 400] [--seed 7]
//
// Produces, under out/:
//   fleet.json        the snapshot corpus  → `polyvers check --snapshots`
//   traces/*.ndjson   {pre, action, data, post} windows → Polygraph replay
//   manifest.json     provenance: mode, seed, counts, API version, timestamps
//
// TWO MODES, AND THE DIFFERENCE MATTERS FOR EVERY NUMBER DOWNSTREAM:
//
//   --live     drives real Stripe test-mode subscriptions and advances Test
//              Clocks, then reads back status via the API and the Events
//              stream. The fleet is real API state; only its *aging* is
//              simulated. This is the only mode whose corpus may be used for
//              Tier 2 results.
//
//   --offline  drives the verified machine itself through the same
//              trajectories. It exercises the whole pipeline with no key, so
//              the harness is testable — but the corpus is SIMULATED and is
//              circular as evidence about the machine (the machine generated
//              it). manifest.provenance records this, and the Tier 2 report
//              must refuse an offline corpus.
//
// Deterministic in both modes: trajectories come from a seeded PRNG, so a
// given --seed reproduces the same fleet.
'use strict';

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { projectSubscription, actionForEvent, synthesiseTrialEnd } from './stripe-map.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const MACHINE = join(here, '..', 'machines', 'subscription-v1', 'next.cjs');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const LIVE = args.includes('--live');
const OFFLINE = args.includes('--offline');
const FLEET = Number(flag('fleet', 400));
const SEED = Number(flag('seed', 7));
const OUT = resolve(flag('out', join(here, '..', 'out')));

if (LIVE === OFFLINE) {
  console.error('choose exactly one mode: --offline (no key, simulated corpus) or --live (Stripe test mode)');
  process.exit(2);
}

/** mulberry32 — same seeded PRNG the DST simulator uses; no Math.random. */
const rng = ((a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
})(SEED);

/**
 * A trajectory is what we intend to happen to one subscription over the
 * capture window. The mix is chosen to populate the states a real fleet
 * actually holds — including the awkward ones (mid-dunning, unpaid,
 * trial-lapsed-without-card) that a happy-path corpus would never contain,
 * and that are exactly where version changes hurt.
 */
function planTrajectory() {
  const r = rng();
  if (r < 0.26) return { kind: 'trial-converts', trial: true, card: 'good', cycles: 2 };
  if (r < 0.40) return { kind: 'trial-lapses-no-card', trial: true, card: 'none', cycles: 1 };
  if (r < 0.58) return { kind: 'pays-cleanly', trial: false, card: 'good', cycles: 3 };
  if (r < 0.72) return { kind: 'dunning-recovers', trial: false, card: 'flaky', cycles: 3 };
  if (r < 0.84) return { kind: 'dunning-exhausts', trial: false, card: 'bad', cycles: 4, staleAfterEnd: true };
  if (r < 0.94) return { kind: 'cancels-early', trial: false, card: 'good', cycles: 1, cancelAfter: 1, staleAfterEnd: true };
  return { kind: 'expires-incomplete', trial: false, card: 'none', cycles: 0, expire: true, staleAfterEnd: true };
}

/** The stimulus script a trajectory implies, in order. In --live these are
 *  produced BY Stripe (we only advance the clock and read events back); in
 *  --offline we apply them to the machine directly. */
function stimuliFor(t) {
  const out = [];
  if (t.expire) {
    // Never settles the first invoice: Stripe's `incomplete` status exists
    // precisely because that first payment failed, and that failure must NOT
    // enter dunning — the subscription waits to settle or expire. This is the
    // only trajectory that exercises the first-invoice-still-open rule, so it
    // must not attach a card or pay first.
    out.push({ action: 'PAYMENT_FAILED', data: {} });
    out.push({ action: 'INCOMPLETE_EXPIRED', data: {} });
    return withStale(t, out);
  }
  if (t.trial) {
    out.push({ action: 'START_TRIAL', data: { cents: 1500 } });
    if (t.card === 'good') out.push({ action: 'ATTACH_PAYMENT_METHOD', data: {} });
    out.push({ action: 'TRIAL_ENDED', data: {} });
  } else {
    out.push({ action: 'ATTACH_PAYMENT_METHOD', data: {} });
    out.push({ action: 'PAYMENT_SUCCEEDED', data: { cents: 1500 } });
  }
  for (let c = 0; c < t.cycles; c++) {
    if (t.card === 'good') out.push({ action: 'PAYMENT_SUCCEEDED', data: { cents: 1500 } });
    else if (t.card === 'bad') out.push({ action: 'PAYMENT_FAILED', data: {} });
    else if (t.card === 'flaky') out.push(c === 0 ? { action: 'PAYMENT_FAILED', data: {} } : { action: 'PAYMENT_SUCCEEDED', data: { cents: 1500 } });
  }
  if (t.cancelAfter !== undefined) out.push({ action: 'CANCEL', data: {} });
  return withStale(t, out);
}

/** At-least-once webhook delivery is not a hypothetical: Stripe redelivers,
 *  and a final invoice event routinely lands AFTER the subscription has ended.
 *  Those deliveries must be named observable rejections, and a corpus without
 *  them under-tests precisely what the cross-version stimuli gate checks.
 *  (Found by validate_corpus reporting 0 windows for every specialRule on the
 *  first capture.) */
function withStale(t, out) {
  if (t.staleAfterEnd) {
    out.push({ action: 'PAYMENT_FAILED', data: {} });
    out.push({ action: 'PAYMENT_SUCCEEDED', data: { cents: 1500 } });
    out.push({ action: 'CANCEL', data: {} });
  }
  return out;
}

// ---------------------------------------------------------------------------
// offline mode: drive the verified machine
// ---------------------------------------------------------------------------
async function captureOffline() {
  const require_ = createRequire(import.meta.url);
  const mod = require_(MACHINE);
  const { stable } = await import(pathToFileURL(join(repo, 'scripts', 'load-spec.mjs')).href);
  const project = () => JSON.parse(JSON.stringify(mod.getState(), (k, v) =>
    (typeof k === 'string' && k.startsWith('__')) || typeof v === 'function' ? undefined : v));

  const fleet = [], traces = [], seen = new Set();
  for (let i = 0; i < FLEET; i++) {
    const t = planTrajectory();
    mod.init();
    const windows = [];
    // A fleet export is a snapshot at ONE moment, so subscriptions are caught
    // mid-flight — some still trialing, some mid-dunning, some incomplete.
    // Running every trajectory to completion would yield a corpus of settled
    // records only, which is exactly the corpus that hides version-change
    // defects. Each subscription is therefore cut at a seeded point.
    const script = stimuliFor(t);
    const cut = 1 + Math.floor(rng() * script.length);
    for (const s of script.slice(0, cut)) {
      const pre = project();
      try { mod.actions[s.action](s.data); } catch { /* schema reject: an observable no-op */ }
      const post = project();
      // Every delivery is journaled, accepted or rejected — a rejected step
      // is a real window (post === pre) and belongs in the corpus.
      windows.push({ pre, action: s.action, data: s.data, post });
    }
    const final = project();
    const key = stable(final);
    if (!seen.has(key)) { seen.add(key); fleet.push(final); }
    traces.push({ id: `sub-${i}`, kind: t.kind, windows });
  }
  return { fleet, traces, provenance: 'simulated (offline: the machine generated this corpus — NOT admissible as Tier 2 evidence)', apiVersion: null };
}

// ---------------------------------------------------------------------------
// live mode: drive Stripe test mode + Test Clocks
// ---------------------------------------------------------------------------
async function captureLive() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('--live needs STRIPE_SECRET_KEY in the environment (a TEST-mode key: sk_test_...).');
    console.error('This harness never reads a live key and never writes outside test mode.');
    process.exit(2);
  }
  if (!key.startsWith('sk_test_')) {
    console.error('refusing to run: STRIPE_SECRET_KEY is not a test-mode key (expected sk_test_...).');
    process.exit(2);
  }
  let Stripe;
  try { ({ default: Stripe } = await import('stripe')); }
  catch { console.error("--live needs the 'stripe' package: npm i -D stripe"); process.exit(2); }
  const stripe = new Stripe(key);

  // One Test Clock drives the whole fleet, so aging is deterministic and the
  // whole capture advances together.
  const startTs = Math.floor(Date.UTC(2026, 0, 1) / 1000);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: startTs });
  const price = await stripe.prices.create({
    currency: 'usd', unit_amount: 1500,
    recurring: { interval: 'month' },
    product_data: { name: 'Fleet study plan' },
  });

  const CARDS = { good: 'pm_card_visa', bad: 'pm_card_chargeDeclined', flaky: 'pm_card_chargeDeclined', none: null };
  const subs = [];
  for (let i = 0; i < FLEET; i++) {
    const t = planTrajectory();
    const customer = await stripe.customers.create({ test_clock: clock.id, name: `fleet-${i}` });
    let pm = null;
    if (CARDS[t.card]) {
      pm = await stripe.paymentMethods.attach(CARDS[t.card], { customer: customer.id });
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
    }
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      ...(t.trial ? { trial_period_days: 14 } : {}),
      payment_behavior: 'allow_incomplete',
    });
    subs.push({ id: sub.id, customer: customer.id, kind: t.kind, trajectory: t });
  }

  // Advance the clock in monthly steps and read the fleet back after each.
  const traces = new Map(subs.map((s) => [s.id, { id: s.id, kind: s.kind, windows: [] }]));
  const prev = new Map();
  let cursor = startTs;
  const readAll = async (sinceTs) => {
    for (const s of subs) {
      const sub = await stripe.subscriptions.retrieve(s.id, { expand: ['customer'] });
      let openInvoice = null;
      if (['past_due', 'unpaid', 'incomplete'].includes(sub.status)) {
        const inv = await stripe.invoices.list({ subscription: s.id, status: 'open', limit: 1 });
        openInvoice = inv.data[0] ?? null;
      }
      const post = projectSubscription(sub, { openInvoice });
      const pre = prev.get(s.id) ?? null;
      if (pre && JSON.stringify(pre) !== JSON.stringify(post)) {
        // Ask Stripe what actually happened in this window rather than
        // guessing from the state delta.
        const events = await stripe.events.list({ created: { gte: sinceTs }, limit: 100 });
        const mine = events.data.filter((e) => (e.data?.object?.subscription ?? e.data?.object?.id) === s.id);
        let recorded = false;
        for (const ev of mine.reverse()) {
          const mapped = actionForEvent(ev);
          if (!mapped) continue;
          traces.get(s.id).windows.push({ pre, action: mapped.action, data: mapped.data, post, source: ev.type });
          recorded = true;
        }
        if (!recorded) {
          const synth = synthesiseTrialEnd(pre, post);
          if (synth) traces.get(s.id).windows.push({ pre, action: synth.action, data: synth.data, post, synthesised: true });
        }
      }
      prev.set(s.id, post);
    }
  };
  await readAll(cursor);
  for (let month = 0; month < 4; month++) {
    cursor += 32 * 24 * 3600;
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: cursor });
    // advancing is async server-side; poll until the clock settles
    for (let i = 0; i < 60; i++) {
      const c = await stripe.testHelpers.testClocks.retrieve(clock.id);
      if (c.status === 'ready') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    await readAll(cursor - 32 * 24 * 3600);
  }

  const fleet = [], seen = new Set();
  for (const [, p] of prev) {
    const k = JSON.stringify(p);
    if (!seen.has(k)) { seen.add(k); fleet.push(p); }
  }
  return {
    fleet, traces: [...traces.values()],
    provenance: `stripe test mode (test clock ${clock.id}); fleet is real API state, aging advanced deterministically`,
    apiVersion: stripe.getApiField ? stripe.getApiField('version') : null,
  };
}

// ---------------------------------------------------------------------------
const { fleet, traces, provenance, apiVersion } = LIVE ? await captureLive() : await captureOffline();

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'traces'), { recursive: true });
writeFileSync(join(OUT, 'fleet.json'), JSON.stringify(fleet, null, 2) + '\n');
for (const t of traces) {
  if (!t.windows.length) continue;
  writeFileSync(join(OUT, 'traces', `${t.id}_${t.kind}.ndjson`),
    t.windows.map((w) => JSON.stringify({ pre: w.pre, action: w.action, data: w.data, post: w.post })).join('\n') + '\n');
}
const manifest = {
  tool: 'fleet-study capture', mode: LIVE ? 'live' : 'offline',
  provenance,
  admissibleAsTier2: LIVE,
  seed: SEED, requestedFleet: FLEET,
  distinctStates: fleet.length,
  subscriptions: traces.length,
  windows: traces.reduce((a, t) => a + t.windows.length, 0),
  synthesisedWindows: traces.reduce((a, t) => a + t.windows.filter((w) => w.synthesised).length, 0),
  stripeApiVersion: apiVersion,
  projectionBound: 'four keys: subState, dunningAttempts, hasPaymentMethod, cents. Proration, tax, invoice lines, payment-method details, coupons, currency and schedule data are outside every guarantee made from this corpus.',
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`${manifest.mode} capture → ${OUT}`);
console.log(`  subscriptions: ${manifest.subscriptions} · windows: ${manifest.windows} · distinct fleet states: ${manifest.distinctStates}`);
console.log(`  provenance: ${provenance}`);
if (!LIVE) console.log('  NOTE: simulated corpus — exercises the pipeline, NOT admissible as Tier 2 evidence.');
