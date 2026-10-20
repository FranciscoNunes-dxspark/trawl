// The catalog of the database a session is in, read in one batch and shaped into one object
// that the Explorer, completion and /describe all read from.

// The marker comment lets the demo driver recognise this batch.
export const SCHEMA_SQL = `-- trawl:schema
SELECT DB_NAME() AS db;
SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name;
SELECT s.name AS [schema], o.name, RTRIM(o.type) AS type,
  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS [rows]
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0
ORDER BY s.name, o.name;
SELECT s.name AS [schema], o.name AS [object], c.name, t.name AS type, c.max_length, c.precision, c.scale,
  c.is_nullable, c.is_identity,
  CASE WHEN EXISTS (
    SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
  ) THEN 1 ELSE 0 END AS pk
FROM sys.columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, c.column_id;
SELECT fk.name, ps.name AS [schema], po.name AS [object], pc.name AS [column],
  rs.name AS ref_schema, ro.name AS ref_object, rc.name AS ref_column
FROM sys.foreign_key_columns fkc
JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
JOIN sys.objects po ON po.object_id = fkc.parent_object_id
JOIN sys.schemas ps ON ps.schema_id = po.schema_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
ORDER BY fk.name, fkc.constraint_column_id;
SELECT s.name AS [schema], o.name AS [object], p.name, t.name AS type, p.max_length, p.precision, p.scale, p.is_output
FROM sys.parameters p
JOIN sys.objects o ON o.object_id = p.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.types t ON t.user_type_id = p.user_type_id
WHERE o.type IN ('P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0 AND p.parameter_id > 0
ORDER BY s.name, o.name, p.parameter_id;`;

const KINDS = { U: 'table', V: 'view', P: 'procedure', FN: 'function', IF: 'function', TF: 'function' };

/** Rows of a result set as objects keyed by column name. */
export function rowsOf(set) {
  if (!set) return [];
  return set.rows.map((row) => Object.fromEntries(set.columns.map((c, i) => [c.name, row[i]])));
}

/** A column's type the way it's declared: nvarchar(50), decimal(10,2), varbinary(max). */
export function typeLabel(type, maxLength, precision, scale) {
  const t = String(type).toLowerCase();
  const len = (n) => (n === -1 ? 'max' : n);
  if (t === 'nvarchar' || t === 'nchar') return `${t}(${maxLength === -1 ? 'max' : maxLength / 2})`;
  if (t === 'varchar' || t === 'char' || t === 'varbinary' || t === 'binary') return `${t}(${len(maxLength)})`;
  if (t === 'decimal' || t === 'numeric') return `${t}(${precision},${scale})`;
  if ((t === 'datetime2' || t === 'time' || t === 'datetimeoffset') && scale !== 7 && scale != null) return `${t}(${scale})`;
  return t;
}

/**
 * Shapes SCHEMA_SQL's result sets into { database, databases, objects, foreignKeys }. Procedures and
 * functions have `params` ({ name, type, output }), in order. A foreign key
 * is { name, from, to, columns }: `from` references `to` ("dbo.Players", "dbo.Clubs"), and each of
 * `columns` is [column in from, column in to].
 */
export function buildSchema(sets) {
  const [dbSet, dbsSet, objSet, colSet, fkSet, paramSet] = sets;
  const objects = rowsOf(objSet).map((o) => ({
    schema: o.schema,
    name: o.name,
    kind: KINDS[o.type] ?? 'other',
    rows: o.rows == null ? null : Number(o.rows),
    columns: [],
    ...(KINDS[o.type] === 'procedure' || KINDS[o.type] === 'function' ? { params: [] } : {}),
  }));
  // Grouped by schema whatever order the catalog came in (the Explorer draws one header per schema).
  objects.sort((x, y) => (x.schema === y.schema ? 0 : x.schema.toLowerCase() < y.schema.toLowerCase() ? -1 : 1));
  const byKey = new Map(objects.map((o) => [`${o.schema}.${o.name}`, o]));
  for (const c of rowsOf(colSet)) {
    byKey.get(`${c.schema}.${c.object}`)?.columns.push({
      name: c.name,
      type: typeLabel(c.type, c.max_length, c.precision, c.scale),
      nullable: Boolean(c.is_nullable),
      identity: Boolean(c.is_identity),
      pk: Boolean(c.pk),
    });
  }
  for (const p of rowsOf(paramSet)) {
    byKey.get(`${p.schema}.${p.object}`)?.params?.push({ name: p.name, type: typeLabel(p.type, p.max_length, p.precision, p.scale), output: Boolean(p.is_output) });
  }
  const foreignKeys = new Map();
  for (const f of rowsOf(fkSet)) {
    const key = `${f.schema}.${f.name}`;
    if (!foreignKeys.has(key)) foreignKeys.set(key, { name: f.name, from: `${f.schema}.${f.object}`, to: `${f.ref_schema}.${f.ref_object}`, columns: [] });
    foreignKeys.get(key).columns.push([f.column, f.ref_column]);
  }
  return {
    database: rowsOf(dbSet)[0]?.db ?? null,
    databases: rowsOf(dbsSet).map((d) => d.name),
    objects,
    foreignKeys: [...foreignKeys.values()],
  };
}

const unquote = (part) => part.trim().replace(/^\[(.*)\]$/, '$1').replace(/]]/g, ']').replace(/^"(.*)"$/, '$1');

/** Finds "schema.name", "[schema].[name]" or a bare name (dbo first) in the schema. */
export function findObject(schema, text) {
  if (!schema || !text) return null;
  const parts = text.split('.').map(unquote);
  const name = parts.at(-1).toLowerCase();
  const owner = parts.length > 1 ? parts.at(-2).toLowerCase() : null;
  const hits = schema.objects.filter((o) => o.name.toLowerCase() === name && (!owner || o.schema.toLowerCase() === owner));
  return hits.find((o) => o.schema === 'dbo') ?? hits[0] ?? null;
}

/** "dbo.Clubs" for completion and titles. */
export const objectName = (o) => `${o.schema}.${o.name}`;

/** The text /describe shows for a table or view, with its foreign keys when `schema` is given. */
export function describeObject(o, schema) {
  const nameW = Math.max(6, ...o.columns.map((c) => c.name.length)) + 2;
  const typeW = Math.max(4, ...o.columns.map((c) => c.type.length)) + 2;
  const lines = [`${o.kind} ${objectName(o)}${o.rows != null ? `  ·  about ${o.rows.toLocaleString('en')} rows` : ''}`, ''];
  for (const c of o.columns) {
    const flags = [c.pk ? 'primary key' : '', c.identity ? 'identity' : '', c.nullable ? 'null' : 'not null'].filter(Boolean).join(', ');
    lines.push(`${c.pk ? 'PK' : '  '} ${c.name.padEnd(nameW)}${c.type.padEnd(typeW)}${flags}`);
  }
  if (o.params) {
    const w = Math.max(6, ...o.params.map((p) => p.name.length)) + 2;
    for (const p of o.params) lines.push(`   ${p.name.padEnd(w)}${p.type}${p.output ? '  output' : ''}`);
    if (!o.params.length) lines.push('(no parameters)');
  } else if (!o.columns.length) lines.push('(no columns listed for this kind of object)');
  const name = objectName(o);
  const keys = (schema?.foreignKeys ?? []).filter((f) => f.from === name || f.to === name);
  if (keys.length) lines.push('', 'Foreign keys');
  for (const f of keys) {
    const cols = (i) => f.columns.map((c) => c[i]).join(', ');
    lines.push(f.from === name ? `  ${cols(0)} → ${f.to} (${cols(1)})  ${f.name}` : `  ${f.from} (${cols(0)}) → ${cols(1)}  ${f.name}`);
  }
  return lines.join('\n');
}

const bracket = (name) => `[${String(name).replace(/]/g, ']]')}]`;
const fullName = (o) => `${bracket(o.schema)}.${bracket(o.name)}`;

/**
 * CREATE TABLE for a table, from what the catalog query read: columns, the primary key and the
 * foreign keys. Defaults, checks, indexes and an identity's seed aren't read, and the script says so.
 * `quote` and `identity` write it for another dialect (dialects.js).
 */
export function createTableScript(o, schema, { quote = bracket, identity = 'IDENTITY(1,1)' } = {}) {
  const fullName = (x) => `${quote(x.schema)}.${quote(x.name)}`;
  const cols = o.columns.map((c) => `  ${quote(c.name)} ${c.type}${c.identity ? ` ${identity}` : ''} ${c.nullable ? 'NULL' : 'NOT NULL'}`);
  const pk = o.columns.filter((c) => c.pk).map((c) => quote(c.name));
  if (pk.length) cols.push(`  PRIMARY KEY (${pk.join(', ')})`);
  const name = objectName(o);
  const fks = (schema?.foreignKeys ?? [])
    .filter((f) => f.from === name)
    .map((f) => {
      const [toSchema, ...toName] = f.to.split('.');
      const list = (i) => f.columns.map((c) => quote(c[i])).join(', ');
      return `ALTER TABLE ${fullName(o)} ADD CONSTRAINT ${quote(f.name)}\n  FOREIGN KEY (${list(0)}) REFERENCES ${quote(toSchema)}.${quote(toName.join('.'))} (${list(1)});`;
    });
  return [
    `-- ${name}: columns, primary key and foreign keys as Trawl read them (not defaults, checks or indexes).`,
    `CREATE TABLE ${fullName(o)} (`,
    cols.join(',\n'),
    ');',
    ...fks,
  ].join('\n');
}

// The marker comment lets the demo driver recognise this batch.
/** The query that reads a view's, procedure's or function's own CREATE text. */
export const definitionSql = (o) => `-- trawl:definition\nSELECT OBJECT_DEFINITION(OBJECT_ID(N'${fullName(o).replace(/'/g, "''")}')) AS definition;`;
