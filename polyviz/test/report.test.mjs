// Report integration: idempotent marker injection + manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectReport, buildManifest } from '../src/report.mjs';

const figures = [
  { id: 'model-card', ref: 'img/model-card.svg' },
  { id: 'counterexample', ref: 'img/counterexample.svg' }
];

test('injects image refs at markers and reports orphan markers', () => {
  const md = '# R\n<!-- polyviz:model-card -->\n<!-- polyviz:scorecard -->\n';
  const { markdown, injected, missing } = injectReport(md, figures);
  assert.deepEqual(injected, ['model-card']);
  assert.deepEqual(missing, ['scorecard']);
  assert.match(markdown, /!\[model-card\]\(img\/model-card\.svg\)/);
  assert.match(markdown, /<!-- \/polyviz:model-card -->/);
  assert.match(markdown, /<!-- polyviz:scorecard -->/); // orphan left untouched
});

test('injection is idempotent (re-run does not stack images)', () => {
  const md = '<!-- polyviz:counterexample -->\n';
  const once = injectReport(md, figures).markdown;
  const twice = injectReport(once, figures).markdown;
  assert.equal(once, twice);
  assert.equal((twice.match(/!\[counterexample\]/g) ?? []).length, 1);
});

test('re-injection updates the ref in place', () => {
  const md = '<!-- polyviz:model-card -->\n![model-card](old/path.svg)\n<!-- /polyviz:model-card -->\n';
  const { markdown } = injectReport(md, figures);
  assert.doesNotMatch(markdown, /old\/path\.svg/);
  assert.match(markdown, /img\/model-card\.svg/);
});

test('buildManifest lists figures with dimensions and hashes', () => {
  const m = buildManifest([{ id: 'x', width: 100, height: 50, sha256: 'abc' }], { svg: true, png: true });
  assert.equal(m.tool, 'polyviz');
  assert.deepEqual(m.figures[0], { id: 'x', width: 100, height: 50, sha256: 'abc', svg: 'x.svg', png: 'x.png' });
});
