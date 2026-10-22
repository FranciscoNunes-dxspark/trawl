// The shared Claude Code runner (claude-cli.js), with a stand-in for the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { NOT_INSTALLED, ask, clip, runClaude } from '../src/claude-cli.js';

// Runs Node with `script` in claude's place, so the real process plumbing (stdin, exit codes) is used.
const as = (script) => (_file, _args, opts, done) => execFile(process.execPath, ['-e', script], opts, done);

test('the answer, the input on stdin, the flags; a failure in its own words', async () => {
  let seen;
  const echo = (file, args, opts, done) => ((seen = { file, args }), as('let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("got "+s.length))')(file, args, opts, done));
  assert.equal(await ask('Say hi', { input: 'abc', execImpl: echo }), 'got 3');
  assert.equal(seen.file, 'claude');
  assert.deepEqual(seen.args.slice(0, 4), ['-p', 'Say hi', '--tools', '']);
  assert.ok(seen.args.includes('--strict-mcp-config'));
  await assert.rejects(ask('x', { execImpl: as('console.error("Invalid API key · Please run /login"); process.exit(1)') }), /Invalid API key/);
  const r = await runClaude(['-p'], { execImpl: as('console.log("{}"); process.exit(1)') });
  assert.equal(r.failed, true);
  assert.equal(r.stdout.trim(), '{}');
});

test("not installed, cancelled, and a claude that exits before reading its input isn't a crash", async () => {
  await assert.rejects(ask('x', { execImpl: (f, a, o, done) => execFile('no-such-claude-here', a, o, done) }), (e) => e.message === NOT_INSTALLED);
  const controller = new AbortController();
  const slow = ask('x', { signal: controller.signal, execImpl: as('setTimeout(() => {}, 20000)') });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(slow, (e) => e.cancelled);
  // Bigger than a pipe holds, so the write is still going when it has gone.
  for (let i = 0; i < 3; i++) await assert.rejects(ask('x', { input: 'x'.repeat(2_000_000), execImpl: as('console.error("not signed in"); process.exit(1)') }), /not signed in/);
  assert.equal(clip('abc', 10), 'abc');
  assert.match(clip('x'.repeat(20), 10), /^x{10}\n\n\[Cut here: the rest \(10 more characters\) was left out\.\]$/);
});
