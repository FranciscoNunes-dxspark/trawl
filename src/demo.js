// An in-memory stand-in for SQL Server, for `trawl --demo` and the tests. It has no SQL engine:
// it knows the catalog queries (/grep's and /uses's too), SELECT [TOP (n)] … FROM a table, simple SELECT lists, USE,
// transactions, WAITFOR DELAY (to try cancelling), RAISERROR/THROW, SHOWPLAN_TEXT and STATISTICS
// PROFILE (made-up plans of a table scan), a few other sessions for the
// Activity view (and KILL for them), and counts what writes would
// touch without changing anything.
import { DbError, runScript } from './db.js';
import { findObject } from './schema.js';
import { mentions } from './references.js';
import { splitStatements, withoutLeadingComments } from './sql.js';

const col = (name, type, extra = {}) => ({ name, type, nullable: false, identity: false, pk: false, ...extra });
const d = (s) => new Date(`${s}T00:00:00Z`);

// ClubB's schema has drifted a little from ClubA's, so a schema diff (/diff) has something to show:
// a Stadiums table, Shirt as smallint, another index, and a view that reads differently.
function makeDatabase(club, { extraLanguage = true, drifted = false } = {}) {
  const clubs = [
    [1, `${club} FC`, 'PT', d('1904-03-14'), true],
    [2, 'Atlético Norte', 'ES', d('1921-09-01'), true],
    [3, 'Union Sud', 'FR', d('1899-05-20'), false],
  ];
  const players = [];
  const names = ['Rui Costa', 'Ana Silva', 'Marta Reis', 'João Pinto', 'Iker Sanz', 'Luc Moreau', 'Inês Sá', 'Paulo Sousa', 'Nuno Gomes', 'Clara Diaz', 'Hugo Leal', 'Sara Lopes'];
  names.forEach((n, i) => players.push([i + 1, (i % 3) + 1, n, ['GK', 'DF', 'MF', 'FW'][i % 4], i % 5 === 0 ? null : 7 + i, i % 4 === 3 ? 12 - i : 0]));
  const matches = [];
  for (let i = 1; i <= 8; i++) matches.push([i, (i % 3) + 1, ((i + 1) % 3) + 1, d(`2026-0${(i % 9) + 1}-1${i % 9}`), i % 4, (i + 2) % 3]);
  const langs = ['en', 'fr-FR', 'es-es', 'pt-br', ...(extraLanguage ? ['it-it'] : [])];
  const words = { en: ['Victory', 'Draw', 'Defeat'], 'fr-FR': ['Victoire', 'Match nul', 'Défaite'], 'es-es': ['Victoria', 'Empate', 'Derrota'], 'pt-br': ['Vitória', 'Empate', 'Derrota'], 'it-it': ['Vittoria', 'Pareggio', 'Sconfitta'] };
  const translations = [];
  for (let k = 0; k < 3; k++) for (const l of langs) translations.push([`GameResult_${k + 1}`, words[l][k], l, 'Enums']);
  return {
    tables: [
      { schema: 'dbo', name: 'Clubs', kind: 'table', columns: [col('Id', 'int', { pk: true, identity: true }), col('Name', 'nvarchar(100)'), col('Country', 'char(2)'), col('Founded', 'date'), col('Active', 'bit')], rows: clubs },
      { schema: 'dbo', name: 'Players', kind: 'table', columns: [col('Id', 'int', { pk: true, identity: true }), col('ClubId', 'int'), col('Name', 'nvarchar(100)'), col('Position', 'char(2)'), col('Shirt', drifted ? 'smallint' : 'tinyint', { nullable: true }), col('Goals', 'int')], rows: players },
      { schema: 'dbo', name: 'Matches', kind: 'table', columns: [col('Id', 'int', { pk: true, identity: true }), col('HomeId', 'int'), col('AwayId', 'int'), col('PlayedOn', 'date'), col('HomeGoals', 'tinyint'), col('AwayGoals', 'tinyint')], rows: matches },
      { schema: 'i18n', name: 'Translations', kind: 'table', columns: [col('ResourceKey', 'nvarchar(200)', { pk: true }), col('Value', 'nvarchar(max)'), col('Culture', 'nvarchar(10)', { pk: true }), col('ResourceSet', 'nvarchar(50)')], rows: translations },
      {
        schema: 'dbo',
        name: 'vTopScorers',
        kind: 'view',
        columns: [col('Name', 'nvarchar(100)'), col('Goals', 'int')],
        rows: players.filter((p) => p[5] > 0).map((p) => [p[2], p[5]]),
        definition: `CREATE VIEW dbo.vTopScorers AS\nSELECT Name, Goals\nFROM dbo.Players\nWHERE Goals > ${drifted ? 1 : 0};`,
      },
      {
        schema: 'dbo',
        name: 'usp_RecalculateTable',
        kind: 'procedure',
        columns: [],
        rows: [],
        params: [col('@Season', 'int'), col('@DryRun', 'bit')],
        definition: 'CREATE PROCEDURE dbo.usp_RecalculateTable @Season int, @DryRun bit = 0 AS\nBEGIN\n  SET NOCOUNT ON;\n  -- The demo has no engine to run this.\n  SELECT c.Name, COUNT(*) AS Played\n  FROM dbo.Matches m\n  JOIN dbo.Clubs c ON c.Id IN (m.HomeId, m.AwayId)\n  WHERE YEAR(m.PlayedOn) = @Season\n  GROUP BY c.Name;\nEND',
      },
      ...(drifted
        ? [{ schema: 'dbo', name: 'Stadiums', kind: 'table', columns: [col('Id', 'int', { pk: true, identity: true }), col('ClubId', 'int'), col('Name', 'nvarchar(100)'), col('Capacity', 'int', { nullable: true })], rows: [[1, 1, 'Estádio Norte', 30000]] }]
        : []),
    ],
    // Triggers aren't in the Explorer; /grep and /uses find them.
    triggers: [
      {
        schema: 'dbo',
        name: 'trg_Players_Goals',
        kind: 'trigger',
        parent: 'Players',
        definition: "CREATE TRIGGER dbo.trg_Players_Goals ON dbo.Players AFTER UPDATE AS\nBEGIN\n  SET NOCOUNT ON;\n  IF UPDATE(Goals) PRINT 'Goals changed: the top scorers are different now.';\nEND",
      },
    ],
    // [name, table, column, referenced table, its column]
    foreignKeys: [
      ['FK_Players_Clubs', 'Players', 'ClubId', 'Clubs', 'Id'],
      ['FK_Matches_Home', 'Matches', 'HomeId', 'Clubs', 'Id'],
      ['FK_Matches_Away', 'Matches', 'AwayId', 'Clubs', 'Id'],
      ...(drifted ? [['FK_Stadiums_Clubs', 'Stadiums', 'ClubId', 'Clubs', 'Id']] : []),
    ],
    // [name, table, unique, columns], the indexes besides the primary keys.
    indexes: [['IX_Players_ClubId', 'Players', false, '[ClubId]'], ...(drifted ? [['IX_Matches_PlayedOn', 'Matches', false, '[PlayedOn] DESC']] : [])],
  };
}

// ClubB is one language short, so comparing the two shows a difference.
const DATABASES = { master: { tables: [], triggers: [], foreignKeys: [], indexes: [] }, ClubA: makeDatabase('Club A'), ClubB: makeDatabase('Club B', { extraLanguage: false, drifted: true }) };

const set = (names, rows, types = []) => ({ columns: names.map((name, i) => ({ name, type: types[i] ?? '' })), rows, truncated: false });

function schemaSets(dbName) {
  const db = DATABASES[dbName];
  const kinds = { table: 'U', view: 'V', procedure: 'P' };
  return [
    set(['db'], [[dbName]]),
    set(['name'], Object.keys(DATABASES).map((n) => [n])),
    set(['schema', 'name', 'type', 'rows'], db.tables.map((t) => [t.schema, t.name, kinds[t.kind], t.kind === 'table' ? t.rows.length : null])),
    set(
      ['schema', 'object', 'name', 'type', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'is_computed', 'pk'],
      db.tables.flatMap((t) =>
        t.columns.map((c) => {
          // Split "nvarchar(100)" back into the catalog's pieces so typeLabel() rebuilds it.
          const [, type, size] = c.type.match(/^(\w+)(?:\((\w+)\))?/);
          const max = size === 'max' ? -1 : type.startsWith('n') && size ? Number(size) * 2 : Number(size ?? 0);
          return [t.schema, t.name, c.name, type, max, 0, 0, c.nullable, c.identity, Boolean(c.computed), c.pk ? 1 : 0];
        }),
      ),
    ),
    set(
      ['name', 'schema', 'object', 'column', 'ref_schema', 'ref_object', 'ref_column'],
      db.foreignKeys.map(([name, table, column, refTable, refColumn]) => [name, 'dbo', table, column, 'dbo', refTable, refColumn]),
    ),
    set(
      ['schema', 'object', 'name', 'type', 'max_length', 'precision', 'scale', 'is_output'],
      db.tables.flatMap((t) => (t.params ?? []).map((p) => [t.schema, t.name, p.name, p.type, 0, 0, 0, false])),
    ),
  ];
}

const TYPES = { table: 'U', view: 'V', procedure: 'P', function: 'FN', trigger: 'TR' };
const modulesOf = (db) => [...db.tables.filter((t) => t.definition), ...db.triggers];
const literal = (sql, re) => sql.match(re)?.[1].replace(/''/g, "'") ?? '';

// /grep (dialects.js grepSql): the definitions with the text in them, ignoring case, as LIKE would.
function grepSet(dbName, sql) {
  const text = literal(sql, /LIKE LOWER\(N'%((?:[^']|'')*)%'\)/).replace(/!(.)/g, '$1');
  const rows = modulesOf(DATABASES[dbName])
    .filter((m) => m.definition.toLowerCase().includes(text))
    .map((m) => [m.schema, m.name, TYPES[m.kind], m.parent ?? null, m.definition]);
  return set(['schema', 'name', 'type', 'parent', 'definition'], rows);
}

// /uses (dialects.js usesSql): what SQL Server's sys.sql_expression_dependencies would say, worked out
// from the names in the demo's definitions, and the triggers on the object.
function usesSet(dbName, sql) {
  const db = DATABASES[dbName];
  const [schema, name] = [literal(sql, /@schema sysname = N'((?:[^']|'')*)'/), literal(sql, /@name sysname = N'((?:[^']|'')*)'/)];
  const all = [...db.tables, ...db.triggers];
  const self = all.find((o) => o.schema === schema && o.name.toLowerCase() === name.toLowerCase());
  const rows = [];
  if (self) {
    for (const m of modulesOf(db)) if (m !== self && mentions(m.definition, self.name)) rows.push(['used_by', m.schema, m.name, TYPES[m.kind], m.parent ?? null, null]);
    for (const o of all) if (o !== self && self.definition && mentions(self.definition, o.name)) rows.push(['uses', o.schema, o.name, TYPES[o.kind], null, null]);
    for (const t of db.triggers) if (t.parent === self.name) rows.push(['trigger', t.schema, t.name, 'TR', t.parent, null]);
  }
  return set(['rel', 'schema', 'name', 'type', 'parent', 'database'], rows);
}

// Other sessions on the demo's "server", for the Activity view: a blocking chain (an idle session
// holding a transaction open, blocking an update, blocking a read), a busy report and an idle one.
// Each demo session has its own copy, so KILL in one test leaves the next one's alone.
function fakeActivity() {
  const t = (s) => new Date(Date.now() - s * 1000);
  return [
    { id: 53, login: 'app_user', host: 'WEB01', program: 'Club website', database: 'ClubA', status: 'sleeping', command: '', wait: null, waitMs: null, elapsedMs: null, blockedBy: 0, openTran: 1, cpuMs: 120, reads: 840, started: t(95), sql: "BEGIN TRAN;\nUPDATE dbo.Clubs SET Active = 0 WHERE Id = 3;" },
    { id: 61, login: 'etl', host: 'BATCH02', program: 'Nightly load', database: 'ClubA', status: 'suspended', command: 'UPDATE', wait: 'LCK_M_U', waitMs: 81_200, elapsedMs: 81_350, blockedBy: 53, openTran: 1, cpuMs: 15, reads: 12, started: t(81), sql: 'UPDATE dbo.Clubs SET Founded = Founded WHERE Country = N\'FR\';' },
    { id: 64, login: 'report_reader', host: 'BI01', program: 'Power BI', database: 'ClubA', status: 'suspended', command: 'SELECT', wait: 'LCK_M_S', waitMs: 42_000, elapsedMs: 42_010, blockedBy: 61, openTran: 0, cpuMs: 2, reads: 4, started: t(42), sql: 'SELECT c.Name, COUNT(*) AS Players\nFROM dbo.Clubs c JOIN dbo.Players p ON p.ClubId = c.Id\nGROUP BY c.Name;' },
    { id: 70, login: 'analyst', host: 'LAPTOP-7', program: 'Microsoft SQL Server Management Studio', database: 'ClubB', status: 'running', command: 'SELECT', wait: 'CXPACKET', waitMs: 3, elapsedMs: 12_500, blockedBy: 0, openTran: 0, cpuMs: 24_800, reads: 1_204_331, started: t(12), sql: 'SELECT * FROM dbo.Matches m CROSS JOIN dbo.Players p;' },
    { id: 72, login: 'app_user', host: 'WEB02', program: 'Club website', database: 'ClubA', status: 'sleeping', command: '', wait: null, waitMs: null, elapsedMs: null, blockedBy: 0, openTran: 0, cpuMs: 4, reads: 30, started: t(600), sql: 'SELECT TOP (10) * FROM dbo.Matches ORDER BY PlayedOn DESC;' },
  ];
}

const ACTIVITY_COLUMNS = ['session_id', 'login_name', 'host_name', 'program_name', 'database_name', 'status', 'command', 'wait_type', 'wait_time', 'elapsed_ms', 'blocking_session_id', 'open_transaction_count', 'cpu_ms', 'logical_reads', 'last_request_start_time', 'sql_text'];

function activitySets(session) {
  const self = { id: session.spid, login: 'demo', host: 'localhost', program: 'Trawl', database: session.database, status: 'running', command: 'SELECT', wait: null, waitMs: 0, elapsedMs: 0, blockedBy: 0, openTran: session.tran, cpuMs: 0, reads: 0, started: new Date(), sql: 'SELECT … FROM sys.dm_exec_sessions …' };
  const rows = [...session.others, self]
    .sort((x, y) => x.id - y.id)
    .map((s) => [s.id, s.login, s.host, s.program, s.database, s.status, s.command || null, s.wait, s.waitMs, s.elapsedMs, s.blockedBy, s.openTran, s.cpuMs, s.reads, s.started, s.sql]);
  return [set(['me'], [[session.spid]]), set(ACTIVITY_COLUMNS, rows)];
}

// SET STATISTICS PROFILE's columns: after each statement, a set with a row for the statement and
// one per operator under it, the rows each produced beside the optimizer's estimate.
const PROFILE_COLUMNS = ['Rows', 'Executes', 'StmtText', 'StmtId', 'NodeId', 'Parent', 'PhysicalOp', 'LogicalOp', 'Argument', 'DefinedValues', 'EstimateRows', 'EstimateIO', 'EstimateCPU', 'AvgRowSize', 'TotalSubtreeCost', 'OutputList', 'Warnings', 'Type', 'Parallel', 'EstimateExecutions'];

// `nodes`: the statement first ({ text, rows, est, type }), then its operators, each under the one before.
function profileSet(nodes) {
  const rows = nodes.map((n, i) => {
    const op = i ? n.text.match(/^\s*\|--([^(]+)/)?.[1].trim() ?? null : null;
    return [n.rows, 1, n.text, 1, i + 1, i, op, op, null, null, n.est, i ? 0.003 : null, i ? 0.0001 : null, i ? 40 : null, 0.0033, null, null, i ? 'PLAN_ROW' : n.type, false, i ? 1 : null];
  });
  return set(PROFILE_COLUMNS, rows, ['BigInt', 'BigInt', 'nvarchar']);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DbError('Cancelled', { cancelled: true }))), { once: true });
  });

// One item of a SELECT list with no FROM: literals, a few functions, otherwise the text itself.
function selectItem(item, session) {
  const m = item.match(/^(.*?)(?:\s+(?:AS\s+)?(\[[^\]]+\]|\w+))?$/is);
  const [expr, alias] = [m[1].trim(), m[2]?.replace(/^\[|\]$/g, '')];
  let value;
  if (/^-?\d+(\.\d+)?$/.test(expr)) value = Number(expr);
  else if (/^N?'(.*)'$/s.test(expr)) value = expr.replace(/^N?'(.*)'$/s, '$1').replace(/''/g, "'");
  else if (/^(GETDATE|SYSDATETIME|GETUTCDATE|SYSUTCDATETIME)\(\)$/i.test(expr)) value = new Date();
  else if (/^DB_NAME\(\)$/i.test(expr)) value = session.database;
  else if (/^@@VERSION$/i.test(expr)) value = 'Trawl demo (no SQL engine)';
  else if (/^NULL$/i.test(expr)) value = null;
  else value = expr;
  return { name: alias ?? '(No column name)', value };
}

function splitList(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let quote = false;
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && !depth && ch === ',') (out.push(cur), (cur = ''));
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

async function runStatement(session, text, line, state, { signal, limit = 500, drain = false }) {
  const db = DATABASES[session.database];
  const fail = (message, number) => {
    throw new DbError(message, { number, line });
  };
  const target = (s) => {
    const m = s.match(/\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+((?:\[[^\]]+\]|[\w#]+)(?:\.(?:\[[^\]]+\]|\w+))?)/i);
    if (!m) return null;
    const t = findObject({ objects: db.tables }, m[1]);
    if (!t) fail(`Invalid object name '${m[1].replace(/[[\]]/g, '')}'.`, 208);
    return t;
  };
  const s = withoutLeadingComments(text).replace(/;\s*$/, '').trim();
  let m;
  // With SHOWPLAN on, a server explains statements instead of running them.
  if ((m = s.match(/^SET\s+SHOWPLAN_TEXT\s+(ON|OFF)$/i))) return void (session.showplan = m[1].toUpperCase() === 'ON');
  if (session.showplan) {
    const t = /\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+((?:\[[^\]]+\]|[\w#]+)(?:\.(?:\[[^\]]+\]|\w+))?)/i.exec(s);
    const obj = t && findObject({ objects: db.tables }, t[1]);
    state.sets.push(set(['StmtText'], [[s]]));
    state.sets.push(set(['StmtText'], [[obj ? `  |--Clustered Index Scan(OBJECT:([${session.database}].[${obj.schema}].[${obj.name}].[PK_${obj.name}]))` : '  |--Constant Scan']]));
    return;
  }
  if ((m = s.match(/^SET\s+STATISTICS\s+(IO|TIME)\s+(ON|OFF)$/i))) return void (session[`stats${m[1].toUpperCase()}`] = m[2].toUpperCase() === 'ON');
  if ((m = s.match(/^SET\s+STATISTICS\s+PROFILE\s+(ON|OFF)$/i))) return void (session.profile = m[1].toUpperCase() === 'ON');
  const index = (t) => `[${session.database}].[${t.schema}].[${t.name}].[PK_${t.name}]`;
  if ((m = s.match(/^KILL\s+(\d+)$/i))) {
    const id = Number(m[1]);
    if (id === session.spid) fail('Cannot use KILL to kill your own process.', 6104);
    const victim = session.others.find((o) => o.id === id);
    if (!victim) fail(`Process ID ${id} is not an active process ID.`, 6106);
    session.others = session.others.filter((o) => o !== victim);
    // Whatever it was blocking can go on.
    for (const o of session.others) if (o.blockedBy === id) Object.assign(o, { blockedBy: 0, status: 'running', wait: null, waitMs: null });
    return;
  }
  if (/^SELECT\s+@@TRANCOUNT\b/i.test(s)) state.sets.push(set(['(No column name)'], [[session.tran]], ['IntN']));
  else if (/^BEGIN\s+TRAN(SACTION)?\b/i.test(s)) session.tran++;
  else if (/^COMMIT\b/i.test(s)) {
    if (!session.tran) fail('The COMMIT TRANSACTION request has no corresponding BEGIN TRANSACTION.', 3902);
    session.tran = 0;
  } else if (/^ROLLBACK\b/i.test(s)) {
    if (!session.tran) fail('The ROLLBACK TRANSACTION request has no corresponding BEGIN TRANSACTION.', 3903);
    session.tran = 0;
  } else if ((m = s.match(/^WAITFOR\s+DELAY\s+'(\d+):(\d+):(\d+)'/i))) await sleep(((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000, signal);
  else if ((m = s.match(/^USE\s+(\[[^\]]+\]|\w+)$/i))) {
    const name = m[1].replace(/^\[|\]$/g, '');
    if (!DATABASES[name]) fail(`Database '${name}' does not exist. Make sure that the name is entered correctly.`, 911);
    session.database = name;
  } else if ((m = s.match(/^(?:RAISERROR\s*\(\s*N?'((?:[^']|'')*)'|THROW\s+\d+\s*,\s*N?'((?:[^']|'')*)')/i))) fail((m[1] ?? m[2]).replace(/''/g, "'"), 50000);
  else if (/^PRINT\s+N?'/i.test(s)) state.messages.push(s.replace(/^PRINT\s+N?'(.*)'$/is, '$1'));
  else if (/^(SELECT|WITH)\b/i.test(s)) {
    const t = target(s);
    if (t && /^SELECT\s+COUNT(_BIG)?\s*\(\s*\*\s*\)/i.test(s)) {
      // Like its writes, the demo takes a WHERE to match one row.
      state.sets.push(set(['(No column name)'], [[/\bWHERE\b/i.test(s) ? 1 : t.rows.length]], ['IntN']));
    } else if (t) {
      const top = s.match(/\bTOP\s*\(?\s*(\d+)/i);
      const rows = t.rows.slice(0, top ? Number(top[1]) : undefined);
      const out = set(t.columns.map((c) => c.name), rows.slice(0, limit), t.columns.map((c) => c.type));
      if (rows.length > limit) (out.truncated = true), (state.stopped = !drain);
      state.sets.push(out);
      // The demo has no statistics: it guesses one row for any WHERE, so an actual plan shows a
      // badly wrong estimate, as stale statistics would.
      if (session.profile) {
        const where = s.match(/\bWHERE\s+([\s\S]*?)(?:\bORDER\s+BY\b|$)/i)?.[1].trim();
        const est = where ? 1 : rows.length;
        const scan = `  |--Clustered Index Scan(OBJECT:(${index(t)})${where ? `, WHERE:(${where})` : ''})`;
        state.sets.push(profileSet([{ text: s, rows: rows.length, est, type: 'SELECT' }, ...(top ? [{ text: `  |--Top(TOP EXPRESSION:((${top[1]})))`, rows: rows.length, est }] : []), { text: top ? `     ${scan.trim()}` : scan, rows: rows.length, est }]));
      }
      if (session.statsIO) state.messages.push(`Table '${t.name}'. Scan count 1, logical reads ${Math.ceil(t.rows.length / 8) + 1}, physical reads 0, page server reads 0, read-ahead reads 0.`);
      if (session.statsTIME) state.messages.push(' SQL Server Execution Times:\n   CPU time = 0 ms,  elapsed time = 1 ms.');
      if (!/^SELECT\s+(TOP\s*\(?\s*\d+\s*\)?\s*)?\*\s+FROM\s+\S+$/i.test(s)) state.messages.push('The demo has no SQL engine: this shows the table as it is, without WHERE, JOIN or ORDER BY.');
    } else {
      const items = splitList(s.replace(/^SELECT\s+/i, '')).map((x) => selectItem(x, session));
      state.sets.push(set(items.map((x) => x.name), [items.map((x) => x.value)]));
    }
  } else if ((m = s.match(/^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i))) {
    const t = target(s);
    const all = m[1].toUpperCase() === 'TRUNCATE' || (/^(UPDATE|DELETE)$/i.test(m[1]) && !/\bWHERE\b/i.test(s));
    const n = all ? (t?.rows.length ?? 0) : m[1].toUpperCase() === 'INSERT' ? Math.max(1, (s.match(/\)\s*,\s*\(/g) ?? []).length + 1) : 1;
    if (m[1].toUpperCase() !== 'TRUNCATE') state.messages.push(`${n} row${n === 1 ? '' : 's'} affected`);
    const verb = { INSERT: 'Insert', UPDATE: 'Update', DELETE: 'Delete', MERGE: 'Merge' }[m[1].toUpperCase()];
    if (session.profile && verb && t) state.sets.push(profileSet([{ text: s, rows: n, est: n, type: m[1].toUpperCase() }, { text: `  |--Clustered Index ${verb}(OBJECT:(${index(t)}))`, rows: n, est: n }]));
    state.messages.push('(Demo: nothing was changed.)');
  } else if (/^(CREATE|ALTER|DROP|EXEC|EXECUTE|DECLARE|SET|GRANT|REVOKE|DENY|DBCC)\b/i.test(s)) {
    if (/^(CREATE|ALTER|DROP)\b/i.test(s)) state.messages.push('Commands completed successfully. (Demo: nothing was changed.)');
  } else {
    fail(`Incorrect syntax near '${s.split(/\s+/)[0]}'.`, 102);
  }
}

/** A demo session with the same interface as a real one (see db.js connect). */
export function demoSession(conn, { database } = {}) {
  const name = database ?? conn.database ?? 'ClubA';
  if (!DATABASES[name]) throw new DbError(`Cannot open database "${name}" requested by the login. The login failed.`, { number: 4060 });
  const session = {
    conn,
    database: name,
    closed: false,
    onEnd: null,
    tran: 0,
    spid: 52,
    others: fakeActivity(),
    run: (script, opts = {}) =>
      runScript(
        session,
        script,
        async (batch, line, state) => {
          if (batch.startsWith('-- trawl:schema')) return void state.sets.push(...schemaSets(session.database));
          if (batch.startsWith('-- trawl:diff')) {
            const db = DATABASES[session.database];
            state.sets.push(set(['schema', 'name', 'definition'], db.tables.filter((t) => t.definition).map((t) => [t.schema, t.name, t.definition])));
            return void state.sets.push(set(['schema', 'object', 'name', 'is_unique', 'type_desc', 'filter_definition', 'columns', 'included'], db.indexes.map(([name, table, unique, columns]) => ['dbo', table, name, unique, 'NONCLUSTERED', null, columns, null])));
          }
          if (batch.startsWith('-- trawl:activity')) return void state.sets.push(...activitySets(session));
          if (batch.startsWith('-- trawl:grep')) return void state.sets.push(grepSet(session.database, batch));
          if (batch.startsWith('-- trawl:uses')) return void state.sets.push(usesSet(session.database, batch));
          if (batch.startsWith('-- trawl:definition')) {
            const name = batch.match(/OBJECT_ID\(N'(.*)'\)\)/)[1].replace(/''/g, "'");
            const db = DATABASES[session.database];
            const t = findObject({ objects: [...db.tables, ...db.triggers] }, name);
            return void state.sets.push(set(['definition'], [[t?.definition ?? null]]));
          }
          // Saved edits (edit.js) come as one TRY/CATCH batch, which the demo has no engine for: it
          // counts the rows, as for other writes. Its own transaction opens and closes inside it.
          const edit = batch.indexOf('-- trawl:edit');
          if (edit >= 0) {
            if (/^\s*BEGIN\s+TRAN/i.test(batch.slice(0, edit))) session.tran++;
            for (const _ of batch.matchAll(/^\s*(UPDATE|DELETE|INSERT)\b/gim)) state.messages.push('1 row affected');
            return void state.messages.push('(Demo: nothing was changed.)');
          }
          for (const st of splitStatements(batch)) {
            await runStatement(session, st.text, line + st.line - 1, state, opts);
            if (state.stopped) return;
          }
        },
        opts,
      ),
    tranCount: async () => session.tran,
    close() {
      session.closed = true;
      session.onEnd?.();
    },
  };
  return session;
}
