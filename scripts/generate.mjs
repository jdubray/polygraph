// Generate N independent bare-next() specs from a prompt via the Anthropic API.
//
// Each generation is a fresh, independent call with the SAME prompt (samples
// must be independent — a single generation may omit a rule). The source-bearing
// user turn is marked for prompt caching so the N calls after the first read the
// source from cache instead of re-billing it.
//
// Env:  ANTHROPIC_API_KEY (required to actually call the API)
// Usage (module): generateSpecs({ prompt, model, n, apiKey, fetchImpl })
// Usage (CLI):    node generate.mjs --prompt <file> --model <id> --n 5 --out <dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModel } from './models.mjs';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Default output budget. Kept generous because reasoning models (e.g.
// claude-sonnet-5) emit a thinking block that draws from max_tokens BEFORE the
// answer — a low ceiling gets spent entirely on thinking, returning zero answer
// tokens (stop_reason: "max_tokens") and an empty spec. Output is billed only
// for tokens actually produced, so a high ceiling costs nothing extra on
// non-reasoning models. Override with --max-tokens.
export const DEFAULT_MAX_TOKENS = 32000;

/** Build the request body for one generation. Exposed for testing. */
export function buildRequest({ prompt, model, maxTokens = DEFAULT_MAX_TOKENS }) {
  const { id } = resolveModel(model);
  return {
    model: id,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  };
}

/** Extract the first fenced code block (js/ts/any) from a model response. */
export function extractSpec(text) {
  const m = text.match(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)\n```/);
  return m ? m[1] : text;
}

/**
 * ONE guarded low-level Messages call for every consumer (spec generation and
 * the eval's baseline arm alike). Returns { ok:true, text, usage } or
 * { ok:false, error }. The guards are the point: an HTTP error or an
 * empty/all-thinking response must surface as a FAILURE, never as parseable
 * empty text that downstream code scores as a substantive verdict.
 */
export async function callMessages({ prompt, model, maxTokens, apiKey, fetchImpl = fetch }) {
  const body = buildRequest({ prompt, model, maxTokens });
  try {
    const resp = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return { ok: false, error: `HTTP ${resp.status}: ${errText.slice(0, 300)}` };
    }
    const data = await resp.json();
    // Only text blocks carry the answer; thinking blocks (reasoning models)
    // have no .text — if the budget was spent on thinking there is no text at
    // all. Fail loudly rather than returning empty text.
    const text = (data.content || []).map((b) => b.text || '').join('');
    if (!text.trim()) {
      const hint = data.stop_reason === 'max_tokens'
        ? ` (stop_reason=max_tokens with no answer text — a reasoning model likely spent the whole budget on thinking; raise --max-tokens, e.g. 32000)`
        : ` (stop_reason=${data.stop_reason})`;
      return { ok: false, error: `empty response${hint}` };
    }
    // A max_tokens stop with PARTIAL text is a truncated answer: the tail of
    // the spec is missing, but what remains can still be a loadable module
    // that silently lacks its last rules. Scoring it as a normal generation
    // mis-attributes those missing rules downstream — fail it here.
    if (data.stop_reason === 'max_tokens') {
      return { ok: false, error: `response truncated (stop_reason=max_tokens after ${text.length} chars) — the answer was cut off mid-spec; raise --max-tokens` };
    }
    return { ok: true, text, usage: data.usage };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * Generate N specs. Returns array of { index, ok, spec?, error?, usage? }.
 * fetchImpl is injectable for testing (defaults to global fetch).
 */
export async function generateSpecs({ prompt, model, n = 5, apiKey, fetchImpl = fetch, maxTokens }) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const r = await callMessages({ prompt, model, maxTokens, apiKey, fetchImpl });
    results.push(r.ok
      ? { index: i, ok: true, spec: extractSpec(r.text), usage: r.usage }
      : { index: i, ok: false, error: r.error });
  }
  return results;
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const usage = () => {
    console.error('usage: node generate.mjs --prompt <file> --model <id> [--n 5] [--max-tokens 32000] [--out <dir>]');
    process.exit(2);
  };
  // Every generate flag takes a value; a flag-shaped "value" means the real
  // value was forgotten — reject it instead of consuming the next flag.
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { console.error(`unexpected argument '${a}'`); usage(); }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { console.error(`missing value for ${a}`); usage(); }
    args[a.slice(2)] = v;
    i++;
  }
  if (!args.prompt || !args.model) usage();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exit(2);
  }
  const prompt = readFileSync(args.prompt, 'utf-8');
  const n = Number(args.n || 5);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--n must be a positive integer (got '${args.n}')`);
    process.exit(2);
  }
  const { id, resolved } = resolveModel(args.model);
  console.error(`[generate] model=${args.model}${resolved ? ` -> ${id}` : ' (verbatim)'} n=${n}`);
  const out = args.out || 'specs';
  mkdirSync(out, { recursive: true });
  const maxTokens = args['max-tokens'] ? Number(args['max-tokens']) : undefined;
  const results = await generateSpecs({ prompt, model: args.model, n, apiKey, maxTokens });
  let ok = 0;
  for (const r of results) {
    if (r.ok) {
      writeFileSync(join(out, `spec_${r.index}.js`), r.spec, 'utf-8');
      ok++;
    } else {
      console.error(`[generate] gen ${r.index} failed: ${r.error}`);
    }
  }
  console.error(`[generate] wrote ${ok}/${n} specs to ${out}/`);
  // Exit codes are the machine-readable outcome: writing nothing is a
  // failure, and a partial batch degrades the N-way vote — say so.
  if (ok === 0) {
    console.error('[generate] FAILED: no specs were written');
    // exitCode (not exit()): a hard exit while fetch's keep-alive sockets are
    // closing trips a libuv assertion on Windows; letting the loop drain sets
    // the same failure code without the crash.
    process.exitCode = 1;
  }
  if (ok < n) console.error(`[generate] WARNING: only ${ok}/${n} generations succeeded — the N-way vote is weaker than requested`);
}
