// Minimal, deterministic SVG string builder (spec §4.5). No dependencies.
// Attribute order is insertion order → stable output. Numbers are formatted
// with a fixed rule so the same geometry always serializes identically.

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => XML_ESC[c]);
}

// Canonical number formatting: integers stay integers; others fixed to 2dp with
// trailing zeros/decimal stripped. Avoids "-0" and locale/float drift.
export function num(n) {
  if (!Number.isFinite(n)) throw new Error(`non-finite coordinate: ${n}`);
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(2).replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s;
}

function attrs(obj) {
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === false) continue;
    const val = typeof v === 'number' ? num(v) : String(v);
    out += ` ${k}="${esc(val)}"`;
  }
  return out;
}

/** Self-closing element: el('rect', {x,y,...}) */
export function el(tag, a = {}) {
  return `<${tag}${attrs(a)}/>`;
}

/** Container element with raw inner SVG: node('g', {..}, children) */
export function node(tag, a = {}, inner = '') {
  return `<${tag}${attrs(a)}>${inner}</${tag}>`;
}

/** <text> — `content` is escaped; pass attrs like font-family, fill, etc. */
export function text(content, a = {}) {
  return `<text${attrs(a)}>${esc(content)}</text>`;
}

/** Wrap a body string in the root <svg>. */
export function svg({ width, height }, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" ` +
    `viewBox="0 0 ${num(width)} ${num(height)}">${body}</svg>`
  );
}
