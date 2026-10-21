// A connection that drops (Azure SQL closing an idle one, a laptop waking up): how each driver's
// errors are recognised, and what the app does about it, end to end against the demo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterLostConnection } from '../src/actions.js';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { connectionLost, DbError, runScript } from '../src/db.js';
import { postgresSession } from '../src/db-postgres.js';
import { mysqlSession } from '../src/db-mysql.js';
import { demoSession } from '../src/demo.js';
import { App } from '../src/ui/App.jsx';

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

test('tedious’s socket errors, closed connections and requests on a dead one are a lost connection', () => {
  const reset = err('read ECONNRESET', { code: 'ECONNRESET' });
  assert.equal(connectionLost(err('Connection lost - read ECONNRESET', { code: 'ESOCKET', cause: reset })), true);
  assert.equal(connectionLost(err('Connection closed before request completed.', { code: 'ECLOSE' })), true);
  assert.equal(connectionLost(err('Requests can only be made in the LoggedIn state, not the Final state', { code: 'EINVALIDSTATE' })), true);
  assert.equal(connectionLost(err('Connection lost - socket hang up', { code: 'ESOCKET' })), true);
  assert.equal(connectionLost(err('Timeout: Request failed to complete in 15000ms', { code: 'ETIMEOUT' })), true);
  // A request while another runs is the app's mistake, not a dropped connection.
  assert.equal(connectionLost(err('Requests can only be made in the LoggedIn state, not the SentClientRequest state', { code: 'EINVALIDSTATE' })), false);
  assert.equal(connectionLost(err('Canceled.', { code: 'ECANCEL' })), false);
  assert.equal(connectionLost(err("Incorrect syntax near 'FORM'.", { number: 102 })), false);
  assert.equal(connectionLost(err("Login failed for user 'sa'.", { code: 'ELOGIN' })), false);
});

test('pg’s terminated connections and the server’s connection codes are a lost connection', () => {
  assert.equal(connectionLost(err('Connection terminated unexpectedly')), true);
  assert.equal(connectionLost(err('Client was closed and is not queryable')), true);
  assert.equal(connectionLost(err('terminating connection due to administrator command', { code: '57P01' })), true);
  assert.equal(connectionLost(err('connection failure', { code: '08006' })), true);
  assert.equal(connectionLost(err('column "nope" does not exist', { code: '42703' })), false);
  assert.equal(connectionLost(err('canceling statement due to user request', { code: '57014' })), false);
});

test('mysql2’s lost and closed connections, and its fatal errors, are a lost connection', () => {
  assert.equal(connectionLost(err('Connection lost: The server closed the connection.', { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })), true);
  assert.equal(connectionLost(err("Can't add new command when connection is in closed state")), true);
  assert.equal(connectionLost(err('The client was disconnected by the server because of inactivity.', { code: 'ER_CLIENT_INTERACTION_TIMEOUT', errno: 4031 })), true);
  assert.equal(connectionLost(err('write EPIPE', { code: 'EPIPE' })), true);
  assert.equal(connectionLost(err('You have an error in your SQL syntax', { code: 'ER_PARSE_ERROR', errno: 1064 })), false);
});

test('a session that has closed fails its next run as lost, and one lost part-way closes', async () => {
  const session = { conn: { name: 'x' }, closed: true };
  await assert.rejects(runScript(session, 'SELECT 1', async () => {}), (e) => e instanceof DbError && e.lost && e.notRun && /has closed/.test(e.message));
  let ends = 0;
  const live = { conn: { name: 'x' }, closed: false, close() {}, onEnd: () => ends++ };
  await assert.rejects(
    runScript(live, 'SELECT 1', async () => {
      throw err('Connection lost - read ECONNRESET', { code: 'ESOCKET' });
    }),
    (e) => e.lost && Boolean(e.partial),
  );
  assert.equal(live.closed, true);
  assert.equal(ends, 1);
});

test('the Postgres and MySQL sessions mark lost errors, and close when the connection drops while idle', async () => {
  const pg = Object.assign(new EventEmitter(), {
    query: async () => {
      throw err('Connection terminated unexpectedly');
    },
    end: async () => {},
  });
  const p = postgresSession({ name: 'pg', kind: 'postgres' }, pg);
  await assert.rejects(p.run('SELECT 1'), (e) => e.lost);
  assert.equal(p.closed, true);

  const c = Object.assign(new EventEmitter(), { query: async () => [[], []], end: async () => {} });
  const m = mysqlSession({ name: 'my', kind: 'mysql' }, c);
  let ends = 0;
  m.onEnd = () => ends++;
  c.emit('error', err('Connection lost: The server closed the connection.', { code: 'PROTOCOL_CONNECTION_LOST', fatal: true }));
  c.emit('end');
  assert.equal(m.closed, true);
  assert.equal(ends, 1, 'told once, though both error and end came');
  // Some other error while idle leaves it be.
  const c2 = Object.assign(new EventEmitter(), { query: async () => [[], []], end: async () => {} });
  const m2 = mysqlSession({ name: 'my', kind: 'mysql' }, c2);
  c2.emit('error', err('something odd', { code: 'ER_X' }));
  assert.equal(m2.closed, false);
});

test('the demo can lose its connection while idle (rolling back) or during a run', async () => {
  const s = demoSession(DEMO_CONNECTIONS[0]);
  await s.run('BEGIN TRAN');
  let ends = 0;
  s.onEnd = () => ends++;
  s.drop();
  assert.equal([s.closed, s.tran, ends].join(), 'true,0,1');
  const t = demoSession(DEMO_CONNECTIONS[0]);
  t.drop({ during: /UPDATE/ });
  await t.run('SELECT 1 AS x');
  await assert.rejects(t.run('UPDATE dbo.Players SET Goals = 0 WHERE Id = 1'), (e) => e.lost);
  assert.equal(t.closed, true);
});

test('after a lost connection only a read with no transaction open runs again', () => {
  assert.deepEqual(afterLostConnection('SELECT * FROM dbo.Clubs').rerun, true);
  const write = afterLostConnection('UPDATE dbo.Clubs SET Active = 0 WHERE Id = 3');
  assert.equal(write.rerun, false);
  assert.match(write.message, /may or may not have been made/);
  const tran = afterLostConnection('SELECT 1', { hadTran: true });
  assert.equal(tran.rerun, false);
  assert.match(tran.message, /rolled it back/);
  assert.match(afterLostConnection('COMMIT TRANSACTION;', { hadTran: true }).message, /may or may not have gone through/);
  assert.match(afterLostConnection('BEGIN TRANSACTION\nUPDATE t SET x = 1', { wrapped: true }).message, /nothing of it was kept/);
  assert.equal(afterLostConnection('DELETE FROM users WHERE id = 1', { dialect: 'postgres' }).rerun, false);
});

// End to end, against the demo: the sessions App opens are kept to drop them.
const KEYS = { enter: '\r' };
let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-reconnect-'));
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
const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const frame = () => lastApp.lastFrame();
const flat = () => frame().replace(/\s+/g, ' ');

function start() {
  const sessions = [];
  const open = async (conn, { database }) => {
    const s = demoSession(conn, { database });
    sessions.push(s);
    return s;
  };
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  lastApp = render(React.createElement(App, { config, initialConnection: 'demo', open }));
  return { app: lastApp, sessions };
}

const run = async (app, sql) => {
  await type(app.stdin, `!${sql}`);
  app.stdin.write(KEYS.enter);
};

test('a connection that drops while idle shows in the header, and the next run reconnects first, with /stats as it was', async () => {
  const { app, sessions } = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '/stats on');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('stats on'), 'statistics on');
  sessions[0].drop();
  await until(() => frame().includes('DISCONNECTED') && flat().includes('The connection to demo dropped. Trawl reconnects on the next run.'), 'the drop');
  await run(app, 'SELECT * FROM dbo.Clubs');
  await until(() => flat().includes('a new connection') && frame().includes('Atlético Norte'), 'the reconnect and the rows');
  assert.doesNotMatch(frame(), /DISCONNECTED/);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].database, 'ClubA');
  assert.equal(sessions[1].statsIO, true, '/stats is set on the new connection');
  app.unmount();
});

test('a read whose connection drops part-way reconnects and runs again, saying so', async () => {
  const { app, sessions } = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  sessions[0].drop({ during: /dbo\.Clubs/ });
  await run(app, 'SELECT * FROM dbo.Clubs');
  await until(() => flat().includes('reconnected and ran it again') && frame().includes('Atlético Norte'), 'the rerun');
  assert.equal(sessions.length, 2);
  assert.doesNotMatch(frame(), /DISCONNECTED/);
  app.unmount();
});

test('a write whose connection drops part-way is not run again: it may or may not have happened', async () => {
  const { app, sessions } = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  // The count before it (a SELECT) gets through; the UPDATE loses the connection.
  sessions[0].drop({ during: /^UPDATE/m });
  await run(app, 'UPDATE dbo.Players SET Goals = 0 WHERE Id = 1');
  await until(() => flat().includes('the change may or may not have been made') && flat().includes('Reconnected to demo.'), 'the warning');
  assert.equal(sessions.length, 2);
  assert.doesNotMatch(flat(), /ran it again|1 row affected/);
  app.unmount();
});

test('an open transaction lost with the connection is said, and the header stops showing it', async () => {
  const { app, sessions } = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await type(app.stdin, '/tx manual');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('manual commit'), 'manual commit');
  await run(app, 'UPDATE dbo.Players SET Goals = 0 WHERE Id = 1');
  await until(() => frame().includes('TRANSACTION OPEN'), 'the open transaction');
  // During a run: not run again, the transaction said to be gone.
  sessions[0].drop({ during: /dbo\.Clubs/ });
  await run(app, 'SELECT * FROM dbo.Clubs');
  await until(() => flat().includes('The open transaction went with it'), 'the lost transaction');
  assert.doesNotMatch(frame(), /TRANSACTION OPEN/);
  assert.doesNotMatch(flat(), /ran it again/);
  // While idle: said in the log.
  await run(app, 'UPDATE dbo.Players SET Goals = 0 WHERE Id = 2');
  await until(() => frame().includes('TRANSACTION OPEN'), 'another transaction');
  sessions.at(-1).drop();
  await until(() => flat().includes('and its open transaction with it: the server rolled that back') && !frame().includes('TRANSACTION OPEN'), 'the idle drop');
  app.unmount();
});
