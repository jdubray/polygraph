// Build a derivation-mode prompt from a contract + source file.
//
// The prompt asks an LLM to derive next(state, action, data) from the source
// ALONE — it deliberately never describes per-state semantics, so the spec is
// derived, not transcribed from a description that might share the code's bugs.
//
// Usage (module): buildPrompt(contract, sourceCode, { filePath, lang })
// Usage (CLI):    node build_prompt.mjs <contract.json> <source-file>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderStateKeys, renderInitState, renderActions } from './contract_render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const LANG_FENCE = { javascript: 'javascript', typescript: 'typescript', js: 'javascript', ts: 'typescript' };

export function buildPrompt(contract, sourceCode, { filePath = 'source', lang = 'javascript' } = {}) {
  const tpl = readFileSync(join(HERE, 'prompt_template.txt'), 'utf-8');
  const fence = LANG_FENCE[lang] || 'javascript';
  // Function replacements throughout: string-form replaceAll interprets
  // $-patterns ($&, $$, $', $`) in the replacement, which would mangle user
  // source containing them (e.g. `s.replace(/x/, '$&!')`). And {source_code}
  // is substituted LAST so no later placeholder pass can rewrite text inside
  // the embedded source (source legitimately containing the literal string
  // '{state_keys}' must survive byte-identical).
  return tpl
    .replaceAll('{lang}', () => lang)
    .replaceAll('{fence}', () => fence)
    .replaceAll('{file_path}', () => filePath)
    .replaceAll('{state_keys}', () => renderStateKeys(contract))
    .replaceAll('{init_state}', () => renderInitState(contract))
    .replaceAll('{action_alphabet}', () => renderActions(contract))
    .replaceAll('{source_code}', () => sourceCode);
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , contractPath, sourcePath] = process.argv;
  if (!contractPath || !sourcePath) {
    console.error('usage: node build_prompt.mjs <contract.json> <source-file>');
    process.exit(2);
  }
  const contract = JSON.parse(readFileSync(contractPath, 'utf-8'));
  const source = readFileSync(sourcePath, 'utf-8');
  const lang = contract.lang || (sourcePath.endsWith('.ts') ? 'typescript' : 'javascript');
  process.stdout.write(buildPrompt(contract, source, { filePath: sourcePath, lang }));
}
