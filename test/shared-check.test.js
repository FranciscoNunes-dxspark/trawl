import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareCheckouts, diffLines, normalise } from '../scripts/shared-check.js';

test("the apps' own names don't count as drift; other changes and missing files do", () => {
  const root = mkdtempSync(join(tmpdir(), 'trawl-shared-'));
  try {
    const app = (name, files) => {
      const dir = join(root, name);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
      for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
      return dir;
    };
    const a = app('trawl', { 'src/a.js': '// Trawl draws it\nconst v = process.env.TRAWL_VERSION;\n', 'src/b.js': 'x\ny\nz\n', 'src/c.js': '1\n', 'src/d.js': 'same\r\n' });
    const b = app('splice', { 'src/a.js': '// Splice draws it\nconst v = process.env.SPLICE_VERSION;\n', 'src/b.js': 'x\nY\nz\n', 'src/d.js': 'same\n' });
    const r = Object.fromEntries(compareCheckouts(a, b, ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']).map((x) => [x.file, x]));
    assert.equal(r['src/a.js'].status, 'renamed');
    assert.equal(r['src/b.js'].status, 'differs');
    assert.equal(r['src/b.js'].changed, 2);
    assert.deepEqual(diffLines(r['src/b.js'].diff), ['  x', '- y', '+ Y', '  z', '  ']);
    assert.equal(r['src/c.js'].status, 'missing there');
    assert.equal(r['src/d.js'].status, 'same', 'line endings never count');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('names are made the same in any case, but not inside other words', () => {
  assert.equal(normalise('Trawl trawl TRAWL_HOME trawler', ['trawl']), 'App app APP_HOME trawler');
});
