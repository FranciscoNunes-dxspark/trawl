// Checks the files Trawl shares with its sibling apps (Tiller, Splice) for drift: they were copied
// between the apps and should stay recognisably the same.
//   node scripts/shared-check.js ../splice           which shared files differ, and by how much
//   node scripts/shared-check.js ../splice --diff    and the lines that differ
// The apps' own names (Trawl, Splice, TRAWL_VERSION…) don't count as differences. Exits with 1 when
// a file differs, so it can run in CI; files only one app has are listed, not counted.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineDiff } from '../src/diff.js';

// The files copied between the apps (CLAUDE.md lists them), as paths from each checkout's root.
export const SHARED = ['src/text.js', 'src/ui/parts.jsx', 'src/ui/hooks.js', 'src/mouse.js', 'src/selection.js', 'src/clipboard.js', 'src/jsx-hooks.js', 'src/register.js', 'src/version.js', 'scripts/build.js'];

/** The app's name, from its package.json ("trawl"), or the folder's name. */
export function appName(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
  } catch {
    return resolve(dir).split(/[\\/]/).pop().toLowerCase();
  }
}

/** The text with each app's name, in any case (Trawl, trawl, TRAWL_VERSION), made the same, and line endings LF. */
export function normalise(text, names) {
  let out = String(text).replace(/\r\n?/g, '\n');
  for (const name of names) out = out.replace(new RegExp(`\\b${name}(?=\\b|_)`, 'gi'), (m) => (m === m.toUpperCase() ? 'APP' : m[0] === m[0].toUpperCase() ? 'App' : 'app'));
  return out;
}

/**
 * How each shared file compares between checkouts `here` and `there`: { file, status, changed, diff }
 * with status 'same', 'renamed' (the same apart from the apps' names), 'differs', or 'missing here' /
 * 'missing there'. `changed` counts the lines added or removed; `diff` is lineDiff's.
 */
export function compareCheckouts(here, there, files = SHARED) {
  const names = [...new Set([appName(here), appName(there)])].filter(Boolean);
  return files.map((file) => {
    const [a, b] = [join(here, file), join(there, file)];
    if (!existsSync(a) || !existsSync(b)) return { file, status: !existsSync(a) ? (existsSync(b) ? 'missing here' : 'in neither') : 'missing there', changed: 0 };
    const [x, y] = [readFileSync(a, 'utf8').replace(/\r\n?/g, '\n'), readFileSync(b, 'utf8').replace(/\r\n?/g, '\n')];
    if (x === y) return { file, status: 'same', changed: 0 };
    const diff = lineDiff(normalise(x, names), normalise(y, names));
    const changed = diff.filter(([m]) => m !== ' ').length;
    return { file, status: changed ? 'differs' : 'renamed', changed, diff };
  });
}

/** The differing lines with two of context around them, "-" for here and "+" for there. */
export function diffLines(diff, around = 2) {
  const keep = diff.map((_, i) => diff.slice(Math.max(0, i - around), i + around + 1).some(([m]) => m !== ' '));
  const out = [];
  diff.forEach(([mark, text], i) => {
    if (keep[i]) out.push(`${mark} ${text}`);
    else if (i === 0 || keep[i - 1]) out.push('  …');
  });
  return out;
}

function main(args) {
  const there = args.find((a) => !a.startsWith('--'));
  if (!there) {
    console.error('Usage: node scripts/shared-check.js <path to a sibling checkout, e.g. ../splice> [--diff]');
    process.exit(2);
  }
  if (!existsSync(there)) {
    console.error(`${there} doesn't exist.`);
    process.exit(2);
  }
  const here = fileURLToPath(new URL('..', import.meta.url));
  const [me, them] = [appName(here), appName(there)];
  const results = compareCheckouts(here, there);
  const width = Math.max(...results.map((r) => r.file.length));
  console.log(`${me} ←→ ${them} (${resolve(there)})`);
  for (const r of results) {
    const what = { same: 'the same', renamed: `the same apart from the names (${me}, ${them})`, differs: `${r.changed} line${r.changed === 1 ? '' : 's'} differ`, 'missing here': `only in ${them}`, 'missing there': `only in ${me}`, 'in neither': 'in neither' }[r.status];
    console.log(`  ${r.status === 'differs' ? '~' : r.status.startsWith('missing') ? '?' : '='} ${r.file.padEnd(width)}  ${what}`);
    if (args.includes('--diff') && r.status === 'differs') {
      console.log(`    --- ${me}/${r.file}\n    +++ ${them}/${r.file}`);
      for (const l of diffLines(r.diff)) console.log(`    ${l}`);
    }
  }
  const drifted = results.filter((r) => r.status === 'differs').length;
  console.log(drifted ? `${drifted} shared file${drifted === 1 ? ' has' : 's have'} drifted${args.includes('--diff') ? '' : ' (--diff shows how)'}.` : 'No drift.');
  process.exit(drifted ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
