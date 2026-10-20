// Clicks and the wheel, driven through the real UI with a stand-in for the terminal's mouse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { esc: '\x1b' };

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-clicks-'));
  process.env.TRAWL_HOME = join(base, 'home');
});
after(() => rmSync(base, { recursive: true, force: true }));

let lastApp = null;
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new view's handlers a moment to subscribe, as a person would.
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}
const frame = () => lastApp.lastFrame() ?? '';

/** mouse.js's terminalMouse() without a terminal: records `enable` and sends made-up events. */
function fakeMouse() {
  const listeners = new Set();
  const send = (e) => listeners.forEach((fn) => fn({ button: 'left', release: false, drag: false, shift: false, ...e }));
  return {
    enabled: [],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    enable(on) {
      this.enabled.push(on);
    },
    claimDrags(fn) {
      this.claims = fn;
    },
    click: (x, y) => send({ x, y }),
    wheel: (x, y, wheel, { shift = false } = {}) => send({ x, y, button: 'wheel', wheel, shift }),
    copy: (text) => listeners.forEach((fn) => fn({ type: 'copy', text })),
    /** A drag from `a` to `b`, which App must have claimed (only the console does); mouse.js then sends this. */
    drag(a, b) {
      assert.ok(this.claims?.({ button: 'left', ...a }), `a drag from ${JSON.stringify(a)} isn't the app's`);
      send({ ...b, drag: true, from: a });
      send({ ...b, drag: true, release: true, from: a });
    },
  };
}

// Where the frame shows `text`: { x, y } of its first character, so clicks land where things were drawn.
// What's drawn before these labels is one column a character, so a string index is a column.
const at = (text) => {
  const lines = frame().split('\n');
  const y = lines.findIndex((l) => l.includes(text));
  assert.ok(y >= 0, `"${text}" isn't on screen:\n${frame()}`);
  return { x: lines[y].indexOf(text), y };
};
const lineOf = (text) => frame().split('\n').find((l) => l.includes(text)) ?? '';

function start(props = {}, extra = {}) {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null, ...extra };
  lastApp = render(React.createElement(App, { config, initialConnection: 'demo', ...props }));
  return lastApp;
}

/** A smaller terminal than the test one, so lists and grids have more rows (or columns) than fit. */
function resize(app, columns, rows) {
  Object.defineProperty(app.stdout, 'columns', { value: columns, configurable: true });
  app.stdout.rows = rows;
  app.stdout.emit('resize');
}

test('clicks pick rows, cells and tabs, double-clicks do what ↵ does (but never run a query again), and the prompt takes the focus', async () => {
  const mouse = fakeMouse();
  const copied = [];
  const app = start({ mouse, clipboard: async (text) => (copied.push(text), 'system') });
  try {
    await until(() => frame().includes('Translations'), 'the explorer');
    assert.deepEqual(mouse.enabled, [true]);

    // A click puts the cursor on the row and only moves it; a schema's heading takes no cursor.
    let p = at('T Players');
    mouse.click(p.x, p.y);
    await until(() => /❯ T Players/.test(frame()), 'the cursor on Players');
    assert.doesNotMatch(frame(), /Rui Costa/);
    p = at('i18n');
    mouse.click(p.x, p.y);
    p = at('▾ ClubA');
    mouse.click(p.x, p.y);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(frame(), /❯ T Players/);

    // Clicking it again quickly is a double-click: its first rows, as ↵ shows them.
    p = at('T Players');
    mouse.click(p.x, p.y);
    mouse.click(p.x, p.y);
    await until(() => frame().includes('─ SELECT TOP (500) * FROM [dbo].[Players]; ─') && frame().includes('Rui Costa'), 'the rows of Players');

    // In the grid a click picks the row and, the rows being one table's, the cell: y copies it.
    p = at('Marta Reis');
    mouse.click(p.x + 2, p.y);
    await until(() => /❯.*Marta Reis/.test(frame()), 'the cursor on Marta Reis');
    app.stdin.write('y');
    await until(() => copied.length === 1, 'the copy');
    assert.deepEqual(copied, ['Marta Reis']);
    // A double-click on a row shows its record, as ↵ does; a tab closes it and switches.
    p = at('Iker Sanz');
    mouse.click(p.x, p.y);
    mouse.click(p.x, p.y);
    await until(() => frame().includes('Row 5 of 12') && frame().includes('esc close'), 'the record');
    p = at('4 History');
    mouse.click(p.x + 2, p.y);
    await until(() => frame().includes('─ History ') && !frame().includes('Row 5 of 12'), 'History');

    // History: a double-click picks the statement and doesn't run it again (↵ would).
    p = at('SELECT TOP (500) * FROM [dbo].[Players]');
    mouse.click(p.x, p.y);
    mouse.click(p.x, p.y);
    await until(() => /❯.*SELECT TOP \(500\)/.test(frame()), 'the cursor on the statement');
    await new Promise((r) => setTimeout(r, 200));
    assert.match(frame(), /─ History /);
    assert.equal(frame().split('● SELECT TOP (500)').length, 2, 'it ran once, from the Explorer');

    // The prompt: a click focuses it, and a click on the view gives the keys back, keeping the text.
    p = at('Press / for commands');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('enter run · tab complete'), 'the prompt focused');
    app.stdin.write('x');
    await until(() => frame().includes('> x'), 'typed into the prompt');
    p = at('─ History ');
    mouse.click(p.x, p.y + 1);
    await until(() => !frame().includes('enter run · tab complete'), 'the view focused again');
    assert.match(frame(), /> x/);

    // Text selected and copied (mouse.js does that): said for a moment in the bottom line.
    mouse.copy('one\ntwo');
    await until(() => frame().includes('Copied 2 lines'), 'the copy noted');

    // In the Explorer, a click on another database picks it and a double-click switches to it.
    p = at('1 Explorer');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('▸ ClubB'), 'the explorer');
    p = at('▸ ClubB');
    mouse.click(p.x, p.y);
    await until(() => /❯ ClubB/.test(frame()), 'the cursor on ClubB');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('demo/ClubB') && /▾ ClubB +current/.test(frame()), 'ClubB');
  } finally {
    app.unmount();
  }
});

test('the wheel scrolls a list or the grid and leaves the cursor where it was; shift+wheel scrolls the columns', async () => {
  const mouse = fakeMouse();
  const ran = Array.from({ length: 40 }, (_, i) => ({ sql: `SELECT ${i + 1} AS n`, conn: 'demo', database: 'ClubA', at: Date.now() - i * 60_000, ok: true, summary: '1 row' }));
  const app = start({ mouse }, { ran });
  try {
    await until(() => frame().includes('Translations'), 'the explorer');
    let p = at('4 History');
    mouse.click(p.x, p.y);
    await until(() => /❯.*SELECT 1 AS n/.test(frame()), 'History, the cursor on top');
    const firstRow = () => frame().split('\n')[3];
    mouse.wheel(p.x, 10, 1);
    mouse.wheel(p.x, 10, 1);
    await until(() => firstRow().includes('SELECT 7 AS n'), 'six rows scrolled');
    assert.doesNotMatch(frame(), /❯/, 'the cursor stays on the statement scrolled out of sight');
    mouse.wheel(p.x, 10, -1);
    await until(() => firstRow().includes('SELECT 4 AS n'), 'back up a notch');
    // A key moves the cursor from where it was, and the view goes back to it.
    app.stdin.write('j');
    await until(() => /❯.*SELECT 2 AS n/.test(firstRow()), 'the cursor one down from where it was, in view');

    // The grid, in a terminal too small for all of Players' rows and columns.
    resize(app, 40, 22);
    p = at('1 Explorer');
    mouse.click(p.x, p.y);
    await until(() => /❯ T Clubs/.test(frame()), 'the explorer again');
    app.stdin.write('j');
    await until(() => /❯ T Players/.test(frame()), 'on Players');
    app.stdin.write('\r');
    const header = () => frame().split('\n')[3];
    await until(() => frame().includes('Rui Costa') && /^│\s+Id │/.test(header()), 'the rows of Players, not all columns');
    assert.doesNotMatch(header(), /Goals/);
    const grid = () => frame().split('\n')[5];
    mouse.wheel(10, 8, 1);
    await until(() => grid().includes('João Pinto'), 'three rows scrolled');
    assert.doesNotMatch(frame(), /❯/);
    app.stdin.write('j');
    await until(() => /❯.*Ana Silva/.test(grid()), 'the cursor one down, in view');
    // Sideways: the cell cursor stays on Id (out of sight), until h or l moves it.
    mouse.wheel(10, 8, 1, { shift: true });
    await until(() => /^│\s+ClubId │/.test(header()), 'a column scrolled');
    mouse.wheel(10, 8, 1, { shift: true });
    await until(() => /^│\s+Name /.test(header()), 'two columns scrolled');
    app.stdin.write('h');
    await until(() => /^│\s+Id │/.test(header()), 'back to the cell cursor');
  } finally {
    app.unmount();
  }
});

test('in the console a click puts the cursor on the character under it, double and triple clicks select, a drag selects and copies, and the wheel scrolls', async () => {
  const mouse = fakeMouse();
  const copied = [];
  const app = start({ mouse, clipboard: async (text) => (copied.push(text), 'system') });
  try {
    await until(() => frame().includes('Translations'), 'the explorer');
    let p = at('2 Query');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('An empty console'), 'the empty console');
    app.stdin.write('i');
    await until(() => frame().includes('typing SQL'), 'typing');
    // Pasted in one go: forty lines, the cursor ending on the last.
    app.stdin.write(Array.from({ length: 40 }, (_, i) => `SELECT ${i + 1} AS n`).join('\n'));
    await until(() => frame().includes('SELECT 40 AS n'), 'the pasted lines');
    assert.doesNotMatch(frame(), /SELECT 20 AS n/);

    // The wheel scrolls the text and leaves the cursor at the end, out of sight.
    mouse.wheel(10, 6, -1);
    mouse.wheel(10, 6, -1);
    await until(() => frame().includes('SELECT 30 AS n') && !frame().includes('SELECT 40 AS n'), 'six lines up');
    // A click lands on the character under it: typing goes in before the 1 of "SELECT 31".
    p = at('SELECT 31 AS n');
    mouse.click(p.x + 7, p.y);
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write('X');
    await until(() => frame().includes('SELECT X31 AS n'), 'typed where the click was');
    // Scrolled away again, a key brings the cursor back into view.
    mouse.wheel(10, 6, -1);
    mouse.wheel(10, 6, -1);
    await until(() => !frame().includes('SELECT X31 AS n'), 'scrolled away from the cursor');
    app.stdin.write('Y');
    await until(() => frame().includes('SELECT XY31 AS n'), 'back at the cursor');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('↵/i type'), 'out of typing mode');
    // Not typing, a click only moves the cursor (the line number lights up; nothing is typed).
    p = at('SELECT 25 AS n');
    mouse.click(p.x, p.y);
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write('i');
    await until(() => frame().includes('typing SQL'), 'typing again');
    app.stdin.write('Z');
    await until(() => frame().includes('ZSELECT 25 AS n'), 'typed at the start of the clicked line');

    // A double-click selects the word under it, a triple-click the line; typing replaces them.
    p = at('SELECT 26 AS n');
    mouse.click(p.x + 10, p.y);
    mouse.click(p.x + 10, p.y);
    await until(() => frame().includes('selected · ctrl+r runs just this'), 'the word selected');
    app.stdin.write('=');
    await until(() => frame().includes('SELECT 26 = n'), 'the word replaced');
    p = at('SELECT 27 AS n');
    mouse.click(p.x + 2, p.y);
    mouse.click(p.x + 2, p.y);
    mouse.click(p.x + 2, p.y);
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write('--');
    await until(() => /27 -- +│/.test(frame()), 'the line replaced');

    // A drag selects the SQL it covers, and copies it.
    const a = at('SELECT 28 AS n');
    const b = at('SELECT 29 AS n');
    mouse.drag(a, { x: b.x + 'SELECT 29 AS n'.length, y: b.y });
    await until(() => copied.length === 1 && frame().includes('Copied 2 lines'), 'the drag copied');
    assert.deepEqual(copied, ['SELECT 28 AS n\nSELECT 29 AS n']);
    app.stdin.write('+');
    await until(() => /28 \+ +│/.test(frame()) && frame().includes('SELECT 30 AS n'), 'the selection replaced');
  } finally {
    app.unmount();
  }
});

test('clicks under the console go to the results there, and clicking away from a cell keeps what was typed', async () => {
  // A home of its own, for an empty console.
  process.env.TRAWL_HOME = join(base, 'home-under');
  const mouse = fakeMouse();
  const app = start({ mouse });
  try {
    await until(() => frame().includes('Translations'), 'the explorer');
    let p = at('2 Query');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('An empty console'), 'the console');
    app.stdin.write('i');
    await until(() => frame().includes('typing SQL'), 'typing');
    // A click on a suggestion takes it, as tab does.
    for (const ch of 'SELECT * FROM Clu') {
      app.stdin.write(ch);
      await new Promise((r) => setTimeout(r, 5));
    }
    await until(() => frame().includes('dbo · table'), 'the suggestions');
    p = at('dbo · table');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('SELECT * FROM dbo.Clubs') && !frame().includes('dbo · table'), 'the suggestion taken');
    app.stdin.write('\r');
    app.stdin.write('\r');
    app.stdin.write('SELECT 1');
    // A click in the gutter selects the statement on that line; ctrl+r runs just that.
    p = at('SELECT * FROM dbo.Clubs');
    mouse.click(p.x - 3, p.y);
    await until(() => frame().includes('selected · ctrl+r runs just this'), 'the statement selected');
    app.stdin.write('\x12'); // ctrl+r
    await until(() => frame().includes('Club A FC') && frame().includes('─ Console '), 'the results under the console');
    // A click on a row there picks it, and typing stops.
    p = at('Union Sud');
    mouse.click(p.x, p.y);
    await until(() => /❯.*Union Sud/.test(frame()) && frame().includes('↵/i type'), 'the row picked, typing stopped');

    // In Results: typing into a cell, then a click on the prompt keeps it, as ↵ would.
    p = at('3 Results');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('h/l columns'), 'Results');
    p = at('Atlético Norte');
    mouse.click(p.x, p.y);
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write('e');
    await until(() => frame().includes('editing the cell'), 'typing in the cell');
    app.stdin.write('\x15');
    app.stdin.write('Club Q2');
    await until(() => frame().includes('Club Q2'), 'typed into the cell');
    p = at('Press / for commands');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('1 edited row not saved') && frame().includes('enter run · tab complete'), 'the change staged, the prompt focused');

    // While a question is open, the mouse does nothing: its answers take keys.
    p = at('─ SELECT * FROM dbo.Clubs');
    mouse.click(p.x, p.y + 4);
    await until(() => !frame().includes('enter run · tab complete'), 'the view focused');
    app.stdin.write('s');
    await until(() => frame().includes('Save 1 edited row to dbo.Clubs on demo?'), 'the question');
    p = at('4 History');
    mouse.click(p.x, p.y);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(frame(), /Save 1 edited row/);
    assert.doesNotMatch(frame(), /─ History /);
    app.stdin.write('2');
    await until(() => !frame().includes('Save 1 edited row'), 'the question answered');
  } finally {
    app.unmount();
  }
});

test('with the mouse setting off, the terminal is asked not to report it', async () => {
  const mouse = fakeMouse();
  const app = start({ mouse }, { mouse: false });
  try {
    await until(() => frame().includes('Translations'), 'the explorer');
    assert.deepEqual(mouse.enabled, [false]);
  } finally {
    app.unmount();
  }
});
