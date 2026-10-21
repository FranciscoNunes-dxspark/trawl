// Comparing two databases' schemas: what each has that the other hasn't, and what differs (columns'
// types and nullability, primary keys, foreign keys, indexes, and views', procedures' and functions'
// definitions). Pure: actions.js reads both catalogs and shows the text, and the script that would
// make the first database match the second.
import { createTableScript, objectName } from './schema.js';
import { quoteIdent } from './sql.js';

// The marker comment lets the demo driver recognise this batch.
export const DIFF_SQL = `-- trawl:diff
SELECT s.name AS [schema], o.name, OBJECT_DEFINITION(o.object_id) AS definition
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('V', 'P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0
ORDER BY s.name, o.name;
SELECT s.name AS [schema], o.name AS [object], i.name, i.is_unique, i.type_desc, i.filter_definition,
  STUFF((SELECT ', ' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
    FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
    ORDER BY ic.key_ordinal FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS columns,
  STUFF((SELECT ', ' + QUOTENAME(c.name)
    FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
    ORDER BY c.name FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS included
FROM sys.indexes i
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0 AND i.type > 0 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.is_hypothetical = 0
ORDER BY s.name, o.name, i.name;`;

const rowsOf = (set) => (set ? set.rows.map((row) => Object.fromEntries(set.columns.map((c, i) => [c.name, row[i]]))) : []);
const key = (s) => String(s).toLowerCase();

/**
 * DIFF_SQL's result sets as { definitions, indexes }: definitions by "schema.name" (lower case), and
 * each index { table: "schema.name", name, unique, type, columns, included, filter }.
 */
export function buildExtras(sets) {
  const definitions = new Map(rowsOf(sets[0]).map((r) => [key(`${r.schema}.${r.name}`), r.definition == null ? null : String(r.definition)]));
  const indexes = rowsOf(sets[1]).map((r) => ({
    table: `${r.schema}.${r.object}`,
    name: r.name,
    unique: Boolean(r.is_unique),
    type: String(r.type_desc ?? 'NONCLUSTERED').toUpperCase(),
    columns: r.columns ?? '',
    included: r.included ?? '',
    filter: r.filter_definition ?? '',
  }));
  return { definitions, indexes };
}

// Definitions count as the same when only line endings, trailing spaces and blank lines at the ends differ.
const normaliseDefinition = (text) =>
  String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();

const columnText = (c) => `${c.type}${c.identity ? ' identity' : ''} ${c.nullable ? 'null' : 'not null'}`;
const fkText = (f) => `(${f.columns.map((c) => c[0]).join(', ')}) → ${f.to} (${f.columns.map((c) => c[1]).join(', ')})`;
const indexText = (i) => `${i.unique ? 'unique ' : ''}${i.type.toLowerCase()} (${i.columns})${i.included ? ` include (${i.included})` : ''}${i.filter ? ` where ${i.filter}` : ''}`;

/**
 * What differs between `left` and `right`, each { schema, definitions, indexes } (buildSchema and
 * buildExtras). A list of { kind, name, change, … }: `change` is 'left' (only the left has it),
 * 'right' (only the right) or 'changed'. Kinds: table, view, procedure, function (whole objects), and
 * column, primary key, foreign key, index (inside a table both have, `table` naming it).
 */
export function schemaDiff(left, right) {
  const out = [];
  const objs = (side) => new Map(side.schema.objects.filter((o) => o.kind !== 'other').map((o) => [key(objectName(o)), o]));
  const [lo, ro] = [objs(left), objs(right)];
  const names = [...new Set([...lo.keys(), ...ro.keys()])].sort();
  for (const n of names) {
    const [l, r] = [lo.get(n), ro.get(n)];
    if (!l || !r || l.kind !== r.kind) {
      if (l) out.push({ kind: l.kind, name: objectName(l), change: 'left', left: l });
      if (r) out.push({ kind: r.kind, name: objectName(r), change: 'right', right: r });
      continue;
    }
    if (l.kind === 'table') {
      out.push(...tableDiff(l, r));
      continue;
    }
    const [ld, rd] = [left.definitions?.get(n), right.definitions?.get(n)];
    // A definition one side can't read (encrypted, no VIEW DEFINITION) can't be compared.
    if (ld != null && rd != null && normaliseDefinition(ld) !== normaliseDefinition(rd)) out.push({ kind: l.kind, name: objectName(l), change: 'changed', left: l, right: r, lines: lineDiff(normaliseDefinition(ld), normaliseDefinition(rd)) });
  }
  // Foreign keys and indexes, on the tables both sides have (a new table's come with it).
  const both = (table) => lo.get(key(table))?.kind === 'table' && ro.get(key(table))?.kind === 'table';
  const fks = (side) => new Map(side.schema.foreignKeys.filter((f) => both(f.from)).map((f) => [key(`${f.from}.${f.name}`), f]));
  const [lf, rf] = [fks(left), fks(right)];
  for (const n of [...new Set([...lf.keys(), ...rf.keys()])].sort()) {
    const [l, r] = [lf.get(n), rf.get(n)];
    if (l && r && fkText(l) === fkText(r)) continue;
    const f = l ?? r;
    out.push({ kind: 'foreign key', table: f.from, name: f.name, change: !l ? 'right' : !r ? 'left' : 'changed', left: l, right: r });
  }
  const idx = (side) => new Map((side.indexes ?? []).filter((i) => both(i.table)).map((i) => [key(`${i.table}.${i.name}`), i]));
  const [li, ri] = [idx(left), idx(right)];
  for (const n of [...new Set([...li.keys(), ...ri.keys()])].sort()) {
    const [l, r] = [li.get(n), ri.get(n)];
    if (l && r && indexText(l) === indexText(r)) continue;
    const i = l ?? r;
    out.push({ kind: 'index', table: i.table, name: i.name, change: !l ? 'right' : !r ? 'left' : 'changed', left: l, right: r });
  }
  return out;
}

function columnDiffs(l, r) {
  const out = [];
  const table = objectName(l);
  const [lc, rc] = [new Map(l.columns.map((c) => [key(c.name), c])), new Map(r.columns.map((c) => [key(c.name), c]))];
  for (const c of l.columns) {
    const other = rc.get(key(c.name));
    if (!other) out.push({ kind: 'column', table, name: c.name, change: 'left', left: c });
    else if (columnText(c) !== columnText(other)) out.push({ kind: 'column', table, name: c.name, change: 'changed', left: c, right: other });
  }
  for (const c of r.columns) if (!lc.has(key(c.name))) out.push({ kind: 'column', table, name: c.name, change: 'right', right: c });
  return out;
}

function tableDiff(l, r) {
  const out = columnDiffs(l, r);
  const pk = (o) => o.columns.filter((c) => c.pk).map((c) => c.name).join(', ');
  if (key(pk(l)) !== key(pk(r))) out.push({ kind: 'primary key', table: objectName(l), name: objectName(l), change: 'changed', left: pk(l), right: pk(r) });
  return out;
}

/**
 * The lines of `a` and `b` as a diff: [' ', line] kept, ['-', line] only in a, ['+', line] only in b.
 * A longest-common-subsequence diff, which is plenty for a view's or procedure's text.
 */
export function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  // Too big to compare line by line in reasonable time: say it all changed.
  if (x.length * y.length > 4_000_000) return [...x.map((l) => ['-', l]), ...y.map((l) => ['+', l])];
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let [i, j] = [0, 0];
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (out.push([' ', x[i]]), i++, j++);
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(['-', x[i++]]);
    else out.push(['+', y[j++]]);
  }
  while (i < x.length) out.push(['-', x[i++]]);
  while (j < y.length) out.push(['+', y[j++]]);
  return out;
}

const KIND_ORDER = ['table', 'view', 'procedure', 'function'];
const SECTION = { table: 'Tables', view: 'Views', procedure: 'Procedures', function: 'Functions' };
const MARK = { left: '<', right: '>', changed: '~' };

/**
 * The comparison as text for the viewer: one section per kind of object, `<` for what only the left
 * has, `>` for what only the right has, `~` for what differs, with the details under each table and
 * the changed lines of each definition (a few lines of context around them).
 */
export function diffText(changes, { left, right }) {
  const lines = [`${left}  ←→  ${right}`, `<  only in ${left}    >  only in ${right}    ~  different`, ''];
  if (!changes.length) return [...lines, 'The schemas are the same: the same tables, columns, keys, indexes and definitions.'].join('\n');
  const tableParts = new Map();
  for (const c of changes) if (c.table) (tableParts.get(key(c.table)) ?? tableParts.set(key(c.table), []).get(key(c.table))).push(c);
  for (const kind of KIND_ORDER) {
    const whole = changes.filter((c) => c.kind === kind && !c.table);
    const names = [...new Set([...whole.map((c) => key(c.name)), ...(kind === 'table' ? tableParts.keys() : [])])].sort();
    if (!names.length) continue;
    lines.push(SECTION[kind]);
    for (const n of names) {
      const w = whole.find((c) => key(c.name) === n);
      const parts = kind === 'table' ? (tableParts.get(n) ?? []) : [];
      if (w) {
        lines.push(`  ${MARK[w.change]} ${w.name}${w.change === 'changed' ? ': the definitions differ' : ''}`);
        if (w.lines) lines.push(...contextLines(w.lines).map((l) => `      ${l}`));
      } else if (parts.length) lines.push(`  ~ ${parts[0].table}`);
      for (const p of parts) lines.push(`      ${partText(p)}`);
    }
    lines.push('');
  }
  const counts = ['left', 'right', 'changed'].map((ch) => changes.filter((c) => c.change === ch).length);
  lines.push(`${counts[0]} only in ${left} · ${counts[1]} only in ${right} · ${counts[2]} different`);
  return lines.join('\n');
}

function partText(p) {
  const m = MARK[p.change];
  if (p.kind === 'column') return p.change === 'changed' ? `~ ${p.name}: ${columnText(p.left)} → ${columnText(p.right)}` : `${m} column ${p.name} ${columnText(p.left ?? p.right)}`;
  if (p.kind === 'primary key') return `~ primary key: (${p.left || 'none'}) → (${p.right || 'none'})`;
  if (p.kind === 'foreign key') return p.change === 'changed' ? `~ foreign key ${p.name}: ${fkText(p.left)} → ${fkText(p.right)}` : `${m} foreign key ${p.name} ${fkText(p.left ?? p.right)}`;
  return p.change === 'changed' ? `~ index ${p.name}: ${indexText(p.left)} → ${indexText(p.right)}` : `${m} index ${p.name} ${indexText(p.left ?? p.right)}`;
}

// The changed lines with two lines of context, "…" where unchanged ones are left out.
function contextLines(diff, around = 2) {
  const keep = diff.map((d, i) => diff.slice(Math.max(0, i - around), i + around + 1).some((x) => x[0] !== ' '));
  const out = [];
  diff.forEach(([mark, text], i) => {
    if (keep[i]) out.push(`${mark === ' ' ? ' ' : mark} ${text}`);
    else if (keep[i - 1] || i === 0) out.push('  …');
  });
  return out;
}

const qname = (dotted) => {
  const [schema, ...rest] = String(dotted).split('.');
  return `${quoteIdent(schema)}.${quoteIdent(rest.join('.'))}`;
};
const DROP = { view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION' };
const createOrAlter = (definition) => String(definition).replace(/^(\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*)CREATE\s+(?!OR\s+ALTER\b)/i, '$1CREATE OR ALTER ');

/**
 * T-SQL that makes the left database match the right one, to read through and run on the left. What
 * loses data (dropping a table or a column) is written commented out, to uncomment on purpose; so is
 * what can't be done in place (an identity or primary key changing). Views, procedures and functions
 * go one to a batch, as SQL Server needs, with CREATE OR ALTER for those that differ.
 */
export function syncScript(changes, { left, right, rightSchema, rightDefinitions }) {
  const out = [`-- Makes ${left} match ${right}, from Trawl's schema diff. Read it through before running it on ${left}.`, '-- Dropping a table or a column loses its data, so those lines are commented out: uncomment them on purpose.', ''];
  const drops = [];
  const tables = [];
  const columns = [];
  const keys = [];
  const modules = [];
  const fkSql = (f) => {
    const list = (i) => f.columns.map((c) => quoteIdent(c[i])).join(', ');
    return `ALTER TABLE ${qname(f.from)} ADD CONSTRAINT ${quoteIdent(f.name)} FOREIGN KEY (${list(0)}) REFERENCES ${qname(f.to)} (${list(1)});`;
  };
  const indexSql = (i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}${/^(CLUSTERED|NONCLUSTERED)$/.test(i.type) ? `${i.type} ` : ''}INDEX ${quoteIdent(i.name)} ON ${qname(i.table)} (${i.columns})${i.included ? ` INCLUDE (${i.included})` : ''}${i.filter ? ` WHERE ${i.filter}` : ''};`;
  const columnSql = (c) => `${quoteIdent(c.name)} ${c.type} ${c.nullable ? 'NULL' : 'NOT NULL'}`;
  const definition = (o) => rightDefinitions?.get(key(objectName(o)));
  for (const c of changes) {
    if (c.kind === 'table') {
      if (c.change === 'right') tables.push(createTableScript(c.right, rightSchema));
      else drops.push(`-- DROP TABLE ${qname(c.name)};`);
    } else if (DROP[c.kind]) {
      if (c.change === 'left') drops.push(`DROP ${DROP[c.kind]} ${qname(c.name)};`);
      else {
        const text = definition(c.right);
        modules.push(text ? `${c.change === 'changed' ? createOrAlter(text.trim()) : text.trim()}\nGO` : `-- ${c.name}: its definition couldn't be read on ${right}.`);
      }
    } else if (c.kind === 'column') {
      const t = qname(c.table);
      if (c.change === 'left') columns.push(`-- ALTER TABLE ${t} DROP COLUMN ${quoteIdent(c.name)};`);
      else if (c.change === 'right') {
        const notes = [c.right.identity ? 'identity: add IDENTITY(1,1) by hand' : '', c.right.nullable ? '' : 'NOT NULL: a table with rows needs a DEFAULT too'].filter(Boolean);
        columns.push(`ALTER TABLE ${t} ADD ${columnSql(c.right)};${notes.length ? ` -- ${notes.join('; ')}` : ''}`);
      }
      else if (c.left.identity !== c.right.identity) columns.push(`-- ${t}.${quoteIdent(c.name)}: IDENTITY can't be added or removed in place; rebuild the table.`);
      else columns.push(`ALTER TABLE ${t} ALTER COLUMN ${columnSql(c.right)};`);
    } else if (c.kind === 'primary key') {
      columns.push(`-- ${qname(c.table)}: the primary key is (${c.left || 'none'}) here and (${c.right || 'none'}) there; change it by hand.`);
    } else if (c.kind === 'foreign key') {
      if (c.left) drops.unshift(`ALTER TABLE ${qname(c.table)} DROP CONSTRAINT ${quoteIdent(c.name)};`);
      if (c.right) keys.push(fkSql(c.right));
    } else if (c.kind === 'index') {
      if (c.left) drops.push(`DROP INDEX ${quoteIdent(c.name)} ON ${qname(c.table)};`);
      if (c.right) keys.push(indexSql(c.right));
    }
  }
  const section = (title, list) => (list.length ? [`-- ${title}`, ...list, ''] : []);
  out.push(...section('Drop what the other side hasn\'t', drops), ...section('New tables', tables), ...section('Columns', columns), ...section('Keys and indexes', keys));
  if (out.length > 3 && modules.length) out.push('GO', '');
  out.push(...section('Views, procedures and functions', modules));
  return out.join('\n').trimEnd() + '\n';
}
