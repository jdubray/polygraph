// Report integration (spec §3.4 / §4.10). Renders figures into an image dir,
// emits a manifest the report step can consume (looser coupling), and — when a
// report file is given — injects image references at `<!-- polyviz:<id> -->`
// markers. Injection is idempotent: a marker is wrapped in an open/close pair so
// re-running replaces the previous image instead of stacking copies.

// Escape a diagram id for use inside a RegExp.
function esc(id) {
  return id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inject figure references into markdown at `<!-- polyviz:<id> -->` markers.
 * `figures` is [{ id, ref }] where ref is the image path to embed. Returns
 * { markdown, injected: [ids], missing: [ids referenced by a marker but not
 * provided] }.
 */
export function injectReport(markdown, figures) {
  const byId = new Map(figures.map((f) => [f.id, f]));
  const injected = [];
  let out = markdown;

  for (const [id, f] of byId) {
    const e = esc(id);
    // Match the open marker, and — only if it's an already-injected block — the
    // single image + close that follow. The optional group matches the exact
    // injected shape (not arbitrary `[\s\S]*?`), so it can never swallow a
    // neighbouring or nested polyviz block.
    const block = new RegExp(`<!-- polyviz:${e} -->(?:\\s*!\\[[^\\]]*\\]\\([^)]*\\)\\s*<!-- /polyviz:${e} -->)?`, 'g');
    if (block.test(out)) {
      out = out.replace(block, `<!-- polyviz:${id} -->\n![${id}](${f.ref})\n<!-- /polyviz:${id} -->`);
      injected.push(id);
    }
  }

  // Markers present in the doc with no matching figure.
  const referenced = [...markdown.matchAll(/<!-- polyviz:([a-z0-9-]+) -->/g)].map((m) => m[1]);
  const missing = [...new Set(referenced)].filter((id) => !byId.has(id));

  return { markdown: out, injected, missing };
}

/**
 * A manifest describing the rendered figures, for a report step that prefers to
 * consume files rather than have markdown rewritten.
 */
export function buildManifest(results, { svg = true, png = false } = {}) {
  return {
    tool: 'polyviz',
    figures: results.map((r) => ({
      id: r.id,
      width: r.width,
      height: r.height,
      sha256: r.sha256,
      ...(svg ? { svg: `${r.id}.svg` } : {}),
      ...(png ? { png: `${r.id}.png` } : {})
    }))
  };
}
