import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOUSE_OFF, MOUSE_ON, atLeast, listenMouse, mouseSession, parseMouse } from '../src/mouse.js';
import { frameLines, osc52, selectedText, selectionRows, stripAnsi } from '../src/selection.js';

test('mouse reports: presses, releases, the wheel, drags and modifiers, with keys left in place', () => {
  const { rest, events } = parseMouse('j\x1b[<0;12;5M\x1b[<0;12;5mk\x1b[<65;3;4M\x1b[<64;3;4M\x1b[<32;13;5M\x1b[<20;1;1M\x1b[<66;1;1M');
  assert.equal(rest, 'jk');
  assert.deepEqual(events.map((e) => [e.button, e.x, e.y, e.release, e.drag, e.wheel]), [
    ['left', 11, 4, false, false, undefined],
    ['left', 11, 4, true, false, undefined],
    ['wheel', 2, 3, false, false, 1],
    ['wheel', 2, 3, false, false, -1],
    ['left', 12, 4, false, true, undefined],
    ['left', 0, 0, false, false, undefined],
    // Tilting the wheel sideways isn't scrolling.
    ['tilt', 0, 0, false, false, undefined],
  ]);
  assert.equal(events[5].shift, true);
  assert.equal(events[5].ctrl, true);
  assert.equal(events[5].alt, false);
  assert.deepEqual(parseMouse('\x1b[A\x1b'), { rest: '\x1b[A\x1b', events: [] });
});

// What Ink's readable handler does: read until null.
const drain = (stdin) => {
  const out = [];
  let chunk;
  while ((chunk = stdin.read()) !== null) out.push(chunk);
  return out.join('');
};

test("listenMouse takes reports out of what Ink reads, a report cut in two included, and doesn't hold up esc", () => {
  const queue = [];
  const stdin = { read: () => (queue.length ? queue.shift() : null) };
  const events = [];
  const undo = listenMouse(stdin, (e) => events.push(e));

  queue.push('a\x1b[<0;5;6Mb');
  assert.equal(drain(stdin), 'ab');
  assert.equal(events.length, 1);

  // A read boundary in the middle of a report: the start waits for the rest.
  queue.push('c\x1b[<64;1');
  assert.equal(drain(stdin), 'c');
  queue.push('0;2Md');
  assert.equal(drain(stdin), 'd');
  assert.deepEqual([events[1].button, events[1].wheel, events[1].x, events[1].y], ['wheel', -1, 9, 1]);

  // A lone ESC is the esc key, passed on at once; so are arrows.
  queue.push('\x1b');
  assert.equal(drain(stdin), '\x1b');
  queue.push('\x1b[B');
  assert.equal(drain(stdin), '\x1b[B');
  // Only mouse in a read: an empty string, which Ink turns into no key at all.
  queue.push('\x1b[<0;1;1M');
  assert.equal(drain(stdin), '');
  assert.equal(events.length, 3);

  undo();
  queue.push('\x1b[<0;1;1M');
  assert.equal(drain(stdin), '\x1b[<0;1;1M');
});

test('Node versions that hand Windows mouse input over (22.17 and later)', () => {
  assert.equal(atLeast('v22.13.1', 22, 17), false);
  assert.equal(atLeast('v22.17.0', 22, 17), true);
  assert.equal(atLeast('v23.0.0', 22, 17), true);
  assert.equal(atLeast('v20.19.0', 22, 17), false);
});

test('a frame as Ink writes it: the moves and erasing in front go, the styles stay', () => {
  assert.deepEqual(frameLines('\x1b[2K\x1b[1A\x1b[2K\x1b[G\x1b[1mone\x1b[22m\ntwo\n'), ['\x1b[1mone\x1b[22m', 'two']);
  assert.equal(frameLines('\x1b[?25l'), null);
  assert.equal(stripAnsi('\x1b[38;2;1;2;3mred\x1b[39m'), 'red');
});

test('what a drag selects: rows in between whole, wide characters whole, either direction', () => {
  const lines = ['\x1b[1mfirst line\x1b[22m', 'second line', '日本語 text', 'last'];
  const down = selectionRows(lines, { x: 6, y: 0 }, { x: 5, y: 1 });
  assert.deepEqual(down, [
    { y: 0, col: 6, text: 'line' },
    { y: 1, col: 0, text: 'second' },
  ]);
  assert.deepEqual(selectionRows(lines, { x: 5, y: 1 }, { x: 6, y: 0 }), down);
  assert.equal(selectedText(selectionRows(lines, { x: 0, y: 1 }, { x: 3, y: 3 })), 'second line\n日本語 text\nlast');
  // The second half of a wide character takes the whole character.
  assert.deepEqual(selectionRows(lines, { x: 3, y: 2 }, { x: 5, y: 2 }), [{ y: 2, col: 2, text: '本語' }]);
  assert.equal(osc52('hé'), `\x1b]52;c;${Buffer.from('hé').toString('base64')}\x07`);
});

/** A session over a fake terminal: what's written, what's copied, what App would hear. */
function fakeTerminal() {
  const queue = [];
  const stdin = { read: () => (queue.length ? queue.shift() : null) };
  const written = [];
  const stdout = { write: (d) => (written.push(d), true), on() {}, columns: 40, rows: 10 };
  const copied = [];
  const heard = [];
  const mouse = mouseSession(stdin, stdout, { copy: (t) => copied.push(t) });
  mouse.subscribe((e) => heard.push(e));
  mouse.enable(true);
  const input = (s) => {
    queue.push(s);
    return drain(stdin);
  };
  const sgr = (code, x, y, end = 'M') => input(`\x1b[<${code};${x + 1};${y + 1}${end}`);
  return { mouse, written, copied, heard, input, sgr };
}

test('a press and release in one place is a click; a drag selects, paints and copies instead', () => {
  const t = fakeTerminal();
  assert.equal(t.written.at(-1), MOUSE_ON);
  t.mouse.stdout.write('\x1b[2K\x1b[Gheader\nsome text here\nmore\n');

  // A click reaches App once the button is up, where it went down.
  t.sgr(0, 2, 1);
  assert.equal(t.heard.length, 0);
  t.sgr(0, 2, 1, 'm');
  assert.deepEqual([t.heard[0].button, t.heard[0].x, t.heard[0].y], ['left', 2, 1]);

  // A drag: painted in reverse video as it goes, copied on release, and App hears about the copy, not a click.
  t.sgr(0, 5, 1);
  t.sgr(32, 8, 1);
  assert.match(t.written.at(-1), /\x1b\[2;6H\x1b\[7mtext\x1b\[27m/);
  t.sgr(32, 1, 2);
  t.sgr(0, 1, 2, 'm');
  assert.deepEqual(t.copied, ['text here\nmo']);
  assert.deepEqual(t.heard.at(-1), { type: 'copy', text: 'text here\nmo' });
  assert.equal(t.heard.length, 2);

  // The next frame gets the selection painted over it again; a key clears it, drawing the rows as they were.
  t.mouse.stdout.write('\x1b[2K\x1b[Gheader\nsome text here\nmore\n');
  assert.match(t.written.at(-1), /\x1b7.*\x1b\[7m.*\x1b8/);
  assert.equal(t.input('j'), 'j');
  assert.match(t.written.at(-1), /\x1b\[2;1H\x1b\[0msome text here/);
  t.mouse.stdout.write('\x1b[2K\x1b[Gheader\nsome text here\nmore\n');
  assert.doesNotMatch(t.written.at(-1), /\x1b\[7m/);

  // The wheel goes straight through.
  t.sgr(65, 3, 3);
  assert.equal(t.heard.at(-1).wheel, 1);

  t.mouse.enable(false);
  assert.equal(t.written.at(-1), MOUSE_OFF);
});

test('a drag the app claims goes to it, move by move, and nothing is painted or copied', () => {
  const t = fakeTerminal();
  t.mouse.stdout.write('header\nsome text here\nmore\n');
  t.mouse.claimDrags((p) => p.y === 1);
  const written = t.written.length;
  t.sgr(0, 5, 1);
  t.sgr(32, 8, 1);
  t.sgr(32, 2, 2);
  t.sgr(0, 2, 2, 'm');
  assert.deepEqual(
    t.heard.map((e) => [e.x, e.y, e.drag, e.release, e.from]),
    [
      [8, 1, true, false, { x: 5, y: 1 }],
      [2, 2, true, false, { x: 5, y: 1 }],
      [2, 2, true, true, { x: 5, y: 1 }],
    ],
  );
  assert.equal(t.written.length, written);
  assert.deepEqual(t.copied, []);
  // Without moving, it's still a click; elsewhere, a drag selects as before.
  t.sgr(0, 3, 1);
  t.sgr(0, 3, 1, 'm');
  assert.deepEqual([t.heard.at(-1).x, t.heard.at(-1).drag], [3, false]);
  t.sgr(0, 0, 2);
  t.sgr(32, 3, 2);
  t.sgr(0, 3, 2, 'm');
  assert.deepEqual(t.copied, ['more']);
});
