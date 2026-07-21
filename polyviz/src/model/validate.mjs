// Fail-loud viz-model validation (spec §2 #6, §4.1 stage 2). A small recursive
// checker over the schema subset we use (type/enum/required/properties/
// additionalProperties/items/$ref/$defs). No dependency — the schema is closed.

import { SCHEMA } from './schema.mjs';

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v; // object | string | number | boolean
}

function resolveRef(ref, root) {
  // supports "#/$defs/name"
  const parts = ref.replace(/^#\//, '').split('/');
  let node = root;
  for (const p of parts) node = node?.[p];
  if (!node) throw new Error(`unresolved $ref: ${ref}`);
  return node;
}

function walk(value, schema, path, root, errors) {
  if (schema.$ref) schema = resolveRef(schema.$ref, root);

  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} not in {${schema.enum.join(', ')}}`);
    }
    return;
  }

  const t = typeOf(value);
  if (schema.type && schema.type !== t) {
    errors.push(`${path}: expected ${schema.type}, got ${t}`);
    return;
  }

  if (t === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}: missing required "${req}"`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        walk(v, props[k], `${path}.${k}`, root, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${k}"`);
      }
    }
  } else if (t === 'array' && schema.items) {
    value.forEach((item, i) => walk(item, schema.items, `${path}[${i}]`, root, errors));
  }
}

/**
 * Validate a viz-model. Returns the model on success; throws with all errors
 * joined on failure.
 */
export function validate(model) {
  const errors = [];
  walk(model, SCHEMA, 'viz-model', SCHEMA, errors);
  if (errors.length) {
    throw new Error(`invalid viz-model (${errors.length}):\n  - ${errors.join('\n  - ')}`);
  }
  return model;
}
