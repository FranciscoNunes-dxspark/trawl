// The catalog of the database a session is in, read in one batch and shaped into one object
// that the Explorer, completion and /describe all read from.

// The marker comment lets the demo driver recognise this batch.
export const SCHEMA_SQL = `-- fathom:schema
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
ORDER BY s.name, o.name, c.column_id;`;

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

/** Shapes SCHEMA_SQL's four result sets into { database, databases, objects }. */
export function buildSchema(sets) {
  const [dbSet, dbsSet, objSet, colSet] = sets;
  const objects = rowsOf(objSet).map((o) => ({
    schema: o.schema,
    name: o.name,
    kind: KINDS[o.type] ?? 'other',
    rows: o.rows == null ? null : Number(o.rows),
    columns: [],
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
  return {
    database: rowsOf(dbSet)[0]?.db ?? null,
    databases: rowsOf(dbsSet).map((d) => d.name),
    objects,
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

/** The text /describe shows for a table or view. */
export function describeObject(o) {
  const nameW = Math.max(6, ...o.columns.map((c) => c.name.length)) + 2;
  const typeW = Math.max(4, ...o.columns.map((c) => c.type.length)) + 2;
  const lines = [`${o.kind} ${objectName(o)}${o.rows != null ? `  ·  about ${o.rows.toLocaleString('en')} rows` : ''}`, ''];
  for (const c of o.columns) {
    const flags = [c.pk ? 'primary key' : '', c.identity ? 'identity' : '', c.nullable ? 'null' : 'not null'].filter(Boolean).join(', ');
    lines.push(`${c.pk ? 'PK' : '  '} ${c.name.padEnd(nameW)}${c.type.padEnd(typeW)}${flags}`);
  }
  if (!o.columns.length) lines.push('(no columns listed for this kind of object)');
  return lines.join('\n');
}
