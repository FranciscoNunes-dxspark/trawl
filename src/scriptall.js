// /script-all: every object of a database in a file of its own, so the schema can live in git:
// <schema>/Tables/<name>.sql (CREATE TABLE with its keys, defaults, checks and indexes), and
// Views/, Procedures/, Functions/ and Triggers/ from their definitions. The same database always
// gives the same bytes (a stable order, LF line ends, a newline at the end, no dates), so scripting
// it again only changes the files of objects that changed. Pure: actions.js reads the catalog and
// writes the files.
import { createTableScript, objectName, rowsOf } from './schema.js';

// The marker comment lets the demo driver recognise this batch.
const INDEX_COLUMNS = (included) => `STUFF((SELECT ', ' + QUOTENAME(c.name)${included ? '' : " + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END"}
    FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = ${included ? 1 : 0}
    ORDER BY ${included ? 'c.name' : 'ic.key_ordinal'} FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '')`;

/**
 * What the schema query leaves out of a table, per kind of server, as five result sets of the same
 * shape: defaults, checks, indexes (the primary key's and unique constraints' too, flagged), identity
 * seeds, and computed columns. Postgres's has a sixth, its foreign keys as the server words them
 * (with ON DELETE, NOT VALID and so on). MySQL's tables come from SHOW CREATE TABLE instead, so its
 * query only reads the indexes (which /generate keeps unique).
 */
export const EXTRAS_SQL = {
  sqlserver: `-- trawl:script-extras
SELECT s.name AS [schema], o.name AS [object], c.name AS [column], d.name, d.definition
FROM sys.default_constraints d
JOIN sys.objects o ON o.object_id = d.parent_object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.columns c ON c.object_id = d.parent_object_id AND c.column_id = d.parent_column_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, c.column_id;
SELECT s.name AS [schema], o.name AS [object], k.name, k.definition
FROM sys.check_constraints k
JOIN sys.objects o ON o.object_id = k.parent_object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, k.name;
SELECT s.name AS [schema], o.name AS [object], i.name, i.is_unique, i.is_unique_constraint, i.is_primary_key, i.type_desc, i.filter_definition,
  ${INDEX_COLUMNS(false)} AS columns,
  ${INDEX_COLUMNS(true)} AS included,
  CAST(NULL AS nvarchar(max)) AS definition
FROM sys.indexes i
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0 AND i.type > 0 AND i.is_hypothetical = 0
ORDER BY s.name, o.name, i.name;
SELECT s.name AS [schema], o.name AS [object], c.name AS [column], CAST(c.seed_value AS nvarchar(40)) AS seed, CAST(c.increment_value AS nvarchar(40)) AS increment
FROM sys.identity_columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, c.column_id;
SELECT s.name AS [schema], o.name AS [object], c.name AS [column], c.definition, c.is_persisted
FROM sys.computed_columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, c.column_id;`,
  postgres: `-- trawl:script-extras
SELECT n.nspname AS "schema", c.relname AS "object", a.attname AS "column", NULL::text AS name, pg_get_expr(d.adbin, d.adrelid) AS definition
FROM pg_attrdef d
JOIN pg_class c ON c.oid = d.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
WHERE c.relkind IN ('r', 'p') AND a.attgenerated = '' AND a.attidentity = '' AND pg_get_expr(d.adbin, d.adrelid) NOT LIKE 'nextval(%'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 1, 2, a.attnum;
SELECT n.nspname AS "schema", c.relname AS "object", con.conname AS name, pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE con.contype = 'c' AND c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 1, 2, 3;
SELECT n.nspname AS "schema", c.relname AS "object", COALESCE(con.conname, i.relname) AS name, x.indisunique AS is_unique,
  COALESCE(con.contype = 'u', false) AS is_unique_constraint, x.indisprimary AS is_primary_key, NULL::text AS type_desc, NULL::text AS filter_definition,
  (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord) FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum WHERE k.ord <= x.indnkeyatts) AS columns,
  NULL::text AS included, pg_get_indexdef(x.indexrelid) AS definition
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_class c ON c.oid = x.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_constraint con ON con.conindid = x.indexrelid AND con.conrelid = x.indrelid AND con.contype IN ('p', 'u')
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 1, 2, 3;
SELECT n.nspname AS "schema", c.relname AS "object", a.attname AS "column", NULL::text AS seed, NULL::text AS increment,
  CASE a.attidentity WHEN 'a' THEN 'GENERATED ALWAYS AS IDENTITY' ELSE 'GENERATED BY DEFAULT AS IDENTITY' END AS definition
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.attidentity <> '' AND NOT a.attisdropped AND c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 1, 2, a.attnum;
SELECT n.nspname AS "schema", c.relname AS "object", a.attname AS "column", pg_get_expr(d.adbin, d.adrelid) AS definition, true AS is_persisted
FROM pg_attrdef d
JOIN pg_class c ON c.oid = d.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
WHERE a.attgenerated = 's' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 1, 2, a.attnum;
SELECT n.nspname AS "schema", c.relname AS "object", con.conname AS name, pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE con.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 1, 2, 3;`,
  mysql: `-- trawl:script-extras
SELECT NULL AS \`schema\`, NULL AS \`object\`, NULL AS \`column\`, NULL AS name, NULL AS definition FROM DUAL WHERE 1 = 0;
SELECT NULL AS \`schema\`, NULL AS \`object\`, NULL AS name, NULL AS definition FROM DUAL WHERE 1 = 0;
SELECT table_schema AS \`schema\`, table_name AS \`object\`, index_name AS name, MIN(non_unique) = 0 AS is_unique, 0 AS is_unique_constraint,
  index_name = 'PRIMARY' AS is_primary_key, NULL AS type_desc, NULL AS filter_definition,
  GROUP_CONCAT(CONCAT('\`', REPLACE(column_name, '\`', '\`\`'), '\`') ORDER BY seq_in_index SEPARATOR ', ') AS columns, NULL AS included, NULL AS definition
FROM information_schema.statistics WHERE table_schema = DATABASE()
GROUP BY table_schema, table_name, index_name
ORDER BY 2, 3;
SELECT NULL AS \`schema\`, NULL AS \`object\`, NULL AS \`column\`, NULL AS seed, NULL AS increment FROM DUAL WHERE 1 = 0;
SELECT NULL AS \`schema\`, NULL AS \`object\`, NULL AS \`column\`, NULL AS definition, NULL AS is_persisted FROM DUAL WHERE 1 = 0;`,
};

const lower = (s) => String(s).toLowerCase();
const tableKey = (r) => lower(`${r.schema}.${r.object}`);
const group = (rows, keyOf = tableKey) => {
  const out = new Map();
  for (const r of rows) (out.get(keyOf(r)) ?? out.set(keyOf(r), []).get(keyOf(r))).push(r);
  return out;
};

/** The names in a quoted column list ("[a], [b] DESC", "\"a\", b", "`a`"), unquoted. */
export function columnNames(list) {
  return String(list ?? '')
    .split(/,\s*/)
    .map((s) => s.trim().replace(/\s+(ASC|DESC)$/i, ''))
    .filter(Boolean)
    .map((s) => s.replace(/^\[(.*)\]$/s, (_, n) => n.replace(/]]/g, ']')).replace(/^"(.*)"$/s, (_, n) => n.replace(/""/g, '"')).replace(/^`(.*)`$/s, (_, n) => n.replace(/``/g, '`')));
}

/**
 * EXTRAS_SQL's sets, by table ("schema.name" in lower case): { defaults, checks, indexes, identity,
 * computed, foreignKeys }, each a Map of that table's rows (rowsOf's objects).
 */
export function buildTableExtras(sets) {
  const [defaults, checks, indexes, identity, computed, foreignKeys] = sets.map(rowsOf);
  const norm = (rows) => (rows ?? []).map((r) => ({ ...r, is_unique: Boolean(Number(r.is_unique ?? 0) || r.is_unique === true), is_unique_constraint: Boolean(Number(r.is_unique_constraint ?? 0) || r.is_unique_constraint === true), is_primary_key: Boolean(Number(r.is_primary_key ?? 0) || r.is_primary_key === true) }));
  return { defaults: group(defaults ?? []), checks: group(checks ?? []), indexes: group(norm(indexes)), identity: group(identity ?? []), computed: group(computed ?? []), foreignKeys: group(foreignKeys ?? []) };
}

/** The columns of `table` that must hold a different value in each row, besides its primary key: those of its unique constraints and indexes. */
export function uniqueColumns(extras, table) {
  const rows = extras?.indexes.get(lower(objectName(table))) ?? [];
  return [...new Set(rows.filter((r) => r.is_unique && !r.is_primary_key).flatMap((r) => columnNames(r.columns)))];
}

// SQL Server's index types Trawl writes out (a columnstore or spatial index is left as a comment).
const indexSql = (r, quote, table) => {
  if (r.definition) return `${String(r.definition).trim().replace(/;?$/, ';')}`;
  const type = String(r.type_desc ?? '').toUpperCase();
  if (type && !/^(CLUSTERED|NONCLUSTERED)$/.test(type)) return `-- ${quote(r.name)}: a ${type.toLowerCase().replace(/_/g, ' ')} index, which Trawl doesn't script.`;
  return `CREATE ${r.is_unique ? 'UNIQUE ' : ''}${type ? `${type} ` : ''}INDEX ${quote(r.name)} ON ${table} (${r.columns})${r.included ? ` INCLUDE (${r.included})` : ''}${r.filter_definition ? ` WHERE ${r.filter_definition}` : ''};`;
};

/** The CREATE TABLE file for table `o`, with what `extras` (buildTableExtras) has on it. */
export function tableFile(o, schema, extras, dialect) {
  const { quote } = dialect;
  const k = lower(objectName(o));
  const table = `${quote(o.schema)}.${quote(o.name)}`;
  const byColumn = (rows, value) => new Map((rows ?? []).map((r) => [lower(r.column), value(r)]));
  const indexes = extras?.indexes.get(k) ?? [];
  const pk = indexes.find((r) => r.is_primary_key);
  const sqlserver = dialect.kind === 'sqlserver';
  const checkText = (d) => (/^\s*CHECK\b/i.test(d) ? String(d).trim() : `CHECK ${String(d).trim()}`);
  const constraints = [
    ...indexes.filter((r) => r.is_unique_constraint).map((r) => `CONSTRAINT ${quote(r.name)} UNIQUE ${sqlserver && r.type_desc ? `${String(r.type_desc).toUpperCase()} ` : ''}(${r.columns})`),
    ...(extras?.checks.get(k) ?? []).map((r) => `CONSTRAINT ${quote(r.name)} ${checkText(r.definition)}`),
  ];
  const typeOf = (name) => o.columns.find((c) => lower(c.name) === lower(name))?.type ?? '';
  const ex = {
    defaults: byColumn(extras?.defaults.get(k), (r) => ({ name: r.name ?? null, definition: String(r.definition).trim() })),
    // Postgres says which kind of identity (ALWAYS or BY DEFAULT); a serial column is the latter.
    identity: byColumn(extras?.identity.get(k), (r) => (sqlserver ? `IDENTITY(${r.seed ?? 1},${r.increment ?? 1})` : (r.definition ?? dialect.identity))),
    computed: byColumn(extras?.computed.get(k), (r) => (sqlserver ? `AS ${String(r.definition).trim()}${Number(r.is_persisted) || r.is_persisted === true ? ' PERSISTED' : ''}` : `${typeOf(r.column)} GENERATED ALWAYS AS (${String(r.definition).trim()}) STORED`)),
    primaryKey: pk ? { name: pk.name, columns: pk.columns, type: sqlserver ? (String(pk.type_desc ?? '').toUpperCase() || null) : null } : null,
    constraints,
    foreignKeys: new Map((extras?.foreignKeys?.get(k) ?? []).map((r) => [lower(r.name), String(r.definition).trim()])),
    after: indexes.filter((r) => !r.is_primary_key && !r.is_unique_constraint).map((r) => indexSql(r, quote, table)),
  };
  return createTableScript(o, schema, { quote, identity: dialect.identity, extras: ex });
}

export const KIND_DIRS = { table: 'Tables', view: 'Views', procedure: 'Procedures', function: 'Functions', trigger: 'Triggers' };
const TYPE_KINDS = { U: 'table', V: 'view', P: 'procedure', FN: 'function', IF: 'function', TF: 'function', TR: 'trigger' };

/** A name as a file name on any system: what Windows can't have in one (and %) as %XX. */
export function fileName(name) {
  let s = String(name).replace(/[%<>:"/\\|?*\x00-\x1f]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  // Windows drops a trailing dot or space, and keeps names like CON for devices.
  s = s.replace(/[. ]$/, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `${s}_`;
  return s || '_';
}

/** The path of an object's file under the folder, with / between the parts. */
export const filePath = (schemaName, kind, name) => `${fileName(schemaName)}/${KIND_DIRS[kind]}/${fileName(name)}.sql`;

/** Whether a path under the folder (with /) is one /script-all writes: <schema>/<Tables|Views|…>/<name>.sql. */
export const inLayout = (path) => new RegExp(`^[^/]+/(${Object.values(KIND_DIRS).join('|')})/[^/]+\\.sql$`, 'i').test(path);

// A definition as a file: LF line ends, no blank lines before it, one newline after it.
export const fileText = (text) => `${String(text).replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd()}\n`;

/**
 * The files for a database: { files: [{ path, text, kind, name }] in path order, skipped: [{ name,
 * path, quiet }] of the objects whose definition couldn't be read (quiet: Postgres's extensions'
 * views and functions, which aren't the database's own) }. `modules` are grepSql('')'s rows (schema, name, type,
 * parent, definition: every view, routine and trigger); `creates` (MySQL) maps createKey(kind,
 * schema, name) to the server's own CREATE text, tables' included.
 */
export function scriptFiles({ schema, extras, modules = [], dialect, creates = null }) {
  const byPath = new Map();
  // Postgres's definitions (a function's, a trigger's) end without a semicolon: one is added, so a
  // file of overloads, or the files run one after another, are statements that split where they should.
  const ended = (text) => (dialect.kind === 'postgres' && !/;\s*$/.test(text) ? `${String(text).trimEnd()};` : text);
  const add = (s, kind, name, text) => {
    const path = filePath(s, kind, name);
    const k = lower(path);
    if (!byPath.has(k)) byPath.set(k, { path, kind, name: `${s}.${name}`, parts: [] });
    byPath.get(k).parts.push(fileText(kind === 'table' ? text : ended(text)));
  };
  const skipped = [];
  const skip = (s, kind, name, quiet = false) => skipped.push({ name: `${s}.${name}`, path: filePath(s, kind, name), ...(quiet ? { quiet } : {}) });
  const defs = new Map();
  for (const m of modules) {
    const kind = TYPE_KINDS[String(m.type).trim().toUpperCase()];
    if (!kind || kind === 'table') continue;
    const k = lower(`${kind}|${m.schema}.${m.name}`);
    if (!defs.has(k)) defs.set(k, { schema: m.schema, name: m.name, kind, texts: [] });
    if (m.definition != null) defs.get(k).texts.push(String(m.definition));
  }
  const own = (kind, s, name) => creates?.get(createKey(kind, s, name));
  for (const o of schema.objects) {
    if (o.kind === 'table') {
      const text = creates ? own('table', o.schema, o.name) : tableFile(o, schema, extras, dialect);
      if (text) add(o.schema, 'table', o.name, text);
      else skip(o.schema, 'table', o.name);
    } else if (KIND_DIRS[o.kind]) {
      const d = defs.get(lower(`${o.kind}|${o.schema}.${o.name}`));
      const texts = creates ? [own(o.kind, o.schema, o.name)].filter(Boolean) : (d?.texts ?? []);
      // Postgres's catalog lists extensions' views and functions, whose definitions grepSql leaves out:
      // not ours to script (and Postgres always gives the rest).
      if (!texts.length) skip(o.schema, o.kind, o.name, dialect.kind === 'postgres');
      // Overloads (Postgres) share a file, in a stable order.
      for (const t of [...texts].sort()) add(o.schema, o.kind, o.name, t);
    }
  }
  // Triggers aren't in the schema's objects: they come from the definitions alone.
  for (const d of defs.values()) {
    if (d.kind !== 'trigger') continue;
    const texts = creates ? [own('trigger', d.schema, d.name)].filter(Boolean) : d.texts;
    if (!texts.length) skip(d.schema, 'trigger', d.name);
    for (const t of [...texts].sort()) add(d.schema, 'trigger', d.name, t);
  }
  const files = [...byPath.values()].map((f) => ({ path: f.path, kind: f.kind, name: f.name, text: f.parts.join('\n') })).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { files, skipped: skipped.sort((x, y) => (x.path < y.path ? -1 : 1)) };
}

/** The key of an object in scriptFiles' `creates`. */
export const createKey = (kind, schema, name) => lower(`${kind}|${schema}.${name}`);

/** The objects of a database (tables, views, routines, and the triggers among `modules`) as { kind, schema, name }. */
export function scriptedObjects(schema, modules = []) {
  const triggers = modules.filter((m) => String(m.type).trim().toUpperCase() === 'TR').map((m) => ({ kind: 'trigger', schema: m.schema, name: m.name }));
  return [...schema.objects.filter((o) => KIND_DIRS[o.kind]).map((o) => ({ kind: o.kind, schema: o.schema, name: o.name })), ...triggers];
}

/** MySQL's SHOW CREATE TABLE without the AUTO_INCREMENT=n that changes with every insert. */
export const withoutAutoIncrement = (text) => String(text).replace(/\s+AUTO_INCREMENT=\d+\b/gi, '');

/**
 * What writing `files` over the folder's `existing` files (a Map of path → text, the layout's only)
 * does: { written: [{ path, text, isNew }], unchanged: [path], stale: [path] }. Text that differs only
 * in line ends (git's autocrlf) counts as unchanged. Stale files are the layout's files no object has
 * now (`keep`: the paths of objects that are there but couldn't be scripted); a name that only
 * differs in case isn't one (it's the same file on Windows and macOS).
 */
export function planFiles(files, existing, { keep = [] } = {}) {
  const have = new Map([...existing].map(([p, text]) => [lower(p), { path: p, text }]));
  const written = [];
  const unchanged = [];
  for (const f of files) {
    const old = have.get(lower(f.path));
    if (old && String(old.text).replace(/\r\n/g, '\n') === f.text) unchanged.push(f.path);
    else written.push({ path: f.path, text: f.text, isNew: !old });
  }
  const wanted = new Set([...files.map((f) => f.path), ...keep].map(lower));
  const stale = [...existing.keys()].filter((p) => inLayout(p) && !wanted.has(lower(p))).sort();
  return { written, unchanged, stale };
}

const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** "3 written (1 new) · 12 unchanged · 1 removed": the plan's one line. */
export function summaryLine(plan, removed = 0) {
  const fresh = plan.written.filter((w) => w.isNew).length;
  return [`${plan.written.length} written${fresh ? ` (${fresh} new)` : ''}`, `${plan.unchanged.length} unchanged`, ...(removed ? [`${removed} removed`] : [])].join(' · ');
}

/** The report the viewer shows: the line, then the files written (+ new, ~ changed), removed and kept. */
export function summaryText(plan, { database, folder, removed = [], kept = [], skipped = [], note = null }) {
  const lines = [`${database} → ${folder}`, summaryLine(plan, removed.length), ''];
  if (note) lines.push(note, '');
  if (plan.written.length) lines.push('Written', ...plan.written.map((w) => `  ${w.isNew ? '+' : '~'} ${w.path}`), '');
  if (removed.length) lines.push('Removed (their objects are gone)', ...removed.map((p) => `  - ${p}`), '');
  if (kept.length) lines.push('Kept, though their objects are gone (you said no)', ...kept.map((p) => `  ? ${p}`), '');
  const told = skipped.filter((x) => !x.quiet);
  if (told.length) lines.push("Not written: the server gave no definition (encrypted, or the login can't VIEW DEFINITION); their files are left as they were", ...told.map((x) => `  ! ${x.name}`), '');
  if (!plan.written.length && !removed.length) lines.push('Nothing changed since the files were written.');
  return lines.join('\n').trimEnd();
}
