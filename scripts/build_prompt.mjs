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

const HERE = dirname(fileURLToPath(import.meta.url));

const LANG_FENCE = { javascript: 'javascript', typescript: 'typescript', js: 'javascript', ts: 'typescript' };

/** Render the observable-state key list from the contract. */
function renderStateKeys(contract) {
  return contract.stateKeys
    .map((k) => {
      const name = typeof k === 'string' ? k : k.name;
      const type = typeof k === 'string' ? '' : (k.type ? ` — ${k.type}` : '');
      return `  - \`${name}\`${type}`;
    })
    .join('\n');
}

/** Render the initial-state object literal. */
function renderInitState(contract) {
  if (contract.initState) return JSON.stringify(contract.initState);
  // Fall back to a null-filled object over the declared keys.
  const obj = {};
  for (const k of contract.stateKeys) obj[typeof k === 'string' ? k : k.name] = null;
  return JSON.stringify(obj);
}

/** Render the action alphabet with data shapes. */
function renderActions(contract) {
  return Object.entries(contract.actions)
    .map(([name, spec]) => {
      const fields = spec && spec.dataFields ? spec.dataFields : (spec && spec.data) || {};
      const shape =
        fields && Object.keys(fields).length
          ? `{ ${Object.entries(fields).map(([f, t]) => `${f}: ${t}`).join(', ')} }`
          : '{ }';
      return `          '${name}'  data: ${shape}`;
    })
    .join('\n');
}

export function buildPrompt(contract, sourceCode, { filePath = 'source', lang = 'javascript' } = {}) {
  const tpl = readFileSync(join(HERE, 'prompt_template.txt'), 'utf-8');
  const fence = LANG_FENCE[lang] || 'javascript';
  return tpl
    .replaceAll('{lang}', lang)
    .replaceAll('{fence}', fence)
    .replaceAll('{file_path}', filePath)
    .replaceAll('{source_code}', sourceCode)
    .replaceAll('{state_keys}', renderStateKeys(contract))
    .replaceAll('{init_state}', renderInitState(contract))
    .replaceAll('{action_alphabet}', renderActions(contract));
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
