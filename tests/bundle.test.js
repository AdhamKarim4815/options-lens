import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { buildBundle } from '../scripts/bundle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('src/app.classic.js is up to date (run: npm run bundle)', () => {
  assert.equal(readFileSync(join(root, 'src/app.classic.js'), 'utf8'), buildBundle(root));
});

test('the classic bundle is valid non-module JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(buildBundle(root)));
});

test('source files contain no em dashes or en dashes', () => {
  const dirs = ['.', 'src', 'tests', 'scripts', 'docs', '.github/workflows'];
  for (const d of dirs) {
    for (const f of readdirSync(join(root, d), { withFileTypes: true })) {
      if (!f.isFile() || /\.(png|jpg)$/.test(f.name)) continue;
      const text = readFileSync(join(root, d, f.name), 'utf8');
      assert.ok(!new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']').test(text), `dash character in ${d}/${f.name}`);
    }
  }
});
