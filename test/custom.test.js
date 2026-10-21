// Your own commands and keys, and the command palette, end to end against the demo connections.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', ctrlP: '\x10', f5: '\x1b[15~' };

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-custom-'));
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

function start(extra = {}) {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null, ...extra };
  lastApp = render(React.createElement(App, { config, initialConnection: 'demo' }));
  return lastApp;
}

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const frame = () => lastApp.lastFrame();
const saved = () => JSON.parse(readFileSync(join(process.env.TRAWL_HOME, 'config.json'), 'utf8'));

test('your own commands: in the menu with their descriptions, $1 filled in, a list stops at the first that fails, a built-in name is left out', async () => {
  const app = start({
    commands: {
      players: { run: '!SELECT TOP (2) Name FROM dbo.Players', desc: 'Two of the players' },
      lim: '/limit $1',
      two: ['/limit 42', '/no-such-command', '/limit 77'],
      connect: '/quit',
    },
  });
  try {
    await until(() => frame().includes('Clubs'), 'the explorer');
    assert.match(frame(), /left out/);
    assert.match(frame(), /\/connect is built in/);
    app.stdin.write('/');
    await type(app.stdin, 'play');
    await until(() => /\/players\s+Two of the players/.test(frame()), 'the menu');
    app.stdin.write(KEYS.enter);
    await until(() => /2 rows/.test(frame()), 'the two players');
    app.stdin.write('/');
    await type(app.stdin, 'lim 33');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('stop at 33 rows'), '/lim 33');
    app.stdin.write('/');
    await type(app.stdin, 'two');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('/two stopped at /no-such-command'), 'the list stopping');
    assert.equal(saved().limit, 42);
    // The ? window lists them with the slash commands.
    app.stdin.write('?');
    await until(() => frame().includes('Keyboard shortcuts'), 'the help');
    app.stdin.write('/');
    await type(app.stdin, 'two of the');
    await until(() => /\/players\s+Two of the players/.test(frame()), 'in the help');
  } finally {
    app.unmount();
  }
});

test('your own keys: another key in a view, a command anywhere, never while typing, and mistakes said at start-up', async () => {
  const app = start({ keys: { global: { F5: '/limit 9' }, explorer: { x: 'd' }, nowhere: { a: 'b' }, results: { 'ctrl+shift+x': 'y' } } });
  try {
    await until(() => frame().includes('Clubs'), 'the explorer');
    assert.match(frame(), /"nowhere" isn't a view/);
    assert.match(frame(), /terminals don't send ctrl with shift/);
    // x does what d does in the Explorer: describe the table.
    app.stdin.write('x');
    await until(() => frame().includes('j/k scroll · space page · esc close'), 'the description');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('j/k scroll'), 'closed');
    app.stdin.write(KEYS.f5);
    await until(() => frame().includes('stop at 9 rows'), 'F5 running its command');
    // In the prompt x is just x.
    app.stdin.write('/');
    await type(app.stdin, 'x');
    await until(() => frame().includes('> /x'), 'x typed');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('enter run'), 'out of the prompt');
    // ? shows them.
    app.stdin.write('?');
    await until(() => frame().includes('Keyboard shortcuts'), 'the help');
    app.stdin.write('/');
    await type(app.stdin, 'does what d');
    await until(() => frame().includes('Your keys'), 'Your keys in the help');
  } finally {
    app.unmount();
  }
});

test('ctrl+p: the palette lists the view’s keys and the commands, filters as you type, and runs what’s picked', async () => {
  const app = start({ commands: { players: { run: '!SELECT TOP (3) Name FROM dbo.Players', desc: 'Three players' } } });
  try {
    await until(() => frame().includes('Clubs'), 'the explorer');
    app.stdin.write(KEYS.ctrlP);
    await until(() => frame().includes('Command palette'), 'the palette');
    // The Explorer's keys first, then commands; j and k are text here.
    assert.match(frame(), /Describe: columns, types, keys\s+Explorer/);
    await type(app.stdin, 'describe colum');
    await until(() => /❯ \/describe[\s\S]*\n.*\bd\s+Describe/.test(frame()), 'both found');
    app.stdin.write(KEYS.down);
    await until(() => /❯ d\s+Describe/.test(frame()), 'd picked');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('j/k scroll · space page · esc close') && !frame().includes('Command palette'), 'd run in the Explorer');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('j/k scroll'), 'closed');
    // Your command runs.
    app.stdin.write(KEYS.ctrlP);
    await until(() => frame().includes('Command palette'), 'the palette again');
    await type(app.stdin, 'three');
    await until(() => /❯ \/players/.test(frame()), 'yours picked');
    app.stdin.write(KEYS.enter);
    await until(() => /3 rows/.test(frame()), 'three players');
    // A command that takes more goes into the prompt, from what was typed there.
    app.stdin.write('/');
    await type(app.stdin, 'descr');
    app.stdin.write(KEYS.ctrlP);
    await until(() => frame().includes('Command palette') && /❯ \/describe/.test(frame()), 'the palette from the prompt');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('> /describe ') && !frame().includes('Command palette'), '/describe waiting in the prompt');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('enter run'), 'out of the prompt');
    // esc closes it, and nothing else happens.
    app.stdin.write(KEYS.ctrlP);
    await until(() => frame().includes('Command palette'), 'the palette once more');
    await type(app.stdin, 'q');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Command palette') && frame().includes('Rui Costa'), 'closed, still running');
  } finally {
    app.unmount();
  }
});

test("ctrl+p while typing in the console is the console's, not the palette's", async () => {
  const app = start();
  try {
    await until(() => frame().includes('Clubs'), 'the explorer');
    app.stdin.write('2');
    await until(() => frame().includes('An empty console'), 'the console');
    app.stdin.write('i');
    await until(() => frame().includes('typing SQL'), 'typing');
    app.stdin.write(KEYS.ctrlP);
    await new Promise((r) => setTimeout(r, 200));
    assert.doesNotMatch(frame(), /Command palette/);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('typing SQL'), 'not typing');
    app.stdin.write(KEYS.ctrlP);
    await until(() => frame().includes('Command palette') && frame().includes('Query, the console'), "the palette, with the console's keys");
  } finally {
    app.unmount();
  }
});
