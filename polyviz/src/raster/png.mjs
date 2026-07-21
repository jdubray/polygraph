// PNG export (spec §4.8): rasterize an SVG string with @resvg/resvg-js (no
// headless browser — browser screenshotting is banned as non-deterministic).
// Determinism is per-platform best-effort: resvg is deterministic given the
// same input and fonts, but text rendering depends on the available system
// fonts. Default scale 2×; background from the theme `bg`.

// @resvg/resvg-js is an OPTIONAL dependency (a native/WASM rasterizer), loaded
// only when PNG export is requested — so installing/using polyviz for SVG needs
// no native component.
let ResvgClass = null;
async function getResvg() {
  if (!ResvgClass) {
    try { ResvgClass = (await import('@resvg/resvg-js')).Resvg; }
    catch { throw new Error('PNG export needs the optional dependency @resvg/resvg-js — install it with:  npm i @resvg/resvg-js  (or export --format svg only)'); }
  }
  return ResvgClass;
}

/**
 * Rasterize `svg` to a PNG Buffer. opts: { scale=2, background }. Async.
 */
export async function renderPng(svg, { scale = 2, background } = {}) {
  const Resvg = await getResvg();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: scale },
    background,
    font: { loadSystemFonts: true }
  });
  return resvg.render().asPng();
}
