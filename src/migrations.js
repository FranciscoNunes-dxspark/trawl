// /migrations: a folder of migration scripts against the history table a migration tool keeps in the
// database: Flyway's flyway_schema_history (V<version>__<description>.sql, with its CRC32
// checksums), EF Core's __EFMigrationsHistory (listed only: its migrations are C#), DbUp's
// SchemaVersions (script names), or Trawl's own trawl_migrations (any .sql, in name order). What's
// applied, what's pending, and what was applied but is missing or changed; and the SQL that records
// a run as the tool would. Pure: actions.js reads the folder and the table, and runs them.

export const TOOLS = {
  flyway: { label: 'Flyway', table: 'flyway_schema_history' },
  ef: { label: 'EF Core', table: '__EFMigrationsHistory' },
  dbup: { label: 'DbUp', table: 'SchemaVersions' },
  plain: { label: 'Trawl', table: 'trawl_migrations' },
};
// Which history wins when a database has several.
const ORDER = ['flyway', 'ef', 'dbup', 'plain'];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC-32 (as zip and Java's java.util.zip.CRC32), unsigned. */
export function crc32(bytes) {
  let c = -1;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Flyway's checksum of a script: CRC-32 over its lines' UTF-8 bytes without their line breaks (it
 * reads them one at a time, as Java's BufferedReader does, and drops a byte order mark), as a signed
 * 32-bit number, which is how flyway_schema_history keeps it.
 */
export function flywayChecksum(text) {
  const body = String(text).replace(/^﻿/, '').replace(/[\r\n]/g, '');
  return crc32(Buffer.from(body, 'utf8')) | 0;
}

/**
 * A Flyway file name: { prefix: 'V' | 'R' | 'U', version (dots between its parts), description }, or
 * null. V1__Create_clubs.sql is version 1, "Create clubs"; V1_2 and V1.2 are both 1.2; R__ are
 * repeatable (no version).
 */
export function parseFlywayName(file) {
  const m = String(file).match(/^([VUR])((?:\d+(?:[._]\d+)*)?)__(.+)\.sql$/i);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  if ((prefix === 'R') !== !m[2]) return null;
  return { prefix, version: m[2] ? m[2].replace(/_/g, '.') : null, description: m[3].replace(/_/g, ' ') };
}

/** Compares Flyway versions part by part as numbers: 1.10 comes after 1.9, and 1.0 is 1. */
export function compareVersions(a, b) {
  const x = String(a).split('.').map((p) => BigInt(p || 0));
  const y = String(b).split('.').map((p) => BigInt(p || 0));
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i] ?? 0n, y[i] ?? 0n];
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const names = Object.values(TOOLS).map((t) => t.table.toLowerCase());

/** The query that finds which of the history tables this database has (marked for the demo). */
export function probeSql(kind) {
  const list = names.map((n) => (kind === 'postgres' || kind === 'mysql' ? sq(n) : `N${sq(n)}`)).join(', ');
  if (kind === 'postgres') return `-- trawl:migrations-probe\nSELECT table_schema AS "schema", table_name AS name FROM information_schema.tables WHERE lower(table_name) IN (${list}) AND table_schema = ANY (current_schemas(false)) ORDER BY (table_schema = current_schema()) DESC, table_schema;`;
  if (kind === 'mysql') return `-- trawl:migrations-probe\nSELECT table_schema AS \`schema\`, table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND LOWER(table_name) IN (${list});`;
  return `-- trawl:migrations-probe\nSELECT s.name AS [schema], t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE LOWER(t.name) IN (${list}) ORDER BY CASE WHEN s.name = SCHEMA_NAME() THEN 0 ELSE 1 END, s.name;`;
}

/**
 * Which tool's history to compare with: the first of Flyway, EF Core, DbUp and Trawl's own whose
 * table the probe found ({ tool, schema, table }), or Trawl's own, not yet made ({ …, missing: true }).
 */
export function pickHistory(found, defaultSchema) {
  for (const tool of ORDER) {
    const hit = found.find((f) => String(f.name).toLowerCase() === TOOLS[tool].table.toLowerCase());
    if (hit) return { tool, schema: hit.schema, table: hit.name };
  }
  return { tool: 'plain', schema: defaultSchema, table: TOOLS.plain.table, missing: true };
}

/** The query that reads the history table, every row (marked for the demo). */
export const historySql = (dialect, h) => `-- trawl:migrations-history\nSELECT * FROM ${dialect.quote(h.schema)}.${dialect.quote(h.table)};`;

/** Trawl's own history table, made only after asking. */
export function createPlainSql(dialect, schema) {
  const t = `${dialect.quote(schema)}.${dialect.quote(TOOLS.plain.table)}`;
  const q = dialect.quote;
  if (dialect.kind === 'postgres') return `-- trawl:migrations-create\nCREATE TABLE ${t} (\n  ${q('script')} varchar(1000) NOT NULL PRIMARY KEY,\n  ${q('checksum')} integer NULL,\n  ${q('applied_by')} varchar(128) NOT NULL DEFAULT current_user,\n  ${q('applied_on')} timestamp NOT NULL DEFAULT now(),\n  ${q('execution_ms')} integer NOT NULL\n);`;
  if (dialect.kind === 'mysql') return `-- trawl:migrations-create\nCREATE TABLE ${t} (\n  ${q('script')} varchar(700) NOT NULL PRIMARY KEY,\n  ${q('checksum')} int NULL,\n  ${q('applied_by')} varchar(128) NOT NULL,\n  ${q('applied_on')} datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  ${q('execution_ms')} int NOT NULL\n);`;
  return `-- trawl:migrations-create\nCREATE TABLE ${t} (\n  ${q('script')} nvarchar(450) NOT NULL PRIMARY KEY,\n  ${q('checksum')} int NULL,\n  ${q('applied_by')} nvarchar(128) NOT NULL DEFAULT SUSER_SNAME(),\n  ${q('applied_on')} datetime2 NOT NULL DEFAULT SYSDATETIME(),\n  ${q('execution_ms')} int NOT NULL\n);`;
}

// Rows with their column names in lower case (Postgres folds them, SQL Server keeps Flyway's).
const lowerKeys = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]));
const truthy = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
const base = (path) => String(path).split('/').at(-1);
const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * The folder against the history: { tool, entries, pending, notes }. `files`: [{ path (relative,
 * with /), text }]; `rows`: the history table's rows (rowsOf). Each entry is { status, script,
 * version, description, detail, file }: status 'applied', 'pending', 'changed' (applied, but the file
 * differs now), 'missing' (applied, no file), 'failed' (Flyway recorded a failure) or 'baseline' (at
 * or below Flyway's baseline). `pending` are the entries to run, in order; `runnable` is false for
 * EF Core, whose pending migrations Trawl only lists.
 */
export function migrationStatus({ tool, files, rows = [] }) {
  const history = rows.map(lowerKeys);
  if (tool === 'flyway') return flyway(files, history);
  if (tool === 'ef') return ef(files, history);
  if (tool === 'dbup') return dbup(files, history);
  return plain(files, history);
}

function flyway(files, history) {
  const notes = [];
  const entries = [];
  const parsed = [];
  const other = [];
  for (const f of files) {
    const p = parseFlywayName(base(f.path));
    if (p) parsed.push({ ...p, file: f, checksum: flywayChecksum(f.text) });
    else other.push(f.path);
  }
  if (other.length) notes.push(`Not Flyway names, so left out: ${other.join(', ')}.`);
  const undo = parsed.filter((p) => p.prefix === 'U');
  if (undo.length) notes.push(`Undo migrations (${undo.map((u) => base(u.file.path)).join(', ')}) are Flyway Teams'; Trawl doesn't run them.`);
  const rowsOk = history.filter((r) => r.version != null && !['SCHEMA', 'DELETE', 'UNDO_SQL'].includes(String(r.type ?? '').toUpperCase()));
  const baseline = rowsOk.filter((r) => String(r.type).toUpperCase() === 'BASELINE').map((r) => String(r.version)).sort(compareVersions).at(-1) ?? null;
  const applied = rowsOk.filter((r) => truthy(r.success) && String(r.type).toUpperCase() !== 'BASELINE');
  const newest = applied.map((r) => String(r.version)).sort(compareVersions).at(-1) ?? null;
  const versioned = parsed.filter((p) => p.prefix === 'V').sort((x, y) => compareVersions(x.version, y.version));
  const seen = new Set();
  for (const p of versioned) {
    const key = versioned.filter((q) => compareVersions(q.version, p.version) === 0);
    if (key.length > 1 && !seen.has(p.version)) notes.push(`Version ${p.version} is in ${key.length} files: ${key.map((q) => q.file.path).join(', ')}. Flyway refuses that.`);
    seen.add(p.version);
    const row = [...rowsOk].reverse().find((r) => compareVersions(String(r.version), p.version) === 0 && String(r.type).toUpperCase() !== 'BASELINE');
    const e = { script: p.file.path, file: p.file, version: p.version, description: p.description, checksum: p.checksum, kind: 'versioned' };
    if (row && !truthy(row.success)) entries.push({ ...e, status: 'failed', detail: `failed on ${dateText(row.installed_on)}: fix it, then flyway repair` });
    else if (row) {
      const was = row.checksum == null ? null : Number(row.checksum);
      entries.push(was != null && was !== p.checksum ? { ...e, status: 'changed', detail: `checksum ${p.checksum} now, ${was} when applied` } : { ...e, status: 'applied', detail: dateText(row.installed_on) });
    } else if (baseline && compareVersions(p.version, baseline) <= 0) entries.push({ ...e, status: 'baseline', detail: `at or below the baseline (${baseline})` });
    else entries.push({ ...e, status: 'pending', detail: newest && compareVersions(p.version, newest) < 0 ? `older than ${newest}, the newest applied (Flyway runs it only with outOfOrder)` : '' });
  }
  for (const r of applied) {
    if (versioned.some((p) => compareVersions(p.version, String(r.version)) === 0)) continue;
    entries.push({ script: r.script, version: String(r.version), description: r.description, status: 'missing', detail: `applied ${dateText(r.installed_on)}, no file` });
  }
  // Repeatable migrations run again whenever their checksum changes.
  for (const p of parsed.filter((q) => q.prefix === 'R').sort((x, y) => byText(x.description, y.description))) {
    const row = history.filter((r) => r.version == null && truthy(r.success) && (String(r.script) === p.file.path || base(r.script) === base(p.file.path))).at(-1);
    const e = { script: p.file.path, file: p.file, version: null, description: p.description, checksum: p.checksum, kind: 'repeatable' };
    if (!row) entries.push({ ...e, status: 'pending', detail: 'repeatable, never run' });
    else if (Number(row.checksum) !== p.checksum) entries.push({ ...e, status: 'pending', detail: 'repeatable, changed since it last ran' });
    else entries.push({ ...e, status: 'applied', detail: `repeatable, ${dateText(row.installed_on)}` });
  }
  entries.sort((x, y) => (x.version == null) - (y.version == null) || (x.version != null ? compareVersions(x.version, y.version) : byText(x.description, y.description)));
  return { tool: 'flyway', entries, pending: entries.filter((e) => e.status === 'pending'), notes, runnable: true };
}

const EF_ID = /^(\d{14}_\w+)$/;

function ef(files, history) {
  const notes = [];
  const ids = new Map();
  for (const f of files) {
    const name = base(f.path);
    const cs = name.match(/^(\d{14}_\w+)\.cs$/);
    if (cs && !/\.Designer\.cs$/i.test(name)) ids.set(cs[1], { from: f.path, kind: 'cs' });
    if (/\.sql$/i.test(name)) {
      // An idempotent script (dotnet ef migrations script --idempotent) names each migration it applies.
      const found = [...f.text.matchAll(/MigrationId["\]`]?\s*=\s*N?'(\d{14}_\w+)'/g)].map((m) => m[1]);
      for (const id of found) if (!ids.has(id)) ids.set(id, { from: f.path, kind: 'sql' });
      const stem = name.replace(/\.sql$/i, '');
      if (!found.length && EF_ID.test(stem) && !ids.has(stem)) ids.set(stem, { from: f.path, kind: 'sql' });
    }
  }
  const applied = new Map(history.map((r) => [String(r.migrationid), r]));
  const entries = [];
  for (const id of [...new Set([...ids.keys(), ...applied.keys()])].sort()) {
    const there = ids.get(id);
    const row = applied.get(id);
    const description = id.replace(/^\d{14}_/, '');
    if (row && there) entries.push({ script: id, version: id.slice(0, 14), description, status: 'applied', detail: `EF Core ${row.productversion ?? ''}`.trim() });
    else if (row) entries.push({ script: id, version: id.slice(0, 14), description, status: 'missing', detail: 'applied, not in the folder' });
    else entries.push({ script: id, version: id.slice(0, 14), description, status: 'pending', detail: `in ${there.from}` });
  }
  notes.push("EF Core's migrations are C#, so Trawl lists them but doesn't run them: dotnet ef database update applies them, or dotnet ef migrations script --idempotent writes a script to /open and run (R).");
  // Listed as pending, but not for Trawl to run.
  return { tool: 'ef', entries, pending: entries.filter((e) => e.status === 'pending'), notes, runnable: false };
}

function dbup(files, history) {
  const sql = files.filter((f) => /\.sql$/i.test(f.path)).sort((x, y) => byText(base(x.path), base(y.path)));
  const applied = history.map((r) => ({ ...r, script: String(r.scriptname ?? '') }));
  // DbUp names an embedded script by its resource name (MyApp.Scripts.Script0001.sql), a file by its name.
  const matches = (script, file) => script.toLowerCase() === file.toLowerCase() || script.toLowerCase().endsWith(`.${file.toLowerCase()}`);
  const entries = [];
  for (const f of sql) {
    const row = applied.find((r) => matches(r.script, base(f.path)));
    entries.push({ script: base(f.path), file: f, version: null, description: '', status: row ? 'applied' : 'pending', detail: row ? dateText(row.applied) : '' });
  }
  for (const r of applied) if (!sql.some((f) => matches(r.script, base(f.path)))) entries.push({ script: r.script, version: null, description: '', status: 'missing', detail: `applied ${dateText(r.applied)}, no file` });
  return { tool: 'dbup', entries, pending: entries.filter((e) => e.status === 'pending'), notes: ["DbUp keeps no checksums, so a script changed since it ran can't be told; scripts run in name order."], runnable: true };
}

function plain(files, history) {
  const sql = files.filter((f) => /\.sql$/i.test(f.path)).sort((x, y) => byText(x.path, y.path));
  const applied = new Map(history.map((r) => [String(r.script), r]));
  const entries = sql.map((f) => {
    const checksum = flywayChecksum(f.text);
    const row = applied.get(f.path);
    const e = { script: f.path, file: f, version: null, description: '', checksum };
    if (!row) return { ...e, status: 'pending', detail: '' };
    const was = row.checksum == null ? null : Number(row.checksum);
    return was != null && was !== checksum ? { ...e, status: 'changed', detail: `checksum ${checksum} now, ${was} when applied` } : { ...e, status: 'applied', detail: dateText(row.applied_on) };
  });
  for (const [script, r] of applied) if (!sql.some((f) => f.path === script)) entries.push({ script, version: null, description: '', status: 'missing', detail: `applied ${dateText(r.applied_on)}, no file` });
  return { tool: 'plain', entries, pending: entries.filter((e) => e.status === 'pending'), notes: [], runnable: true };
}

function dateText(v) {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace('T', ' ');
}

const string = (dialect, s) => (s == null ? 'NULL' : dialect.kind === 'sqlserver' ? `N${sq(s)}` : dialect.kind === 'mysql' ? sq(s).replace(/\\/g, '\\\\') : sq(s));
const userFn = { sqlserver: 'SUSER_SNAME()', postgres: 'current_user', mysql: 'CURRENT_USER()' };
const nowFn = { sqlserver: 'GETDATE()', postgres: 'now()', mysql: 'NOW()' };

/**
 * The INSERT that records `entry` as run, as its tool would: Flyway's row (installed_rank, version,
 * description, type 'SQL', script, checksum, installed_by, execution_time, success), DbUp's
 * (ScriptName, Applied), or Trawl's own. `columns`: the history table's own column names, whose
 * spelling is kept (Postgres folds them to lower case). Marked for the demo.
 */
export function recordSql(dialect, h, entry, { ms, rank = 1, columns = [] }) {
  const table = `${dialect.quote(h.schema)}.${dialect.quote(h.table)}`;
  const name = (want) => columns.find((c) => c.toLowerCase() === want.toLowerCase()) ?? want;
  const insert = (pairs) => `-- trawl:migration-record\nINSERT INTO ${table} (${pairs.map(([c]) => dialect.quote(name(c))).join(', ')})\nVALUES (${pairs.map(([, v]) => v).join(', ')});`;
  const sqlTrue = dialect.kind === 'postgres' ? 'TRUE' : '1';
  if (h.tool === 'flyway') {
    return insert([
      ['installed_rank', String(rank)],
      ['version', string(dialect, entry.version)],
      ['description', string(dialect, entry.description)],
      ['type', string(dialect, 'SQL')],
      ['script', string(dialect, entry.script)],
      ['checksum', String(entry.checksum)],
      ['installed_by', userFn[dialect.kind] ?? userFn.sqlserver],
      ['execution_time', String(Math.round(ms))],
      ['success', sqlTrue],
    ]);
  }
  if (h.tool === 'dbup') return insert([['ScriptName', string(dialect, entry.script)], ['Applied', nowFn[dialect.kind] ?? nowFn.sqlserver]]);
  return insert([
    ['script', string(dialect, entry.script)],
    ['checksum', String(entry.checksum)],
    ...(dialect.kind === 'mysql' ? [['applied_by', userFn.mysql]] : []),
    ['execution_ms', String(Math.round(ms))],
  ]);
}

/** Flyway's next installed_rank: one past the highest there is. */
export const nextRank = (rows) => Math.max(0, ...rows.map(lowerKeys).map((r) => Number(r.installed_rank) || 0)) + 1;

const MARK = { applied: '✓', pending: '•', changed: '~', missing: '?', failed: '✗', baseline: '·' };

/** The status as the viewer shows it: what was compared, a line per migration, and the counts. */
export function statusText(status, { database, folder, history, files }) {
  const t = TOOLS[status.tool];
  const lines = [
    `${t.label} · ${history.missing ? `${history.table} isn't in ${database} yet` : `${history.schema}.${history.table} in ${database}`} · ${files} file${files === 1 ? '' : 's'} in ${folder}`,
    status.tool === 'flyway' || status.tool === 'plain' ? "Checksums: Flyway's CRC-32 over each file's lines" : status.tool === 'ef' ? 'By migration id (EF Core keeps no checksums)' : 'By script name',
    '',
  ];
  const vw = Math.max(0, ...status.entries.map((e) => (e.version ? `V${e.version}`.length : 0)));
  const sw = Math.max(0, ...status.entries.map((e) => String(e.script ?? '').length));
  for (const e of status.entries) {
    const v = status.tool === 'flyway' ? `${(e.version ? `V${e.version}` : 'R').padEnd(vw)}  ` : '';
    lines.push(`  ${MARK[e.status]} ${e.status.padEnd(8)} ${v}${String(e.script ?? '').padEnd(sw)}${e.detail ? `  ${e.detail}` : ''}`);
  }
  if (!status.entries.length) lines.push('  No migrations in the folder or the history.');
  const n = (s) => status.entries.filter((e) => e.status === s).length;
  lines.push('', [`${n('applied')} applied`, `${status.pending.length} pending`, ...(n('changed') ? [`${n('changed')} changed`] : []), ...(n('missing') ? [`${n('missing')} applied without a file`] : []), ...(n('failed') ? [`${n('failed')} failed`] : [])].join(' · '));
  if (status.notes.length) lines.push('', ...status.notes);
  return lines.join('\n');
}
