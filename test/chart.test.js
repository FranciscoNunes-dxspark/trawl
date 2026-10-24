// chart.js: picking a chart from a result set's columns and laying it out; then b in Results, against
// the demo (helpers copied from app.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { columnKinds, drawChart, formatNumber, hbar, planChart, timeFormatter, toNumber, toTime } from '../src/chart.js';
import { stringWidth } from '../src/text.js';
import { App } from '../src/ui/App.jsx';

const d = (s) => new Date(`${s}T00:00:00Z`);
const cols = (...names) => names.map((name) => ({ name, type: '' }));
const text = (lines) => lines.map((l) => l.map((s) => s.text).join(''));

const matches = { columns: cols('Id', 'PlayedOn', 'HomeGoals', 'AwayGoals'), rows: Array.from({ length: 8 }, (_, i) => [i + 1, d(`2026-0${i + 1}-1${i}`), i % 4, (i + 2) % 3]), truncated: false };
const players = { columns: cols('Id', 'Name', 'Goals'), rows: [[1, 'Rui', 3], [2, 'Ana', 7], [3, 'Marta', null], [4, 'João', 12], [5, 'Ana', 1]], truncated: false };

test('values become numbers and times, and columns get a kind', () => {
  assert.equal(toNumber(3), 3);
  assert.equal(toNumber(12n), 12);
  assert.equal(toNumber('12.50'), 12.5);
  assert.equal(toNumber('12a'), null);
  assert.equal(toNumber(true), null);
  assert.equal(toTime(d('2026-01-02')), Date.UTC(2026, 0, 2));
  assert.equal(toTime('2026-01-02'), Date.UTC(2026, 0, 2));
  assert.equal(toTime('2026-01-02 10:30'), Date.UTC(2026, 0, 2, 10, 30));
  assert.equal(toTime('2026-01-02T10:30:00+01:00'), Date.UTC(2026, 0, 2, 9, 30));
  assert.equal(toTime('Tuesday'), null);
  assert.deepEqual(columnKinds(matches), ['number', 'date', 'number', 'number']);
  assert.deepEqual(columnKinds({ columns: cols('a', 'b'), rows: [[null, 'x'], [null, '1']] }), ['empty', 'text']);
});

test('the chart is picked from the columns: dates and numbers a line, text and a number bars, one number a histogram, two a scatter', () => {
  // Keys (Id, ClubId) are left out while there are other numbers.
  assert.deepEqual(planChart(matches), { type: 'line', x: 1, y: [2, 3], picked: true });
  assert.deepEqual(planChart(players), { type: 'bars', x: 1, y: [2], picked: true });
  assert.deepEqual(planChart({ columns: cols('Goals'), rows: [[1], [2]] }), { type: 'histogram', x: 0, y: [], picked: true });
  assert.deepEqual(planChart({ columns: cols('Height', 'Weight'), rows: [[1, 2]] }), { type: 'scatter', x: 0, y: [1], picked: true });
  assert.match(planChart({ columns: cols('Name'), rows: [['a']] }).reason, /no number columns/);
  assert.match(planChart(null).reason, /Run a query first/);
  assert.match(planChart({ columns: cols('a'), rows: [] }).reason, /no rows/);
});

test('/chart names the kind and the columns, and says what is wrong with them', () => {
  assert.deepEqual(planChart(players, ['bars', 'name', 'Goals']), { type: 'bars', x: 1, y: [2] });
  assert.deepEqual(planChart(players, ['histogram', 'Goals']), { type: 'histogram', x: 2, y: [] });
  assert.deepEqual(planChart(players, ['Goals']), { type: 'histogram', x: 2, y: [] });
  assert.deepEqual(planChart(matches, ['line', 'PlayedOn', 'AwayGoals']), { type: 'line', x: 1, y: [3] });
  assert.deepEqual(planChart(matches, ['scatter', 'HomeGoals', 'AwayGoals']), { type: 'scatter', x: 2, y: [3] });
  assert.deepEqual(planChart(matches, ['bars']), { type: 'bars', x: 1, y: [2], picked: true });
  assert.match(planChart(players, ['Nope']).reason, /No column named Nope: the columns are Id, Name, Goals\./);
  assert.match(planChart(players, ['bars', 'Goals', 'Name']).reason, /Name isn't a number column/);
  assert.match(planChart(players, ['line', 'Name', 'Goals']).reason, /Name is text/);
  assert.match(planChart(players, ['histogram', 'Name']).reason, /needs a number column/);
});

test('labels: numbers grouped or to four digits, dates without a time when every one is at midnight', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber(3.14159), '3.142');
  assert.equal(formatNumber(-0.5), '-0.5');
  assert.equal(timeFormatter([Date.UTC(2026, 0, 2)])(Date.UTC(2026, 0, 2)), '2026-01-02');
  assert.equal(timeFormatter([Date.UTC(2026, 0, 2, 10, 5)])(Date.UTC(2026, 0, 2, 10, 5)), '2026-01-02 10:05');
  assert.equal(hbar(1, 4), '████');
  assert.equal(hbar(0.5, 3), '█▌');
  assert.equal(hbar(0, 3), '');
});

test('bars: biggest first, the same label added up, values at the ends, rows without a value counted out', () => {
  const plan = planChart(players);
  const { lines, about } = drawChart(players, plan, { width: 40, height: 10 });
  const t = text(lines);
  assert.match(t[0], /^João +│█+ 12$/);
  assert.match(t[1], /^Ana +│█+\S? 8$/);
  assert.match(t[2], /^Rui +│█+\S? 3$/);
  assert.equal(t.length, 3);
  for (const l of t) assert.ok(stringWidth(l) <= 40, l);
  assert.equal(about, 'From all 5 rows Trawl has; 1 without a value left out; rows with the same label added up.');
  // Too many for the room: the smallest go, and it says so.
  const many = { columns: cols('Name', 'Goals'), rows: Array.from({ length: 30 }, (_, i) => [`p${i}`, i]) };
  const small = drawChart(many, planChart(many), { width: 40, height: 6 });
  assert.equal(small.lines.length, 5);
  assert.match(text(small.lines)[0], /^p29/);
  assert.match(small.about, /the 25 smallest not shown \(no room\)/);
});

test('a time series: a legend for two series, the axes labelled with the real highest, lowest and dates', () => {
  const plan = planChart(matches);
  const { lines, about } = drawChart(matches, plan, { width: 60, height: 14, colors: { series: ['A', 'B'], axis: 'X', label: 'L' } });
  const t = text(lines);
  assert.match(t[0], /^● HomeGoals {3}● AwayGoals$/);
  assert.deepEqual(lines[0].map((s) => s.color), ['A', 'L', 'B', 'L']);
  // The middle label (1.5) is the widest, so the others are right-aligned to it.
  assert.match(t[1], /^ {2}3 ┤/);
  assert.match(t[6], /^1\.5 ┤/);
  assert.match(t.at(-3), /^ {2}0 ┤/);
  assert.match(t.at(-2), /^ {4}└─+$/);
  assert.match(t.at(-1), /^ {5}2026-01-10 .*2026-08-17$/);
  assert.equal(t.length, 14);
  for (const l of t) assert.equal(stringWidth(l) <= 60, true, l);
  // Each series' points are in its colour.
  assert.ok(lines.slice(1).some((l) => l.some((s) => s.color === 'A' && s.text.includes('●'))));
  assert.ok(lines.slice(1).some((l) => l.some((s) => s.color === 'B' && s.text.includes('●'))));
  assert.equal(about, 'From all 8 rows Trawl has.');
});

test('a histogram counts rows per range; a scatter marks how many share a place; the limit is said', () => {
  const goals = { columns: cols('Goals'), rows: [[0], [0], [1], [2], [2], [2], [5]], truncated: true };
  const h = drawChart(goals, planChart(goals), { width: 40, height: 8 });
  const t = text(h.lines);
  assert.match(t[0], /^3 ┤/);
  assert.match(t.at(-3), /^0 ┤█/);
  assert.match(t.at(-1), /^ {3}0 .* 5$/);
  assert.match(h.about, /^From the first 7 rows, where the row limit stopped the query \(m in Results fetches more\); a bar per value, the tallest 3 rows\.$/);
  const xy = { columns: cols('a', 'b'), rows: [[1, 1], [1, 1], [1, 1], [1, 1], [5, 9], [3, 4], [3, 4]] };
  const s = drawChart(xy, planChart(xy), { width: 30, height: 8 });
  const st = text(s.lines);
  assert.ok(st.some((l) => l.includes('●')) && st.some((l) => l.includes('•')) && st.some((l) => l.includes('·')));
  assert.match(st[0], /^9 ┤/);
  assert.match(s.about, /· one row, • two or three, ● four or more/);
});

// ---------------------------------------------------------------------------------------------------

const KEYS = { enter: '\r', esc: '\x1b' };
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
const frame = () => lastApp.lastFrame();
const type = async (stdin, s) => {
  for (const ch of s) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('b in Results charts the rows on screen, esc goes back to the grid, and /chart names what to draw', async () => {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, initialConnection: 'demo' })));
  await until(() => frame().includes('Translations'), 'the explorer');
  await type(app.stdin, '!SELECT * FROM dbo.Matches');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('8 rows'), 'the matches');
  app.stdin.write('b');
  await until(() => frame().includes('Line: HomeGoals, AwayGoals by PlayedOn'), 'the chart');
  assert.match(frame(), /● HomeGoals {3}● AwayGoals/);
  assert.match(frame(), /2026-02-11/);
  assert.match(frame(), /From all 8 rows Trawl has\./);
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Line: ') && frame().includes('HomeGoals │'), 'the grid again');
  await type(app.stdin, '/chart bars HomeId HomeGoals');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Bars: HomeGoals by HomeId'), 'the bars');
  assert.match(frame(), /rows with the same label added up/);
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Bars: '), 'the grid again');
  await type(app.stdin, '/chart Nope');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('No column named Nope'), 'the error');
  app.unmount();
});
