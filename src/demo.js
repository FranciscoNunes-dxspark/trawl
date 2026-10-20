// An in-memory stand-in for SQL Server, for `trawl --demo` and the tests. It has no SQL engine:
// it knows the catalog query, SELECT [TOP (n)] … FROM a table, simple SELECT lists, USE,
// transactions, WAITFOR DELAY (to try cancelling), RAISERROR/THROW, and counts what writes would
// touch without changing anything.
import { DbError, runScript } from './db.js';
import { findObject } from './schema.js';
import { splitStatements, withoutLeadingComments } from './sql.js';

const col = (name, type, extra = {}) => ({ name, type, nullable: false, identity: false, pk: false, ...extra });
const d = (s) => new Date(`${s}T00:00:00Z`);

function makeDatabase(club, { extraLanguage = true } = {}) {
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
      { schema: 'dbo', name: 'Players', kind: 'table', columns: [col('Id', 'int', { pk: true, identity: true }), col('ClubId', 'int'), col('Name', 'nvarchar(100)'), col('Position', 'char(2)'), col('Shirt', 'tinyint', { nullable: true }), col('Goals', 'int')], rows: players },
      { schema: 'dbo', name: 'Matches', kind: 'table', columns: [col('Id', 'int', { pk: true, identity: true }), col('HomeId', 'int'), col('AwayId', 'int'), col('PlayedOn', 'date'), col('HomeGoals', 'tinyint'), col('AwayGoals', 'tinyint')], rows: matches },
      { schema: 'i18n', name: 'Translations', kind: 'table', columns: [col('ResourceKey', 'nvarchar(200)', { pk: true }), col('Value', 'nvarchar(max)'), col('Culture', 'nvarchar(10)', { pk: true }), col('ResourceSet', 'nvarchar(50)')], rows: translations },
      {
        schema: 'dbo',
        name: 'vTopScorers',
        kind: 'view',
        columns: [col('Name', 'nvarchar(100)'), col('Goals', 'int')],
        rows: players.filter((p) => p[5] > 0).map((p) => [p[2], p[5]]),
        definition: 'CREATE VIEW dbo.vTopScorers AS\nSELECT Name, Goals\nFROM dbo.Players\nWHERE Goals > 0;',
      },
      {
        schema: 'dbo',
        name: 'usp_RecalculateTable',
        kind: 'procedure',
        columns: [],
        rows: [],
        params: [col('@Season', 'int'), col('@DryRun', 'bit')],
        definition: 'CREATE PROCEDURE dbo.usp_RecalculateTable @Season int, @DryRun bit = 0 AS\nBEGIN\n  SET NOCOUNT ON;\n  -- The demo has no body to run.\n  SELECT @Season AS Season, @DryRun AS DryRun;\nEND',
      },
    ],
    // [name, table, column, referenced table, its column]
    foreignKeys: [
      ['FK_Players_Clubs', 'Players', 'ClubId', 'Clubs', 'Id'],
      ['FK_Matches_Home', 'Matches', 'HomeId', 'Clubs', 'Id'],
      ['FK_Matches_Away', 'Matches', 'AwayId', 'Clubs', 'Id'],
    ],
  };
}

// ClubB is one language short, so comparing the two shows a difference.
const DATABASES = { master: { tables: [], foreignKeys: [] }, ClubA: makeDatabase('Club A'), ClubB: makeDatabase('Club B', { extraLanguage: false }) };

const set = (names, rows, types = []) => ({ columns: names.map((name, i) => ({ name, type: types[i] ?? '' })), rows, truncated: false });

function schemaSets(dbName) {
  const db = DATABASES[dbName];
  const kinds = { table: 'U', view: 'V', procedure: 'P' };
  return [
    set(['db'], [[dbName]]),
    set(['name'], Object.keys(DATABASES).map((n) => [n])),
    set(['schema', 'name', 'type', 'rows'], db.tables.map((t) => [t.schema, t.name, kinds[t.kind], t.kind === 'table' ? t.rows.length : null])),
    set(
      ['schema', 'object', 'name', 'type', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'pk'],
      db.tables.flatMap((t) =>
        t.columns.map((c) => {
          // Split "nvarchar(100)" back into the catalog's pieces so typeLabel() rebuilds it.
          const [, type, size] = c.type.match(/^(\w+)(?:\((\w+)\))?/);
          const max = size === 'max' ? -1 : type.startsWith('n') && size ? Number(size) * 2 : Number(size ?? 0);
          return [t.schema, t.name, c.name, type, max, 0, 0, c.nullable, c.identity, c.pk ? 1 : 0];
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

async function runStatement(session, text, line, state, { signal, limit = 500 }) {
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
      if (rows.length > limit) (out.truncated = true), (state.stopped = true);
      state.sets.push(out);
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
    run: (script, opts = {}) =>
      runScript(
        session,
        script,
        async (batch, line, state) => {
          if (batch.startsWith('-- trawl:schema')) return void state.sets.push(...schemaSets(session.database));
          if (batch.startsWith('-- trawl:definition')) {
            const name = batch.match(/OBJECT_ID\(N'(.*)'\)\)/)[1].replace(/''/g, "'");
            const t = findObject({ objects: DATABASES[session.database].tables }, name);
            return void state.sets.push(set(['definition'], [[t?.definition ?? null]]));
          }
          // Saved edits (edit.js) come as one TRY/CATCH batch, which the demo has no engine for: it
          // counts the rows, as for other writes. Its own transaction opens and closes inside it.
          const edit = batch.indexOf('-- trawl:edit');
          if (edit >= 0) {
            if (/^\s*BEGIN\s+TRAN/i.test(batch.slice(0, edit))) session.tran++;
            for (const _ of batch.matchAll(/^\s*(UPDATE|DELETE)\b/gim)) state.messages.push('1 row affected');
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
