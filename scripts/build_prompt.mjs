// Build a derivation-mode prompt from a contract + source file.
//
// The prompt asks an LLM to derive an executable spec from the source ALONE —
// it deliberately never describes per-state semantics, so the spec is derived,
// not transcribed from a description that might share the code's bugs.
//
// Two artifact modes (the P3 prompt-selection seam):
//   'sam'    (default) — prompt_template_v2.txt: a SAM v2 strict-profile module
//            ({ instance, init, actions, getState, setState }) with declared
//            modelShape / intent schemas / intent domains and reject(reason)
//            for everything the implementation ignores.
//   'legacy' — prompt_template.txt: the bare next(state, action, data) module.
//
// Usage (module): buildPrompt(contract, sourceCode, { filePath, lang, mode })
// Usage (CLI):    node build_prompt.mjs <contract.json> <source-file> [--legacy-bare-next]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderStateKeys, renderInitState, renderActions,
  renderModelShape, renderIntentSchemas, renderIntentDomains, renderSpecialRulesAsRejections,
} from './contract_render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const LANG_FENCE = { javascript: 'javascript', typescript: 'typescript', js: 'javascript', ts: 'typescript' };

/** Indent a multi-line renderer snippet so it sits inside the template's code block. */
const indent = (snippet, pad = '    ') => snippet.split('\n').map((l) => pad + l).join('\n');

export function buildPrompt(contract, sourceCode, { filePath = 'source', lang = 'javascript', mode = 'sam' } = {}) {
  const tplName = mode === 'legacy' ? 'prompt_template.txt' : 'prompt_template_v2.txt';
  const tpl = readFileSync(join(HERE, tplName), 'utf-8');
  const fence = LANG_FENCE[lang] || 'javascript';
  // Function replacements throughout: string-form replaceAll interprets
  // $-patterns ($&, $$, $', $`) in the replacement, which would mangle user
  // source containing them (e.g. `s.replace(/x/, '$&!')`). And {source_code}
  // is substituted LAST so no later placeholder pass can rewrite text inside
  // the embedded source (source legitimately containing the literal string
  // '{state_keys}' or '{model_shape}' must survive byte-identical).
  let out = tpl
    .replaceAll('{lang}', () => lang)
    .replaceAll('{fence}', () => fence)
    .replaceAll('{file_path}', () => filePath)
    .replaceAll('{state_keys}', () => renderStateKeys(contract))
    .replaceAll('{init_state}', () => renderInitState(contract))
    .replaceAll('{action_alphabet}', () => renderActions(contract));
  if (mode !== 'legacy') {
    // v2 renderers. renderIntentDomains throws LOUDLY when an action declares
    // data fields without a dataDomain — in the v2 pipeline the domain is also
    // the exploration and transpilation domain, so a missing one must block
    // generation rather than silently exclude the action.
    out = out
      .replaceAll('{model_shape}', () => indent(renderModelShape(contract)))
      .replaceAll('{intent_schemas}', () => indent(renderIntentSchemas(contract)))
      .replaceAll('{intent_domains}', () => indent(renderIntentDomains(contract)))
      .replaceAll('{special_rules_rejections}', () => renderSpecialRulesAsRejections(contract));
  }
  return out.replaceAll('{source_code}', () => sourceCode);
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const legacy = args.includes('--legacy-bare-next');
  const positional = args.filter((a) => !a.startsWith('--'));
  const [contractPath, sourcePath] = positional;
  if (!contractPath || !sourcePath) {
    console.error('usage: node build_prompt.mjs <contract.json> <source-file> [--legacy-bare-next]');
    process.exit(2);
  }
  const contract = JSON.parse(readFileSync(contractPath, 'utf-8'));
  const source = readFileSync(sourcePath, 'utf-8');
  const lang = contract.lang || (sourcePath.endsWith('.ts') ? 'typescript' : 'javascript');
  process.stdout.write(buildPrompt(contract, source, { filePath: sourcePath, lang, mode: legacy ? 'legacy' : 'sam' }));
}
