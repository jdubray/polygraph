// Model-id resolution.
//
// The plugin has NO default model — callers must pass --model. These aliases
// are conveniences that map friendly names to Anthropic API model ids. Any
// value NOT in this table is passed through VERBATIM, so you can always supply
// the exact API id yourself.
//
// NOTE: verify each id against the current Anthropic model list before relying
// on it (https://platform.claude.com/docs/en/about-claude/models). Ids change;
// this table reflects the published list as of 2026-07-08 (all four verified
// current on that date; there is no "sonnet-4.8" — the current Sonnet is
// claude-sonnet-5) and is intentionally small.
export const MODEL_ALIASES = {
  'fable-5': 'claude-fable-5',
  'opus-4.8': 'claude-opus-4-8',
  'sonnet-5': 'claude-sonnet-5',
  'haiku-4.5': 'claude-haiku-4-5-20251001',
};

/**
 * Resolve a friendly alias to an API id, or pass the value through unchanged.
 * Returns { id, resolved } where resolved=true if an alias matched.
 */
export function resolveModel(name) {
  if (!name) return { id: name, resolved: false };
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, name)) {
    return { id: MODEL_ALIASES[name], resolved: true };
  }
  return { id: name, resolved: false };
}
