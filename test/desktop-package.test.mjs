import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'desktop', 'package.json'), 'utf8'));
const build = readFileSync(join(root, 'desktop', 'build.mjs'), 'utf8');

// Apply the same string rewrites as desktop/build.mjs, then require every
// relative import to be on the electron-builder file list. 3.0.0 packed
// api.js and left model-route.mjs out, so the installed app could not start.
function desktopApiSource() {
  let src = readFileSync(join(root, 'functions', 'api', '[[path]].js'), 'utf8');
  for (const match of build.matchAll(/\.replaceAll\("((?:\\.|[^"\\])*)", "((?:\\.|[^"\\])*)"\)/g)) {
    src = src.replaceAll(JSON.parse(`"${match[1]}"`), JSON.parse(`"${match[2]}"`));
  }
  return src;
}

function packaged(rel) {
  return pkg.build.files.some(pattern => {
    if (pattern.endsWith('/**')) return rel === pattern.slice(0, -3) || rel.startsWith(pattern.slice(0, -3) + '/');
    return pattern === rel;
  });
}

test('the desktop installer packs every file the rewritten API imports', () => {
  const src = desktopApiSource();
  const specs = [...src.matchAll(/from '(\.[^']+)'/g)].map(m => m[1]);
  assert.deepEqual(specs, ['./model-route.mjs']);
  for (const spec of specs) {
    const rel = spec.slice(2);
    assert.equal(packaged(rel), true, `${rel} is imported by desktop api.js but missing from electron-builder files`);
    readFileSync(join(root, 'public', rel));
  }
});
