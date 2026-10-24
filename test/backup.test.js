// backup.js and /backup, /restore: the refusals, SQL Server's statements and paths, the tools' command
// lines (the password only in their environment), the actions over a stubbed runner, and the demo's
// SQL Server path end to end (helpers copied from app.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { backupPath, backupRefusal, dumpCommand, isAzureSqlDatabase, loadCommand, notInstalled, onThisMachine, parseBackupArgs, restoreMoves, restoreSql, serverJoin, shellArg, stamp } from '../src/backup.js';
import * as a from '../src/actions.js';
import { App } from '../src/ui/App.jsx';

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-'));
  process.env.TRAWL_HOME = join(base, 'home');
});
after(() => rmSync(base, { recursive: true, force: true }));

const dev = { name: 'dev', server: 'localhost,1433', user: 'sa' };

test('refused outright on production, read-only and Azure SQL Database, and for the tools through a tunnel', () => {
  assert.match(backupRefusal({ ...dev, prod: true }), /dev is production: \/backup and \/restore only work on a connection that is neither/);
  assert.match(backupRefusal({ ...dev, readOnly: true }), /dev is read-only/);
  // Production that was allowed writes is still production.
  assert.match(backupRefusal({ ...dev, prod: true, readOnly: false }), /is production/);
  assert.match(backupRefusal({ name: 'az', server: 'tcp:myserver.database.windows.net,1433' }), /Azure SQL Database has no BACKUP to a file.*\.bacpac/);
  assert.equal(isAzureSqlDatabase({ server: 'myserver.database.windows.net' }), true);
  assert.equal(isAzureSqlDatabase({ server: 'sqlvm.westeurope.cloudapp.azure.com' }), false);
  assert.match(backupRefusal({ name: 'pg', server: 'db:5432', ssh: 'me@bastion' }, 'postgres'), /SSH tunnel, which pg_dump can't use: run it on me@bastion/);
  assert.equal(backupRefusal({ name: 'pg', server: 'db:5432', ssh: 'me@bastion' }, 'sqlserver'), null);
  assert.equal(backupRefusal(dev), null);
});

test("SQL Server's paths are the server's: the default backup folder, a name in it, or a whole path", () => {
  const now = new Date('2026-10-24T15:30:12Z');
  assert.equal(stamp(now), '20261024-153012');
  const win = { backup_path: 'C:\\Program Files\\MSSQL\\Backup\\' };
  const linux = { backup_path: '/var/opt/mssql/data' };
  assert.equal(backupPath(win, 'Club A', null, now), 'C:\\Program Files\\MSSQL\\Backup\\Club_A-20261024-153012.bak');
  assert.equal(backupPath(linux, 'ClubA', null, now), '/var/opt/mssql/data/ClubA-20261024-153012.bak');
  assert.equal(backupPath(win, 'ClubA', 'mine.bak', now), 'C:\\Program Files\\MSSQL\\Backup\\mine.bak');
  assert.equal(backupPath(win, 'ClubA', 'D:\\b\\x.bak', now), 'D:\\b\\x.bak');
  assert.equal(backupPath(linux, 'ClubA', '\\\\nas\\b\\x.bak', now), '\\\\nas\\b\\x.bak');
  assert.equal(backupPath({}, 'ClubA', null, now), null);
  assert.equal(serverJoin('/a/b/', 'c'), '/a/b/c');
});

test("a restore's files go to the server's data and log folders under the target's name, over master", () => {
  const files = [
    { LogicalName: 'ClubA', PhysicalName: 'C:\\Data\\ClubA.mdf', Type: 'D' },
    { LogicalName: 'ClubA_2', PhysicalName: 'C:\\Data\\ClubA_2.ndf', Type: 'D' },
    { LogicalName: 'ClubA_log', PhysicalName: 'C:\\Logs\\ClubA_log.ldf', Type: 'L' },
  ];
  const moves = restoreMoves(files, 'ClubC', { data_path: 'D:\\Data\\', log_path: 'E:\\Logs' });
  assert.deepEqual(moves, [
    { logical: 'ClubA', to: 'D:\\Data\\ClubC.mdf' },
    { logical: 'ClubA_2', to: 'D:\\Data\\ClubC_2.ndf' },
    { logical: 'ClubA_log', to: 'E:\\Logs\\ClubC_log.ldf' },
  ]);
  // Without default folders: beside the files they were.
  assert.deepEqual(restoreMoves([{ LogicalName: 'x', PhysicalName: '/var/opt/mssql/data/x.mdf', Type: 'D' }], 'y', {}), [{ logical: 'x', to: '/var/opt/mssql/data/y.mdf' }]);
  assert.equal(
    restoreSql({ target: "Club'C", path: "C:\\B\\it's.bak", moves: moves.slice(0, 1), replace: true }),
    "USE master;\nALTER DATABASE [Club'C] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\nRESTORE DATABASE [Club'C] FROM DISK = N'C:\\B\\it''s.bak'\n  WITH MOVE N'ClubA' TO N'D:\\Data\\ClubC.mdf',\n    REPLACE,\n    RECOVERY,\n    STATS = 10;",
  );
  assert.doesNotMatch(restoreSql({ target: 'n', path: 'p', moves: [], replace: false }), /SINGLE_USER|REPLACE/);
});

test("the tools' command lines never hold the password: it's in their environment", () => {
  const pg = { name: 'shop', kind: 'postgres', server: 'db.local:6543', user: 'app', ssl: true };
  const dump = dumpCommand(pg, 'postgres', { database: 'shop', file: '/tmp/b/shop.dump', password: 's3cret' }, 'linux');
  assert.equal(dump.command, 'pg_dump -h db.local -p 6543 -U app -Fc --no-password -f /tmp/b/shop.dump shop');
  assert.deepEqual(dump.env, { PGPASSWORD: 's3cret', PGSSLMODE: 'require' });
  const load = loadCommand(pg, 'postgres', { database: 'shop copy', file: "/tmp/it's.dump", password: 's3cret', replace: true }, 'linux');
  assert.equal(load.command, "pg_restore -h db.local -p 6543 -U app --no-password --no-owner --no-privileges --clean --if-exists -d 'shop copy' '/tmp/it'\\''s.dump'");
  const my = { name: 'blog', kind: 'mysql', server: 'db.local', user: 'app' };
  const mdump = dumpCommand(my, 'mysql', { database: 'blog', file: 'C:\\Users\\me\\My Backups\\blog.sql', password: 'pw' }, 'win32');
  assert.equal(mdump.command, 'mysqldump --host db.local --port 3306 --user app --single-transaction --routines --triggers --events --result-file="C:\\Users\\me\\My Backups\\blog.sql" blog');
  assert.deepEqual(mdump.env, { MYSQL_PWD: 'pw' });
  assert.equal(loadCommand(my, 'mysql', { database: 'blog', file: '/b/blog.sql', password: 'pw' }, 'linux').command, 'mysql --host db.local --port 3306 --user app blog < /b/blog.sql');
  for (const c of [dump, load, mdump]) assert.doesNotMatch(c.command, /s3cret|pw\b/);
  assert.equal(shellArg('a b', 'win32'), '"a b"');
  assert.equal(shellArg('a"b', 'win32'), '"a""b"');
  assert.equal(shellArg('plain', 'linux'), 'plain');
});

test("arguments, a tool that isn't there, and whether the server is this machine", () => {
  assert.deepEqual(parseBackupArgs([]), { file: null, as: null });
  assert.deepEqual(parseBackupArgs(['x.bak', '--as', 'ClubC'], { restore: true }), { file: 'x.bak', as: 'ClubC' });
  assert.match(parseBackupArgs([], { restore: true }).reason, /Which backup/);
  assert.match(parseBackupArgs(['--as', 'x']).reason, /doesn't take --as/);
  assert.match(parseBackupArgs(['a', 'b']).reason, /One file/);
  assert.equal(notInstalled({ code: 127 }), true);
  assert.equal(notInstalled({ code: 1, message: "'pg_dump' is not recognized as an internal or external command," }), true);
  assert.equal(notInstalled({ code: 1, message: 'pg_dump: error: connection refused' }), false);
  assert.equal(onThisMachine({ server: 'localhost,1433' }, 'X', 'me'), true);
  assert.equal(onThisMachine({ server: '(localdb)\\MSSQLLocalDB' }, 'X', 'me'), true);
  assert.equal(onThisMachine({ server: 'ME\\SQLEXPRESS' }, 'ME', 'me'), true);
  assert.equal(onThisMachine({ server: 'db.corp' }, 'DB01', 'me'), false);
});

// A ctx with just what /backup and /restore use, on a Postgres or MySQL connection.
function fakeCtx(conn, { databases = ['shop'], fail = null } = {}) {
  const ctx = {
    notes: [],
    ran: [],
    sql: [],
    confirms: [],
    logged: [],
    tranCount: 0,
    schema: { database: 'shop', databases },
    session: { conn, database: 'shop', closed: false, run: async (sql) => (ctx.sql.push(sql), { sets: [], messages: [] }) },
    note: (text, kind) => ctx.notes.push({ text, kind }),
    confirm: async (req) => (ctx.confirms.push(req), true),
    task: async (title, start) => {
      try {
        const lines = await start(new AbortController().signal);
        return { ok: true, lines };
      } catch (error) {
        ctx.notes.push({ text: error.message, kind: 'error' });
        return { ok: false, error };
      }
    },
    runProgram: async (command, opts) => {
      ctx.ran.push({ command, env: opts.env });
      if (fail) throw fail;
      const m = /-f (\S+)|--result-file=(\S+)/.exec(command);
      if (m) writeFileSync((m[1] ?? m[2]).replace(/^['"]|['"]$/g, ''), 'dump');
      return { stdout: '', stderr: '' };
    },
    passwordFor: async () => 's3cret',
    refresh: () => {},
    logActivity: (text, opts) => ctx.logged.push({ text, ...opts }),
  };
  return ctx;
}

test('/backup on Postgres runs pg_dump with the password in its environment, to ~/.trawl/backups', async () => {
  const ctx = fakeCtx({ name: 'shop', kind: 'postgres', server: 'db.local', user: 'app' });
  await a.backup(ctx, '');
  assert.equal(ctx.ran.length, 1);
  assert.match(ctx.ran[0].command, /^pg_dump -h db\.local -p 5432 -U app -Fc --no-password -f \S+shop-shop-\d{8}-\d{6}\.dump"? shop$/);
  assert.doesNotMatch(ctx.ran[0].command, /s3cret/);
  assert.equal(ctx.ran[0].env.PGPASSWORD, 's3cret');
  assert.ok(ctx.ran[0].command.includes(join(base, 'home', 'backups')), ctx.ran[0].command);
  assert.match(ctx.notes.at(-1).text, /^Backed up shop to .*shop-shop-.*\.dump \(1 KB\)\.\n\/restore .* puts it back/);
  assert.deepEqual(ctx.logged, [{ text: 'pg_dump shop on shop', kind: 'backup' }]);
  // Not there: it says where it comes from.
  const missing = fakeCtx({ name: 'shop', kind: 'postgres', server: 'db.local', user: 'app' }, { fail: Object.assign(new Error('sh: 1: pg_dump: not found'), { code: 127 }) });
  await a.backup(missing, join(base, 'x.dump'));
  assert.match(missing.notes.at(-1).text, /pg_dump isn't installed, or isn't on PATH: it comes with PostgreSQL's client tools\./);
  // Production is refused before anything runs.
  const prod = fakeCtx({ name: 'live', kind: 'postgres', server: 'db', user: 'app', prod: true });
  await a.backup(prod, '');
  assert.equal(prod.ran.length, 0);
  assert.match(prod.notes[0].text, /live is production/);
});

test('/restore on MySQL makes a database that isn\'t there, then loads the file into it with mysql', async () => {
  const file = join(base, 'blog.sql');
  writeFileSync(file, '-- dump');
  const ctx = fakeCtx({ name: 'blog', kind: 'mysql', server: 'db.local:3307', user: 'app' });
  await a.restore(ctx, `${JSON.stringify(file)} --as blog2`);
  assert.match(ctx.confirms[0].title, /Make the database blog2 on blog and restore blog\.sql into it\?/);
  assert.equal(ctx.confirms[0].danger, undefined);
  assert.deepEqual(ctx.sql, ['CREATE DATABASE `blog2`;']);
  assert.match(ctx.ran[0].command, /^mysql --host db\.local --port 3307 --user app blog2 < /);
  assert.deepEqual(ctx.ran[0].env, { MYSQL_PWD: 's3cret' });
  assert.match(ctx.notes.at(-1).text, /Restored blog\.sql into blog2\./);
  // Over the database you're in: asked in red, and nothing made first.
  const over = fakeCtx({ name: 'shop', kind: 'postgres', server: 'db', user: 'app' });
  await a.restore(over, file);
  assert.equal(over.confirms[0].danger, true);
  assert.match(over.confirms[0].title, /Restore blog\.sql over shop on shop\?/);
  assert.deepEqual(over.sql, []);
  assert.match(over.ran[0].command, /--clean --if-exists -d shop /);
  const none = fakeCtx({ name: 'shop', kind: 'postgres', server: 'db', user: 'app' });
  await a.restore(none, join(base, 'nope.dump'));
  assert.match(none.notes[0].text, /^No file /);
});

// ---------------------------------------------------------------------------------------------------

const KEYS = { enter: '\r', esc: '\x1b' };
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
const command = async (app, text) => {
  await type(app.stdin, text);
  app.stdin.write(KEYS.enter);
};

test('the demo backs up to the server\'s folder, restores as a new database, and asks before replacing one', async () => {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, initialConnection: 'demo' })));
  await until(() => frame().includes('Translations'), 'the explorer');
  await command(app, '/backup demo-copy.bak');
  await until(() => /BACKUP DATABASE ClubA \(copy-only\)\n.*⎿ +\d+ ms/.test(frame()), 'the backup');
  // The log has room for a line; /last has it all.
  await command(app, '/last');
  await until(() => frame().includes('BACKUP DATABASE successfully processed'), 'the whole output');
  assert.match(frame(), /The backup is on the server \(DEMO\), not this machine: C:\\Program Files\\Microsoft SQL Server/);
  assert.match(frame(), /\/restore demo-copy\.bak puts it back/);
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('BACKUP DATABASE successfully'), 'the viewer closed');
  await command(app, '/restore demo-copy.bak --as ClubC');
  await until(() => frame().includes('Restore the backup as a new database, ClubC?'), 'the question');
  app.stdin.write('1');
  await until(() => frame().includes('4 databases'), 'ClubC in the Explorer');
  await command(app, '/last');
  await until(() => frame().includes('RESTORE DATABASE successfully processed'), 'the restore');
  assert.match(frame(), /ClubA → C:\\Program Files\\Microsoft SQL Server\\MSSQL16\.MSSQLSERVER\\MSSQL\\DATA\\ClubC\.mdf/);
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('RESTORE DATABASE successfully'), 'the viewer closed');
  // Back where it was.
  assert.match(frame(), /demo\/ClubA/);
  // The database it was of is there: replacing it asks in red, and No leaves it.
  await command(app, '/restore demo-copy.bak');
  await until(() => frame().includes('Replace ClubA on demo with the backup?'), 'the danger question');
  assert.match(frame(), /its other sessions are put out/);
  app.stdin.write('2');
  await until(() => !frame().includes('Replace ClubA'), 'the question answered');
  await command(app, '/restore nope.bak');
  await until(() => frame().includes("Cannot open backup device"), 'the missing file');
  app.unmount();
});

test('production and Azure SQL Database are refused', async () => {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, initialConnection: 'demo-prod' })));
  await until(() => frame().includes('PROD') && frame().includes('Translations'), 'the production connection');
  await command(app, '/backup');
  await until(() => frame().includes('demo-prod is production: /backup and /restore only work'), 'the refusal');
  app.unmount();
});
