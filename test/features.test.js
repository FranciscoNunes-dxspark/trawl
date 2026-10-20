// End-to-end tests of the features added after the first app.test.js ones, in its style: the real
// UI against the demo connections, keys in, frames out. The helpers are copied from app.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b' };

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-'));
  process.env.TRAWL_HOME = join(base, 'home');
});
after(() => rmSync(base, { recursive: true, force: true }));

let lastApp = null;
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

function start(connection = 'demo', props = {}, { connections = [...DEMO_CONNECTIONS], ...config } = {}) {
  const full = { connections, history: [], ran: [], limit: 500, last: null, ...config };
  lastApp = render(React.createElement(App, { config: full, initialConnection: connection, ...props }));
  return lastApp;
}

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const frame = () => lastApp.lastFrame();
const command = async (app, text) => {
  await type(app.stdin, text);
  app.stdin.write(KEYS.enter);
};

test('Activity lists the blocking chain as a tree, and x kills the session at its head after asking', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write('6');
  await until(() => frame().includes('blocked by 53') && frame().includes('blocked by 61'), 'the blocking chain');
  assert.match(frame(), /❯\s+53 sleeping\s+▲2/);
  assert.match(frame(), /└\s+61 blocked by 53/);
  assert.match(frame(), /─ Session 53 ─/);
  assert.doesNotMatch(frame(), /\b72 sleeping/, 'idle sessions only with a');
  app.stdin.write('a');
  await until(() => /\b72 sleeping/.test(frame()), 'the idle sessions too');
  app.stdin.write('a');
  await until(() => !/\b72 sleeping/.test(frame()), 'only the busy ones again');
  app.stdin.write('x');
  await until(() => frame().includes('Kill session 53 (app_user · WEB01 · Club website)?'), 'the question');
  app.stdin.write('1');
  await until(() => frame().includes('KILL 53') && !frame().includes('blocked by 53'), 'the session gone');
  assert.match(frame(), /61 running/);
  app.unmount();
});

test('/kill is refused on a read-only connection', async () => {
  const app = start('demo-prod');
  await until(() => frame().includes('PROD') && frame().includes('Clubs'), 'the production connection');
  await command(app, '/activity');
  await until(() => frame().includes('blocked by 53'), 'the activity');
  app.stdin.write('x');
  await until(() => frame().includes("demo-prod is read-only (production), and KILL ends someone's session"), 'the refusal');
  assert.match(frame(), /blocked by 53/);
  app.unmount();
});
