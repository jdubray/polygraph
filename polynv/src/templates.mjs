// polynv harvest source 2 — contract-structure templates.
//
// The contract's declared vocabulary (state keys with typed prose, terminal
// states, special rules, effect kinds) generates a finite checklist of
// invariant *questions*. This is the harvest source that can propose rules
// the code currently VIOLATES — mining, by construction, cannot — and it is
// exhaustive over the vocabulary in a way a human staring at a blank
// invariants.mjs never is.
//
// Every output is a CANDIDATE (a question with evidence), never a rule:
// nothing here enters invariants.mjs without a human disposition (the §1
// design rule in docs/polynv-plan.md). Deterministic, no API key.
'use strict';

import { observableKeys, terminalKeyOf } from '../../polyvers/src/artifacts.mjs';
import { renderJs } from './nf.mjs';

// Type prose parsers — the contract's stateKeys[].type strings are prose by
// design; we template ONLY what parses mechanically and note what does not.
const RANGE_RE = /integer\s+(-?\d+)\s*\.\.\s*(-?\d+)/;
const NONNEG_RE = /integer\s*>=\s*0/;
const WHEN_STATE_RE = /^\s*(\w+)\s*==\s*'([^']+)'\s*$/;

const candidate = ({ id, target, nf, question, evidence }) => ({
  id, source: 'template', target, nf, js: nf ? renderJs(nf) : null, question, evidence,
});

/**
 * Generate template candidates from a contract (+ optional effects manifest).
 * Returns { candidates, notes } — notes name every vocabulary item that LOOKED
 * templatable but was not mechanically parseable (a question to ask by hand,
 * never a silent skip).
 */
export function harvestTemplates(contract, manifest = null) {
  const candidates = [];
  const notes = [];
  const stateKeys = observableKeys(contract) || [];
  const terminalKey = terminalKeyOf(contract);
  const init = contract.initState || {};

  // ── terminal states: absorbing? ──────────────────────────────────────────
  if (terminalKey && Array.isArray(contract.terminalStates)) {
    for (const value of contract.terminalStates) {
      candidates.push(candidate({
        id: `terminal-absorbing:${value}`,
        target: 'transition',
        nf: { kind: 'terminal-absorbing', key: terminalKey, value, stateKeys },
        question: `'${value}' is declared terminal. Once ${terminalKey} == '${value}', can ANY action still change the state? The template proposes: terminal states are frozen — every action arriving in '${value}' is an observable no-op.`,
        evidence: { from: 'contract.terminalStates', quote: `terminalStates includes '${value}' (terminalKey: ${terminalKey})` },
      }));
    }
  } else {
    notes.push('contract declares no terminalKey/terminalStates — no terminal-absorbing templates generated; if the machine has terminal states, that is itself a contract gap worth raising');
  }

  // ── typed state keys: bounds, sign, set-once, monotonicity ───────────────
  for (const sk of contract.stateKeys || []) {
    const { name: field, type = '' } = sk;
    const range = type.match(RANGE_RE);
    if (range) {
      const [min, max] = [Number(range[1]), Number(range[2])];
      candidates.push(candidate({
        id: `range:${field}`,
        target: 'state',
        nf: { kind: 'range', field, min, max },
        question: `The contract types '${field}' as ${min}..${max}. Must every reachable state keep it in that range? (A reachable value outside it would mean the type annotation is a lie.)`,
        evidence: { from: `contract.stateKeys.${field}.type`, quote: type },
      }));
    } else if (NONNEG_RE.test(type)) {
      candidates.push(candidate({
        id: `nonneg:${field}`,
        target: 'state',
        nf: { kind: 'nonneg', field },
        question: `The contract types '${field}' as a non-negative integer. Must every reachable state keep it >= 0?`,
        evidence: { from: `contract.stateKeys.${field}.type`, quote: type },
      }));
    }
    if (range || NONNEG_RE.test(type)) {
      candidates.push(candidate({
        id: `monotone:${field}`,
        target: 'transition',
        nf: { kind: 'monotone', field },
        question: `Is '${field}' monotone — can it ever DECREASE across a transition? (If a decrease is legitimate — a reset, an amendment — reject this candidate and the reset becomes a recorded, deliberate answer.)`,
        evidence: { from: `contract.stateKeys.${field}.type`, quote: type },
      }));
    }
    if (/string/.test(type) && field !== terminalKey && init[field] === '') {
      candidates.push(candidate({
        id: `set-once:${field}`,
        target: 'transition',
        nf: { kind: 'set-once', field, empty: '' },
        question: `'${field}' starts empty (''). Once it is set to a non-empty value, may it ever change again? The template proposes: set once, then immutable.`,
        evidence: { from: `contract.stateKeys.${field}.type + initState`, quote: `${type} (initState: '')` },
      }));
    }
  }

  // ── special rules that describe rejections: are they real? ───────────────
  for (const rule of contract.specialRules || []) {
    if (!/reject/i.test(rule.note || '')) continue;
    const when = (rule.whenState || '').match(WHEN_STATE_RE);
    const actions = (rule.whenAction || '').split('|').map((a) => a.trim()).filter(Boolean);
    const declared = actions.length && actions.every((a) => contract.actions && a in contract.actions);
    if (!when || !declared) {
      notes.push(`specialRule '${rule.name}' mentions rejection but is not mechanically templatable (whenState: '${rule.whenState}') — ask about it by hand`);
      continue;
    }
    candidates.push(candidate({
      id: `reject-in-state:${rule.name}`,
      target: 'transition',
      nf: { kind: 'reject-in-state', actions, key: when[1], value: when[2], stateKeys },
      question: `The contract's rule '${rule.name}' says ${actions.join('/')} arriving while ${when[1]} == '${when[2]}' is rejected. Must that rejection leave the state COMPLETELY unchanged — an observable no-op, never a partial mutation?`,
      evidence: { from: `contract.specialRules['${rule.name}']`, quote: rule.note },
    }));
  }

  // ── effect kinds: at-most-once emissions ─────────────────────────────────
  // Emission invariants live at the machine ∘ mapper composition layer
  // (polyrun check-effects); at M0 they cannot be pre-checked here, so the
  // candidate is carried as a question with an explicit NOT-RUN verdict —
  // asked, dispositioned, and reported, never silently dropped (M1 wires the
  // check-effects pre-check).
  for (const effect of Object.keys(manifest?.effects || {})) {
    candidates.push(candidate({
      id: `emission-at-most-once:${effect}`,
      target: 'emission',
      nf: { kind: 'emission-at-most-once', effect },
      question: `The manifest declares effect '${effect}'. Can it ever be emitted TWICE for one instance? (For a payment effect the domain answer is usually "never"; if at-most-once is intended, this becomes an emission invariant for polyrun check-effects.)`,
      evidence: { from: 'effects.manifest.json', quote: `effects.${effect}` },
    }));
  }

  return { candidates, notes };
}
