#!/usr/bin/env node
// tla-check.mjs — run TLC on a transpiled .tla/.cfg pair and report JSON
// (Polygraph TLC escalation tier; pairs with scripts/to-tla.mjs).
//
// Toolchain discovery (nothing is vendored or hardcoded):
//   java:          env POLYGRAPH_JAVA (full path to a java executable), else
//                  `java` on PATH. Java 11+ is required by tla2tools.
//   tla2tools.jar: env POLYGRAPH_TLA_JAR (full path to the jar). There is no
//                  PATH fallback — TLC is an optional tier, so the jar must
//                  be pointed at explicitly. Download:
//                  https://github.com/tlaplus/tlaplus/releases (tla2tools.jar)
//
// TLC is run with -deadlock (deadlock checking DISABLED — a bounded SAM
// model with finite payload domains legitimately runs out of fresh states at
// the constraint boundary; TLC's deadlock notion is not a finding here).
//
// Module API (used by verify.mjs):
//   findJava()                 -> { path, source } | null
//   findTlaJar()               -> { path, source } | null
//   runTlc(tlaPath, opts?)     -> result object (see below); never throws on
//                                 TLC-level failures, only on setup errors
//                                 (TlcNotAvailableError when java/jar missing)
//
// Result object:
//   {
//     status: 'pass' | 'invariant-violation' | 'deadlock' | 'error' | 'timeout',
//     ok, statesGenerated, distinctStates, queueDepth,
//     violatedInvariants: [name...],
//     counterexample: [{ num, action, vars }] | null,
//     exitCode, durationMs, java, jar, output
//   }
//
// CLI:
//   node tla-check.mjs <Module.tla> [--cfg <Module.cfg>] [--workers N|auto]
//                      [--timeout <seconds>] [--java <path>] [--jar <path>]
// Prints the result object as JSON on stdout; exit code 0 on 'pass',
// 1 on any violation/error, 2 when the toolchain is unavailable.
'use strict';

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class TlcNotAvailableError extends Error {}

/**
 * Locate a java executable: POLYGRAPH_JAVA, then PATH.
 * @returns {{path: string, source: 'env'|'PATH'} | null}
 */
export function findJava() {
  const fromEnv = process.env.POLYGRAPH_JAVA;
  if (fromEnv) {
    if (probeJava(fromEnv)) return { path: fromEnv, source: 'env' };
    return null; // an explicit setting that does not work is an error, not a fallback
  }
  if (probeJava('java')) return { path: 'java', source: 'PATH' };
  return null;
}

function probeJava(cmd) {
  try {
    const r = spawnSync(cmd, ['-version'], { encoding: 'utf8', timeout: 30000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Locate tla2tools.jar: POLYGRAPH_TLA_JAR only (no fallback — TLC is an
 * explicit opt-in tier).
 * @returns {{path: string, source: 'env'} | null}
 */
export function findTlaJar() {
  const fromEnv = process.env.POLYGRAPH_TLA_JAR;
  if (fromEnv && existsSync(fromEnv)) return { path: fromEnv, source: 'env' };
  return null;
}

/**
 * Run TLC on a transpiled module.
 *
 * @param {string} tlaPath  path to the .tla file (its directory becomes cwd)
 * @param {object} [opts]
 * @param {string} [opts.cfgPath]    defaults to <Module>.cfg next to the .tla
 * @param {string} [opts.java]      java executable (overrides discovery)
 * @param {string} [opts.jar]       tla2tools.jar (overrides discovery)
 * @param {string|number} [opts.workers]   TLC -workers (default 'auto')
 * @param {number} [opts.timeoutMs] wall-clock limit (default 600000)
 * @throws {TlcNotAvailableError} when java or the jar cannot be located
 */
export function runTlc(tlaPath, opts = {}) {
  const tla = path.resolve(tlaPath);
  if (!existsSync(tla)) {
    throw new TlcNotAvailableError(`tla-check: no such file: ${tla}`);
  }
  const cfg = path.resolve(opts.cfgPath ?? tla.replace(/\.tla$/i, '.cfg'));
  if (!existsSync(cfg)) {
    throw new TlcNotAvailableError(`tla-check: no such config: ${cfg}`);
  }

  let java = opts.java;
  if (!java) {
    const found = findJava();
    if (!found) {
      throw new TlcNotAvailableError(
        'tla-check: no usable java found — set POLYGRAPH_JAVA to a java ' +
          'executable (Java 11+) or put java on PATH'
      );
    }
    java = found.path;
  }
  let jar = opts.jar;
  if (!jar) {
    const found = findTlaJar();
    if (!found) {
      throw new TlcNotAvailableError(
        'tla-check: tla2tools.jar not found — set POLYGRAPH_TLA_JAR to its ' +
          'path (download: https://github.com/tlaplus/tlaplus/releases)'
      );
    }
    jar = found.path;
  }

  const workers = String(opts.workers ?? 'auto');
  const timeoutMs = opts.timeoutMs ?? 600000;
  const args = [
    '-XX:+UseParallelGC',
    '-cp', jar,
    'tlc2.TLC',
    '-deadlock',
    '-workers', workers,
    '-config', cfg,
    tla,
  ];
  const started = Date.now();
  const r = spawnSync(java, args, {
    cwd: path.dirname(tla),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';

  const parsed = parseTlcOutput(output);
  const status = tlcStatus(parsed, timedOut, r.status);

  return {
    status,
    ok: status === 'pass',
    statesGenerated: parsed.statesGenerated,
    distinctStates: parsed.distinctStates,
    queueDepth: parsed.queueDepth,
    violatedInvariants: parsed.violatedInvariants,
    counterexample: parsed.counterexample,
    exitCode: r.status,
    durationMs,
    java,
    jar,
    output,
  };
}

/**
 * Status from a parsed TLC run. A violation already printed before a timeout
 * is a REAL finding — a 'timeout' status would bury it in the report, so the
 * violation wins. Exported for tests.
 */
export function tlcStatus(parsed, timedOut, exitCode) {
  if (parsed.violatedInvariants.length > 0) return 'invariant-violation';
  if (timedOut) return 'timeout';
  if (parsed.deadlock) return 'deadlock';
  if (parsed.completedClean && exitCode === 0) return 'pass';
  return 'error';
}

/**
 * Parse TLC's textual report: state counts, invariant violations, deadlock,
 * and the counterexample behavior trace ("State N: <Action ...>" blocks).
 * Exported for tests.
 */
export function parseTlcOutput(output) {
  const res = {
    statesGenerated: null,
    distinctStates: null,
    queueDepth: null,
    violatedInvariants: [],
    deadlock: false,
    completedClean: false,
    counterexample: null,
  };

  // TLC groups large counts with commas ("3,001,443 states generated") —
  // \d+ alone would match only the last group and understate by orders of
  // magnitude.
  const states = output.match(
    /([\d,]+) states generated.*?([\d,]+) distinct states found.*?([\d,]+) states left on queue/s
  );
  const num = (s) => Number(s.replaceAll(',', ''));
  if (states) {
    res.statesGenerated = num(states[1]);
    res.distinctStates = num(states[2]);
    res.queueDepth = num(states[3]);
  }

  for (const m of output.matchAll(/Error: Invariant (\S+) is violated/g)) {
    if (!res.violatedInvariants.includes(m[1])) res.violatedInvariants.push(m[1]);
  }
  if (/Error: Deadlock reached/.test(output)) res.deadlock = true;
  if (/Model checking completed\. No error has been found/.test(output)) {
    res.completedClean = true;
  }

  // Counterexample trace: blocks headed by "State N: <headline>" followed by
  // the state's variable assignments until a blank line.
  const lines = output.split(/\r?\n/);
  const trace = [];
  let cur = null;
  for (const line of lines) {
    const head = line.match(/^State (\d+): <?([^>]*)>?\s*$/);
    if (head) {
      if (cur) trace.push(cur);
      cur = { num: Number(head[1]), action: head[2].trim(), vars: '' };
      continue;
    }
    if (cur) {
      if (line.trim() === '') {
        trace.push(cur);
        cur = null;
      } else {
        cur.vars += (cur.vars ? '\n' : '') + line;
      }
    }
  }
  if (cur) trace.push(cur);
  if (trace.length > 0) res.counterexample = trace;
  return res;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cli() {
  const args = process.argv.slice(2);
  let tlaPath = null;
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cfg') opts.cfgPath = args[++i];
    else if (args[i] === '--workers') opts.workers = args[++i];
    else if (args[i] === '--timeout') opts.timeoutMs = Number(args[++i]) * 1000;
    else if (args[i] === '--java') opts.java = args[++i];
    else if (args[i] === '--jar') opts.jar = args[++i];
    else if (!tlaPath) tlaPath = args[i];
    else {
      console.error(`tla-check: unexpected argument '${args[i]}'`);
      process.exit(2);
    }
  }
  if (!tlaPath) {
    console.error(
      'usage: node tla-check.mjs <Module.tla> [--cfg <Module.cfg>] ' +
        '[--workers N|auto] [--timeout <seconds>] [--java <path>] [--jar <path>]'
    );
    process.exit(2);
  }
  let result;
  try {
    result = runTlc(tlaPath, opts);
  } catch (err) {
    if (err instanceof TlcNotAvailableError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  // keep the JSON manageable: full raw output only when something went wrong
  const { output, ...rest } = result;
  const emit = result.ok ? rest : { ...rest, output };
  console.log(JSON.stringify(emit, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) cli();
