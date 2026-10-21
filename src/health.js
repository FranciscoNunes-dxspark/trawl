// /health and /sizes: a check-up of the database you're in, and how big its tables are. The SQL for
// each kind of server is here (dialects.js hands it out as `health` and `sizesSql`), each read shaped
// the same whatever the kind, so the rest is pure: buildHealth turns what the reads gave into groups
// of findings, each with why it matters and the statement that would fix it; healthText is the
// viewer's report and healthScript the fix script, which nothing runs by itself.
import { fit, stringWidth, wrap } from './text.js';

const rowsOf = (set) => (set ? set.rows.map((row) => Object.fromEntries(set.columns.map((c, i) => [c.name, row[i]]))) : []);
const num = (v) => (v == null || v === '' ? null : Number(v));
// tedious and pg give booleans; mysql2 gives 0/1, as numbers or (BIGINT) strings.
const bool = (v) => v === true || Number(v) === 1;
const str = (v) => (v == null ? '' : String(v));
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

// Statistics count as stale when last updated this many days ago (or never), on a table changed by
// at least this share of its rows, and at least MIN_CHANGES rows, since. Dead rows (Postgres) the same.
export const STALE_DAYS = 7;
export const STALE_SHARE = 0.2;
export const MIN_CHANGES = 500;

const PG_SKIP = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;

// Each kind's reads, by id. A check needs one or two of them (CHECKS); a read that fails (a missing
// permission, an old server) only takes its checks with it. Every read gives the same columns on
// every kind, as the comments at the SQL Server ones say.
const SQLSERVER_READS = {
  // started: when the usage counters began (tempdb is made again at every start).
  restart: `-- trawl:health restart
SELECT (SELECT create_date FROM sys.databases WHERE database_id = 2) AS started, CAST(NULL AS datetime) AS stats_reset;`,
  // schema, table, equality_columns, inequality_columns, included_columns ("[a], [b]"), seeks, scans,
  // avg_impact (the % of the cost it would save), impact (cost × impact × uses, for the ranking).
  missing: `-- trawl:health missing
SELECT TOP (100) s.name AS [schema], o.name AS [table], d.equality_columns, d.inequality_columns, d.included_columns,
  gs.user_seeks AS seeks, gs.user_scans AS scans, gs.avg_user_impact AS avg_impact,
  gs.avg_total_user_cost * gs.avg_user_impact * (gs.user_seeks + gs.user_scans) AS impact
FROM sys.dm_db_missing_index_details d
JOIN sys.dm_db_missing_index_groups g ON g.index_handle = d.index_handle
JOIN sys.dm_db_missing_index_group_stats gs ON gs.group_handle = g.index_group_handle
JOIN sys.objects o ON o.object_id = d.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE d.database_id = DB_ID()
ORDER BY impact DESC;`,
  // schema, table, index, seeks, scans, lookups, updates, size_kb: nonclustered indexes that enforce
  // nothing, read by no query since the restart, written by some.
  unused: `-- trawl:health unused
SELECT s.name AS [schema], o.name AS [table], i.name AS [index],
  ISNULL(u.user_seeks, 0) AS seeks, ISNULL(u.user_scans, 0) AS scans, ISNULL(u.user_lookups, 0) AS lookups, ISNULL(u.user_updates, 0) AS updates,
  (SELECT SUM(a.total_pages) * 8 FROM sys.partitions p JOIN sys.allocation_units a ON a.container_id = CASE WHEN a.type IN (1, 3) THEN p.hobt_id ELSE p.partition_id END
   WHERE p.object_id = i.object_id AND p.index_id = i.index_id) AS size_kb
FROM sys.indexes i
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.dm_db_index_usage_stats u ON u.database_id = DB_ID() AND u.object_id = i.object_id AND u.index_id = i.index_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0 AND i.type = 2 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.is_unique = 0
  AND i.is_disabled = 0 AND i.is_hypothetical = 0
  AND ISNULL(u.user_seeks, 0) + ISNULL(u.user_scans, 0) + ISNULL(u.user_lookups, 0) = 0 AND ISNULL(u.user_updates, 0) > 0
ORDER BY updates DESC;`,
  // A row per index column: schema, table, index, is_primary_key, is_unique, is_constraint (it backs
  // a primary key or unique constraint), is_clustered, filtered, key_ordinal, column, is_included, is_descending.
  indexes: `-- trawl:health indexes
SELECT s.name AS [schema], o.name AS [table], i.name AS [index], i.is_primary_key, i.is_unique,
  CAST(CASE WHEN i.is_primary_key = 1 OR i.is_unique_constraint = 1 THEN 1 ELSE 0 END AS bit) AS is_constraint,
  CAST(CASE WHEN i.type = 1 THEN 1 ELSE 0 END AS bit) AS is_clustered, i.has_filter AS filtered,
  ic.key_ordinal, c.name AS [column], ic.is_included_column AS is_included, ic.is_descending_key AS is_descending
FROM sys.indexes i
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0 AND i.type IN (1, 2) AND i.is_hypothetical = 0 AND i.is_disabled = 0
  AND (ic.key_ordinal > 0 OR ic.is_included_column = 1)
ORDER BY s.name, o.name, i.name, ic.is_included_column, ic.key_ordinal, c.name;`,
  // A row per foreign key column: schema, table, name, ordinal, column, ref_schema, ref_table.
  foreignKeys: `-- trawl:health foreignKeys
SELECT s.name AS [schema], o.name AS [table], fk.name, fkc.constraint_column_id AS ordinal, c.name AS [column], rs.name AS ref_schema, ro.name AS ref_table
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.objects o ON o.object_id = fk.parent_object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
WHERE o.is_ms_shipped = 0
ORDER BY s.name, o.name, fk.name, fkc.constraint_column_id;`,
  // schema, table, has_pk, is_heap, rows: tables without a primary key, and heaps.
  nopk: `-- trawl:health nopk
SELECT s.name AS [schema], t.name AS [table],
  CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 1) THEN 1 ELSE 0 END AS bit) AS has_pk,
  CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.type = 0) THEN 1 ELSE 0 END AS bit) AS is_heap,
  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS [rows]
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
  AND (NOT EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 1)
    OR EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.type = 0))
ORDER BY s.name, t.name;`,
  // schema, table, name, kind (FOREIGN KEY or CHECK), is_disabled, is_not_trusted. NOT FOR
  // REPLICATION ones are untrusted by design, so left out.
  untrusted: `-- trawl:health untrusted
SELECT s.name AS [schema], o.name AS [table], k.name, 'FOREIGN KEY' AS kind, k.is_disabled, k.is_not_trusted
FROM sys.foreign_keys k
JOIN sys.objects o ON o.object_id = k.parent_object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE (k.is_not_trusted = 1 OR k.is_disabled = 1) AND k.is_not_for_replication = 0 AND o.is_ms_shipped = 0
UNION ALL
SELECT s.name, o.name, k.name, 'CHECK', k.is_disabled, k.is_not_trusted
FROM sys.check_constraints k
JOIN sys.objects o ON o.object_id = k.parent_object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE (k.is_not_trusted = 1 OR k.is_disabled = 1) AND k.is_not_for_replication = 0 AND o.is_ms_shipped = 0
ORDER BY 1, 2, 3;`,
  // schema, table, name (the statistics'; null for Postgres's table-wide ones), last_updated,
  // days_since (null: never), rows, modifications since, dead_rows (Postgres only).
  stats: `-- trawl:health stats
SELECT s.name AS [schema], o.name AS [table], st.name, sp.last_updated, DATEDIFF(DAY, sp.last_updated, SYSDATETIME()) AS days_since,
  sp.rows, sp.modification_counter AS modifications, CAST(NULL AS bigint) AS dead_rows
FROM sys.stats st
JOIN sys.objects o ON o.object_id = st.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
CROSS APPLY sys.dm_db_stats_properties(st.object_id, st.stats_id) sp
WHERE o.type = 'U' AND o.is_ms_shipped = 0 AND sp.modification_counter >= ${MIN_CHANGES}
ORDER BY sp.modification_counter DESC;`,
  // schema, table, name: the triggers on tables that are disabled.
  triggers: `-- trawl:health triggers
SELECT s.name AS [schema], o.name AS [table], tr.name
FROM sys.triggers tr
JOIN sys.objects o ON o.object_id = tr.parent_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE tr.is_disabled = 1 AND tr.parent_class = 1 AND tr.is_ms_shipped = 0
ORDER BY 1, 2, 3;`,
};

const POSTGRES_READS = {
  // The statistics views count from their last reset (pg_stat_reset), which survives a clean restart.
  restart: `-- trawl:health restart
SELECT pg_postmaster_start_time() AS started, (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset;`,
  // Postgres doesn't count an index's writes: `updates` is its table's rows written.
  unused: `-- trawl:health unused
SELECT s.schemaname AS "schema", s.relname AS "table", s.indexrelname AS "index", NULL::bigint AS seeks, s.idx_scan AS scans, NULL::bigint AS lookups,
  t.n_tup_ins + t.n_tup_upd + t.n_tup_del AS updates, pg_relation_size(s.indexrelid) / 1024 AS size_kb
FROM pg_stat_user_indexes s
JOIN pg_index x ON x.indexrelid = s.indexrelid
JOIN pg_stat_user_tables t ON t.relid = s.relid
WHERE s.idx_scan = 0 AND NOT x.indisunique AND NOT x.indisprimary
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)
ORDER BY pg_relation_size(s.indexrelid) DESC;`,
  indexes: `-- trawl:health indexes
SELECT n.nspname AS "schema", t.relname AS "table", i.relname AS "index", x.indisprimary AS is_primary_key, x.indisunique AS is_unique,
  EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid AND c.contype IN ('p', 'u', 'x')) AS is_constraint,
  false AS is_clustered, x.indpred IS NOT NULL AS filtered, k.ord AS key_ordinal,
  COALESCE(a.attname, pg_get_indexdef(x.indexrelid, k.ord::int, true)) AS "column", k.ord > x.indnkeyatts AS is_included,
  COALESCE((x.indoption::int2[])[k.ord - 1] & 1, 0) = 1 AS is_descending
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
CROSS JOIN LATERAL unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum > 0
WHERE t.relkind IN ('r', 'p') AND ${PG_SKIP}
ORDER BY 1, 2, 3, k.ord;`,
  // A partition's copies of its parent's foreign keys (conparentid) are left out.
  foreignKeys: `-- trawl:health foreignKeys
SELECT n.nspname AS "schema", c.relname AS "table", con.conname AS name, k.ord AS ordinal, a.attname AS "column", rn.nspname AS ref_schema, rc.relname AS ref_table
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_class rc ON rc.oid = con.confrelid
JOIN pg_namespace rn ON rn.oid = rc.relnamespace
CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
WHERE con.contype = 'f' AND con.conparentid = 0 AND ${PG_SKIP}
ORDER BY 1, 2, 3, 4;`,
  // Every Postgres table is a heap, so is_heap means nothing here.
  nopk: `-- trawl:health nopk
SELECT n.nspname AS "schema", c.relname AS "table", false AS has_pk, false AS is_heap,
  CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS "rows"
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${PG_SKIP}
  AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')
ORDER BY 1, 2;`,
  // Constraints added NOT VALID, which the rows already there were never checked against.
  untrusted: `-- trawl:health untrusted
SELECT n.nspname AS "schema", c.relname AS "table", con.conname AS name, CASE con.contype WHEN 'f' THEN 'FOREIGN KEY' ELSE 'CHECK' END AS kind,
  false AS is_disabled, true AS is_not_trusted
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT con.convalidated AND con.contype IN ('f', 'c') AND ${PG_SKIP}
ORDER BY 1, 2, 3;`,
  stats: `-- trawl:health stats
SELECT schemaname AS "schema", relname AS "table", NULL::text AS name, GREATEST(last_analyze, last_autoanalyze) AS last_updated,
  EXTRACT(DAY FROM now() - GREATEST(last_analyze, last_autoanalyze))::int AS days_since,
  n_live_tup AS "rows", n_mod_since_analyze AS modifications, n_dead_tup AS dead_rows
FROM pg_stat_user_tables
WHERE n_mod_since_analyze >= ${MIN_CHANGES} OR n_dead_tup >= ${MIN_CHANGES}
ORDER BY 1, 2;`,
  triggers: `-- trawl:health triggers
SELECT n.nspname AS "schema", c.relname AS "table", t.tgname AS name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND t.tgenabled = 'D' AND ${PG_SKIP}
ORDER BY 1, 2, 3;`,
};

const MYSQL_READS = {
  restart: `-- trawl:health restart
SELECT NOW() - INTERVAL CAST(VARIABLE_VALUE AS UNSIGNED) SECOND AS started, NULL AS stats_reset
FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime';`,
  // The sys schema's view (performance_schema's index I/O since the start), unique indexes left out.
  unused: `-- trawl:health unused
SELECT u.object_schema AS \`schema\`, u.object_name AS \`table\`, u.index_name AS \`index\`, NULL AS seeks, 0 AS scans, NULL AS lookups, NULL AS updates, NULL AS size_kb
FROM sys.schema_unused_indexes u
WHERE u.object_schema = DATABASE()
  AND EXISTS (SELECT 1 FROM information_schema.statistics s WHERE s.table_schema = u.object_schema AND s.table_name = u.object_name AND s.index_name = u.index_name AND s.non_unique = 1)
ORDER BY 1, 2, 3;`,
  // InnoDB clusters on the primary key; a unique index is a unique constraint there.
  indexes: `-- trawl:health indexes
SELECT table_schema AS \`schema\`, table_name AS \`table\`, index_name AS \`index\`, index_name = 'PRIMARY' AS is_primary_key, non_unique = 0 AS is_unique,
  non_unique = 0 AS is_constraint, index_name = 'PRIMARY' AS is_clustered, 0 AS filtered, seq_in_index AS key_ordinal,
  COALESCE(column_name, '(expression)') AS \`column\`, 0 AS is_included, collation = 'D' AS is_descending
FROM information_schema.statistics
WHERE table_schema = DATABASE() AND index_type NOT IN ('FULLTEXT', 'SPATIAL')
ORDER BY table_name, index_name, seq_in_index;`,
  foreignKeys: `-- trawl:health foreignKeys
SELECT table_schema AS \`schema\`, table_name AS \`table\`, constraint_name AS name, ordinal_position AS ordinal, column_name AS \`column\`,
  referenced_table_schema AS ref_schema, referenced_table_name AS ref_table
FROM information_schema.key_column_usage
WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL
ORDER BY table_name, constraint_name, ordinal_position;`,
  nopk: `-- trawl:health nopk
SELECT t.table_schema AS \`schema\`, t.table_name AS \`table\`, 0 AS has_pk, 0 AS is_heap, t.table_rows AS \`rows\`
FROM information_schema.tables t
WHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE'
  AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.constraint_type = 'PRIMARY KEY')
ORDER BY t.table_name;`,
};

// The checks, in the order the report lists them, and what each needs read. `why` says what a
// finding means, per kind where it differs; a kind with no such thing has `unavailable` instead.
export const CHECKS = [
  {
    id: 'missing',
    title: 'Missing indexes the server suggests',
    reads: ['missing'],
    why: { sqlserver: "What the optimizer asked for while compiling queries since the server started, most useful first by its own estimate (the cost it would save × how often). They often overlap each other and the indexes already there: read them together before creating any." },
    unavailable: {
      postgres: "PostgreSQL doesn't suggest missing indexes (the hypopg and pg_qualstats extensions come close): the top queries (Q in Activity) and their plans are where to look.",
      mysql: "MySQL doesn't suggest missing indexes: the top queries (Q in Activity) and their plans are where to look.",
    },
  },
  {
    id: 'unused',
    title: 'Unused indexes',
    reads: ['unused'],
    why: {
      sqlserver: "Nonclustered indexes no query has sought, scanned or looked up since the server started{since}, which every write still keeps up to date. A monthly report, or a restart last night, can make an index look unused: be sure before dropping one.",
      postgres: "Indexes no scan has used since the statistics were last reset{since}, which every write to their table still keeps up to date (the writes shown are the table's). Be sure before dropping one: a monthly report counts too, and a replica's reads aren't counted here.",
      mysql: "Indexes the sys schema's schema_unused_indexes says nothing has read since the server started{since} (performance_schema's counts). Be sure before dropping one.",
    },
  },
  {
    id: 'duplicate',
    title: 'Duplicate and overlapping indexes',
    reads: ['indexes'],
    why: { all: "Indexes whose key columns are the same as another's, or the first of another's: the longer one can do the shorter one's work. Primary keys and unique indexes aren't offered for dropping, as they enforce something." },
  },
  {
    id: 'fk',
    title: 'Foreign keys without an index',
    reads: ['indexes', 'foreignKeys'],
    why: {
      all: "Foreign keys whose columns no index starts with: deleting or changing a row they refer to has to scan this table, and joins along them can't seek.",
      mysql: "Foreign keys whose columns no index starts with. InnoDB makes an index for each foreign key it adds, so there's usually nothing here.",
    },
  },
  {
    id: 'nopk',
    title: 'Tables without a primary key',
    reads: ['nopk'],
    why: {
      sqlserver: "Tables with nothing that identifies a row (Trawl can't edit them in place, and replication and change tracking need one), and heaps: tables with no clustered index, where updates leave forwarded rows behind and deletes don't give their space back.",
      postgres: "Tables with nothing that identifies a row: Trawl can't edit them in place, and logical replication can't send their updates and deletes.",
      mysql: "Tables with nothing that identifies a row: InnoDB clusters them on a hidden row id (or the first unique NOT NULL index), Trawl can't edit them in place, and row-based replication has to scan for each row it changes.",
    },
  },
  {
    id: 'untrusted',
    title: 'Untrusted or disabled constraints',
    reads: ['untrusted'],
    why: {
      sqlserver: "Foreign keys and check constraints added or turned back on WITH NOCHECK: the rows already there were never checked, so the optimizer can't rely on them, and a disabled one checks nothing at all. WITH CHECK CHECK CONSTRAINT checks every row, which takes a while on a big table and fails if one breaks it.",
      postgres: "Foreign keys and check constraints added NOT VALID: new rows are checked, the rows already there never were. VALIDATE CONSTRAINT checks them without blocking writes, and fails if one breaks it.",
    },
    unavailable: { mysql: "MySQL doesn't mark constraints as untrusted: a foreign key added with FOREIGN_KEY_CHECKS = 0 looks like any other." },
  },
  {
    id: 'stats',
    title: { all: 'Stale statistics', postgres: 'Dead rows and stale statistics' },
    reads: ['stats'],
    why: {
      sqlserver: `Statistics last updated over ${STALE_DAYS} days ago on tables changed by at least a fifth of their rows since: the optimizer's row estimates, and so its plans, go wrong.`,
      postgres: `Tables with many dead rows (VACUUM gives the space back) or changed by at least a fifth since their last ANALYZE, over ${STALE_DAYS} days ago or never: autovacuum isn't keeping up with them.`,
    },
    unavailable: { mysql: 'InnoDB keeps its statistics up to date by itself (innodb_stats_auto_recalc); ANALYZE TABLE refreshes them by hand.' },
  },
  {
    id: 'triggers',
    title: 'Disabled triggers',
    reads: ['triggers'],
    why: { all: "Triggers that are turned off, so their table's writes don't run them: often on purpose (a load turned them off), sometimes forgotten." },
    unavailable: { mysql: "MySQL's triggers can't be turned off." },
  },
];

export const HEALTH = { sqlserver: { reads: SQLSERVER_READS }, postgres: { reads: POSTGRES_READS }, mysql: { reads: MYSQL_READS } };

const forKind = (map, kind) => (typeof map === 'string' ? map : (map?.[kind] ?? map?.all ?? null));

/** The reads a kind runs for its checks: { id: sql }, the restart time's first. */
export function healthReads(kind) {
  const reads = HEALTH[kind]?.reads ?? SQLSERVER_READS;
  const needed = new Set(['restart', ...CHECKS.filter((c) => !forKind(c.unavailable, kind)).flatMap((c) => c.reads)]);
  return Object.fromEntries(Object.entries(reads).filter(([id]) => needed.has(id)));
}

/** Which checks each kind gets, for the report's last lines and the README. */
export const checksFor = (kind) => CHECKS.filter((c) => !forKind(c.unavailable, kind)).map((c) => c.id);

// ---- Shaping what the reads gave

/** The index-column rows as indexes: { schema, table, name, primary, unique, constraint, clustered, filtered, keys: [{ column, desc }], included: [] }. */
export function indexesOf(rows) {
  const byName = new Map();
  for (const r of rows) {
    const id = `${r.schema}\0${r.table}\0${r.index}`;
    if (!byName.has(id)) {
      byName.set(id, { schema: str(r.schema), table: str(r.table), name: str(r.index), primary: bool(r.is_primary_key), unique: bool(r.is_unique), constraint: bool(r.is_constraint), clustered: bool(r.is_clustered), filtered: bool(r.filtered), keys: [], included: [], order: [] });
    }
    const ix = byName.get(id);
    if (bool(r.is_included)) ix.included.push(str(r.column));
    else ix.order.push({ at: num(r.key_ordinal) ?? ix.order.length, column: str(r.column), desc: bool(r.is_descending) });
  }
  return [...byName.values()].map(({ order, ...ix }) => ({ ...ix, keys: order.sort((x, y) => x.at - y.at).map(({ column, desc }) => ({ column, desc })) }));
}

const sameKey = (a, b) => a.column.toLowerCase() === b.column.toLowerCase() && a.desc === b.desc;
const keyList = (ix) => ix.keys.map((k) => `${k.column}${k.desc ? ' DESC' : ''}`).join(', ');
// May this index be offered for dropping? Not one that enforces something, or holds the table's rows.
const droppable = (ix) => !ix.primary && !ix.unique && !ix.constraint && !ix.clustered;

/**
 * Pairs of indexes on one table where the first's keys are the same as the second's, or lead them:
 * [{ index, other, same, uncovered }], `uncovered` being the first's included columns the second
 * hasn't. Filtered indexes are left out (their filters would have to match too). The one offered
 * for dropping is never a primary key, unique or clustered; of two the same, the later by name goes.
 */
export function duplicateIndexes(indexes) {
  const out = [];
  const tables = new Map();
  for (const ix of indexes) {
    if (ix.filtered || !ix.keys.length) continue;
    const t = `${ix.schema}\0${ix.table}`;
    if (!tables.has(t)) tables.set(t, []);
    tables.get(t).push(ix);
  }
  for (const list of tables.values()) {
    const taken = new Set();
    for (const a of [...list].sort((x, y) => x.name.localeCompare(y.name))) {
      if (!droppable(a)) continue;
      // The widest other index whose keys start with all of a's.
      const others = list.filter((b) => b !== a && !taken.has(b.name) && b.keys.length >= a.keys.length && a.keys.every((k, i) => sameKey(k, b.keys[i])));
      if (!others.length) continue;
      const same = others.filter((b) => b.keys.length === a.keys.length);
      // Of two the same and both droppable, keep the first by name.
      const b = same.find((x) => !droppable(x) || x.name.localeCompare(a.name) < 0) ?? others.find((x) => x.keys.length > a.keys.length);
      if (!b) continue;
      const has = new Set([...b.keys.map((k) => k.column.toLowerCase()), ...b.included.map((c) => c.toLowerCase())]);
      // A clustered index has every column at its leaf.
      const uncovered = b.clustered ? [] : a.included.filter((c) => !has.has(c.toLowerCase()));
      out.push({ index: a, other: b, same: b.keys.length === a.keys.length, uncovered });
      taken.add(a.name);
    }
  }
  return out;
}

/** The foreign-key-column rows as keys: { schema, table, name, columns, refSchema, refTable }. */
export function foreignKeysOf(rows) {
  const byName = new Map();
  for (const r of [...rows].sort((x, y) => (num(x.ordinal) ?? 0) - (num(y.ordinal) ?? 0))) {
    const id = `${r.schema}\0${r.table}\0${r.name}`;
    if (!byName.has(id)) byName.set(id, { schema: str(r.schema), table: str(r.table), name: str(r.name), columns: [], refSchema: str(r.ref_schema), refTable: str(r.ref_table) });
    byName.get(id).columns.push(str(r.column));
  }
  return [...byName.values()];
}

/** The foreign keys no index supports: none whose first keys are the key's columns, in any order. */
export function unindexedForeignKeys(keys, indexes) {
  return keys.filter((fk) => {
    const want = new Set(fk.columns.map((c) => c.toLowerCase()));
    return !indexes.some(
      (ix) => ix.schema === fk.schema && ix.table === fk.table && !ix.filtered && ix.keys.length >= want.size && ix.keys.slice(0, want.size).every((k) => want.has(k.column.toLowerCase())),
    );
  });
}

/** Whether a stats row counts as stale or, on Postgres, its table as needing a VACUUM: { stale, dead }. */
export function staleness(r) {
  const rows = Math.max(0, num(r.rows) ?? 0);
  const enough = (n) => n != null && n >= MIN_CHANGES && n >= rows * STALE_SHARE;
  const days = num(r.days_since);
  return { stale: enough(num(r.modifications)) && (days == null || days >= STALE_DAYS), dead: enough(num(r.dead_rows)) };
}

/** "[a], [b]" (the missing-index DMV's lists) as names. */
export function bracketList(text) {
  return [...str(text).matchAll(/\[((?:[^\]]|\]\])*)\]/g)].map((m) => m[1].replace(/\]\]/g, ']'));
}

// The longest name each kind takes.
const NAME_MAX = { sqlserver: 128, postgres: 63, mysql: 64 };

/** A name for a new index: IX_Table_Col1_Col2 (ix_… elsewhere), only letters, digits and _. */
export function indexName(table, columns, kind = 'sqlserver') {
  const name = `${kind === 'sqlserver' ? 'IX' : 'ix'}_${[table, ...columns].join('_')}`.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/_+/g, '_').replace(/_$/, '');
  return name.slice(0, NAME_MAX[kind] ?? 128);
}

const kb = (n) => (n == null ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} GB` : n >= 1024 ? `${(n / 1024).toFixed(1)} MB` : `${Math.round(n)} KB`);
const day = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : '');
const stamp = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ') : d ? String(d).slice(0, 16) : '');

/**
 * The fix statements, the kind's own way. `q` quotes a name; each returns a statement (or a few).
 */
function fixes(kind, q) {
  const t = (schema, table) => `${q(schema)}.${q(table)}`;
  const cols = (list) => list.map((c) => q(c)).join(', ');
  return {
    createIndex: (schema, table, keys, include = []) => {
      const name = indexName(table, keys, kind);
      if (kind === 'sqlserver') return `CREATE NONCLUSTERED INDEX ${q(name)} ON ${t(schema, table)} (${cols(keys)})${include.length ? ` INCLUDE (${cols(include)})` : ''};`;
      return `CREATE INDEX ${q(name)} ON ${t(schema, table)} (${cols(keys)})${include.length && kind === 'postgres' ? ` INCLUDE (${cols(include)})` : ''};`;
    },
    dropIndex: (schema, table, name) => (kind === 'postgres' ? `DROP INDEX ${t(schema, name)};` : `DROP INDEX ${q(name)} ON ${t(schema, table)};`),
    check: (schema, table, name) => (kind === 'postgres' ? `ALTER TABLE ${t(schema, table)} VALIDATE CONSTRAINT ${q(name)};` : `ALTER TABLE ${t(schema, table)} WITH CHECK CHECK CONSTRAINT ${q(name)};`),
    stats: (schema, table, dead) => (kind === 'postgres' ? `${dead ? 'VACUUM (ANALYZE)' : 'ANALYZE'} ${t(schema, table)};` : `UPDATE STATISTICS ${t(schema, table)};`),
    enableTrigger: (schema, table, name) => (kind === 'postgres' ? `ALTER TABLE ${t(schema, table)} ENABLE TRIGGER ${q(name)};` : `ENABLE TRIGGER ${t(schema, name)} ON ${t(schema, table)};`),
    primaryKey: (schema, table) => `ALTER TABLE ${t(schema, table)} ADD CONSTRAINT ${q(`PK_${table}`.slice(0, NAME_MAX[kind] ?? 128))} PRIMARY KEY (…);`,
    clustered: (schema, table) => `CREATE CLUSTERED INDEX ${q(`CIX_${table}`)} ON ${t(schema, table)} (…);`,
  };
}

const sqlserverQuote = (name) => `[${String(name).replace(/]/g, ']]')}]`;

/**
 * What the reads gave ({ id: { sets } or { error } }) as the report: { kind, restart: { started,
 * statsReset }, groups }. Each group is { id, title, why, findings, error, unavailable }; a finding
 * is { object, detail, fix: [lines], commented } (commented: the fix changes what the database does,
 * so the script leaves it commented out). `quote` is the kind's (dialects.js).
 */
export function buildHealth(results, { kind = 'sqlserver', quote = sqlserverQuote } = {}) {
  const rows = (id) => rowsOf(results[id]?.sets?.[0]);
  const fx = fixes(kind, quote);
  const restartRow = rows('restart')[0] ?? {};
  const restart = { started: restartRow.started ?? null, statsReset: restartRow.stats_reset ?? null };
  const since = kind === 'postgres' ? (restart.statsReset ?? restart.started) : restart.started;
  const name = (r) => `${str(r.schema)}.${str(r.table)}`;
  let indexes = null;
  const find = {
    missing: () =>
      rows('missing').map((r) => {
        const keys = [...bracketList(r.equality_columns), ...bracketList(r.inequality_columns)];
        const include = bracketList(r.included_columns);
        const uses = (num(r.seeks) ?? 0) + (num(r.scans) ?? 0);
        const impact = num(r.avg_impact);
        return {
          object: name(r),
          detail: `(${keys.join(', ')})${include.length ? ` INCLUDE (${include.join(', ')})` : ''} · ${impact != null ? `${Math.round(impact)}% less cost` : 'some cost saved'} · ${plural(uses, 'use')}`,
          fix: [fx.createIndex(r.schema, r.table, keys, include)],
        };
      }),
    unused: () =>
      rows('unused').map((r) => {
        const writes = num(r.updates);
        return {
          object: name(r),
          detail: [str(r.index), writes != null ? `${plural(writes, 'write')}, no reads` : 'no reads', kb(num(r.size_kb))].filter(Boolean).join(' · '),
          fix: [fx.dropIndex(r.schema, r.table, r.index)],
          commented: true,
        };
      }),
    duplicate: () =>
      duplicateIndexes((indexes ??= indexesOf(rows('indexes')))).map(({ index, other, same, uncovered }) => ({
        object: `${index.schema}.${index.table}`,
        detail: `${index.name} (${keyList(index)}) ${same ? 'is the same as' : 'leads'} ${other.name} (${keyList(other)})${uncovered.length ? `, but includes ${uncovered.join(', ')}, which ${other.name} hasn't` : ''}`,
        fix: [fx.dropIndex(index.schema, index.table, index.name)],
        commented: true,
      })),
    fk: () =>
      unindexedForeignKeys(foreignKeysOf(rows('foreignKeys')), (indexes ??= indexesOf(rows('indexes')))).map((fk) => ({
        object: `${fk.schema}.${fk.table}`,
        detail: `${fk.name} (${fk.columns.join(', ')}) → ${fk.refSchema}.${fk.refTable}`,
        fix: [fx.createIndex(fk.schema, fk.table, fk.columns)],
      })),
    nopk: () =>
      rows('nopk').map((r) => {
        const pk = bool(r.has_pk);
        const heap = kind === 'sqlserver' && bool(r.is_heap);
        const n = num(r.rows);
        const what = [pk ? null : 'no primary key', heap ? (pk ? 'a heap: its primary key is nonclustered' : 'a heap') : null, n != null ? plural(n, 'row') : null].filter(Boolean).join(' · ');
        // Only the column can't be guessed, so these are a start to finish by hand.
        return { object: name(r), detail: what, fix: [pk ? fx.clustered(r.schema, r.table) : fx.primaryKey(r.schema, r.table)], commented: true };
      }),
    untrusted: () =>
      rows('untrusted').map((r) => ({
        object: name(r),
        detail: `${str(r.name)} · ${str(r.kind).toLowerCase()} · ${bool(r.is_disabled) ? 'disabled' : kind === 'postgres' ? 'NOT VALID' : 'not trusted'}`,
        fix: [fx.check(r.schema, r.table, r.name)],
      })),
    stats: () =>
      rows('stats').flatMap((r) => {
        const { stale, dead } = staleness(r);
        if (!stale && !(kind === 'postgres' && dead)) return [];
        const n = num(r.rows) ?? 0;
        const days = num(r.days_since);

        const parts = [
          ...(r.name ? [str(r.name)] : []),
          ...(dead ? [`${plural(num(r.dead_rows), 'dead row')} beside ${plural(n, 'live one')}`] : []),
          ...(stale
            ? [
                days == null
                  ? `${plural(num(r.modifications), 'change')} to ${plural(n, 'row')}, and never ${kind === 'postgres' ? 'analyzed' : 'updated'}`
                  : `${plural(num(r.modifications), 'change')} to ${plural(n, 'row')} since ${kind === 'postgres' ? 'its last ANALYZE' : 'the last update'}, ${day(r.last_updated)} (${plural(days, 'day')} ago)`,
              ]
            : []),
        ];
        return [{ object: name(r), detail: parts.join(' · '), fix: [fx.stats(r.schema, r.table, dead)] }];
      }),
    triggers: () =>
      rows('triggers').map((r) => ({
        object: name(r),
        detail: str(r.name),
        fix: [fx.enableTrigger(r.schema, r.table, r.name)],
        commented: true,
      })),
  };
  const groups = CHECKS.map((c) => {
    const title = forKind(c.title, kind);
    const unavailable = forKind(c.unavailable, kind);
    const why = (forKind(c.why, kind) ?? '').replace('{since}', since ? ` (${stamp(since)})` : '');
    if (unavailable) return { id: c.id, title, why, findings: [], error: null, unavailable };
    const failed = c.reads.map((r) => results[r]).find((r) => r?.error || !r);
    if (failed) {
      // MySQL without the sys schema (MariaDB, or one dropped) can't say what's unused.
      const error = failed.error ?? "It wasn't read.";
      if (c.id === 'unused' && kind === 'mysql' && /schema_unused_indexes|doesn't exist|1146/i.test(error)) return { id: c.id, title, why, findings: [], error: null, unavailable: "This server has no sys schema (MySQL 5.7 and later have it; MariaDB doesn't), which is where MySQL says which indexes nothing reads." };
      return { id: c.id, title, why, findings: [], error, unavailable: null };
    }
    return { id: c.id, title, why, findings: find[c.id](), error: null, unavailable: null };
  });
  return { kind, restart, groups };
}

const LABELS = { sqlserver: 'SQL Server', postgres: 'PostgreSQL', mysql: 'MySQL' };

/** "9 findings in 5 checks": the activity log's line. */
export function healthSummary(report) {
  const found = report.groups.filter((g) => g.findings.length);
  const n = found.reduce((s, g) => s + g.findings.length, 0);
  const failed = report.groups.filter((g) => g.error).length;
  const head = n ? `${plural(n, 'finding')} in ${plural(found.length, 'check')}: the report is on screen.` : 'Nothing found: the report is on screen.';
  return `${head}${failed ? ` ${plural(failed, 'check')} couldn't run.` : ''}`;
}

const WIDTH = 96;

/** The viewer's report: a heading, then each check with why it matters and what it found. */
export function healthText(report, { database, conn } = {}) {
  const label = LABELS[report.kind] ?? report.kind;
  const lines = [];
  const n = report.groups.reduce((s, g) => s + g.findings.length, 0);
  const ran = report.groups.filter((g) => !g.unavailable);
  lines.push(`${database ?? 'The database'}${conn ? ` on ${conn}` : ''} (${label}): ${n ? plural(n, 'finding') : 'nothing found'}, from ${plural(ran.length, 'check')}.`);
  if (report.restart.started) lines.push(`The server started ${stamp(report.restart.started)}${report.kind === 'postgres' && report.restart.statsReset ? `; its statistics were reset ${stamp(report.restart.statsReset)}` : ''}: what's "unused" or "suggested" counts from then.`);
  lines.push('');
  for (const g of ran) {
    lines.push(`${g.title}${g.error ? ": couldn't check" : g.findings.length ? ` (${g.findings.length})` : ': none'}`);
    if (g.error) lines.push(...wrap(g.error, WIDTH - 2).map((l) => `  ${l}`));
    else if (g.findings.length) {
      lines.push(...wrap(g.why, WIDTH - 2).map((l) => `  ${l}`));
      const w = Math.min(32, Math.max(...g.findings.map((f) => stringWidth(f.object))));
      for (const f of g.findings) lines.push(`  ${fit(f.object, w)}  ${f.detail}`);
    }
    lines.push('');
  }
  const off = report.groups.filter((g) => g.unavailable);
  if (off.length) {
    lines.push(`Not checked on ${label}:`);
    for (const g of off) lines.push(...wrap(`${g.title}: ${g.unavailable}`, WIDTH - 4).map((l, i) => `${i ? '    ' : '  · '}${l}`));
    lines.push('');
  }
  if (report.groups.some((g) => g.findings.some((f) => f.fix.length))) lines.push('Nothing has changed: the fixes are only offered, as a script to read in a console tab.');
  return lines.join('\n').trimEnd();
}

/** The groups that have a fix to offer, for the question after the report. */
export const fixableGroups = (report) => report.groups.filter((g) => g.findings.some((f) => f.fix.length));

/**
 * The fix script for the groups given (ids; all of them by default): a section per check, a comment
 * per finding then its statement, each statement once. What changes behaviour (dropping an index,
 * turning a trigger on) and what is only a start (a primary key's columns) is commented out.
 */
export function healthScript(report, { groups, database, conn } = {}) {
  const want = groups ? new Set(groups) : null;
  const chosen = fixableGroups(report).filter((g) => !want || want.has(g.id));
  const pg = report.kind === 'postgres';
  const out = [
    `-- Fixes from Trawl's health check of ${database ?? 'the database'}${conn ? ` on ${conn}` : ''}. Read them through before running any.`,
    '-- Dropping an index or turning a trigger back on changes what the database does, and a primary key needs its columns chosen,',
    '-- so those lines are commented out: uncomment them on purpose.',
  ];
  if (chosen.some((g) => g.id === 'missing' || g.id === 'fk') && report.kind === 'sqlserver') out.push('-- On Enterprise edition (and Azure SQL), WITH (ONLINE = ON) builds an index without blocking the table.');
  if (chosen.some((g) => g.id === 'missing' || g.id === 'fk') && pg) out.push("-- On a busy table, CREATE INDEX CONCURRENTLY doesn't block writes (it can't run inside a transaction).");
  if (pg && chosen.some((g) => g.id === 'stats' && g.findings.some((f) => /^VACUUM/.test(f.fix[0])))) out.push("-- VACUUM can't run inside a transaction: with /tx manual, run it after a /commit, or with /tx auto.");
  out.push('');
  const seen = new Set();
  for (const g of chosen) {
    out.push(`-- ${g.title}`);
    for (const f of g.findings) {
      // A statement another check gave already (an unused index that's a duplicate too) is there once.
      const lines = f.fix.filter((l) => !seen.has(l));
      lines.forEach((l) => seen.add(l));
      out.push(`-- ${f.object}: ${f.detail}${lines.length ? '' : ' (its statement is above)'}`, ...lines.map((l) => (f.commented ? `-- ${l}` : l)));
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

// ---- /sizes

// Each table's rows and space, biggest first, in KB (buildSizes makes them MB). The last column is
// what each kind has besides data and indexes: SQL Server's reserved but unused pages, Postgres's
// TOAST and free-space and visibility maps, MySQL's free space in the tablespace.
export const SIZES_SQL = {
  // sys.partitions and sys.allocation_units, as sp_spaceused counts (rows from the heap or clustered
  // index; data is its in-row data pages plus LOB and row-overflow pages; the rest of what's used is index).
  sqlserver: `-- trawl:sizes
SELECT s.name AS [schema], o.name AS [table],
  SUM(CASE WHEN p.index_id IN (0, 1) AND a.type = 1 THEN p.rows ELSE 0 END) AS [rows],
  SUM(a.total_pages) * 8 AS reserved_kb,
  SUM(CASE WHEN p.index_id IN (0, 1) THEN CASE WHEN a.type = 1 THEN a.data_pages ELSE a.used_pages END ELSE 0 END) * 8 AS data_kb,
  (SUM(a.used_pages) - SUM(CASE WHEN p.index_id IN (0, 1) THEN CASE WHEN a.type = 1 THEN a.data_pages ELSE a.used_pages END ELSE 0 END)) * 8 AS index_kb,
  (SUM(a.total_pages) - SUM(a.used_pages)) * 8 AS unused_kb
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.partitions p ON p.object_id = o.object_id
JOIN sys.allocation_units a ON a.container_id = CASE WHEN a.type IN (1, 3) THEN p.hobt_id ELSE p.partition_id END
WHERE o.type = 'U' AND o.is_ms_shipped = 0
GROUP BY s.name, o.name
ORDER BY reserved_kb DESC, s.name, o.name;`,
  postgres: `-- trawl:sizes
SELECT n.nspname AS "schema", c.relname AS "table", CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS "rows",
  pg_total_relation_size(c.oid) / 1024 AS reserved_kb, pg_relation_size(c.oid) / 1024 AS data_kb, pg_indexes_size(c.oid) / 1024 AS index_kb,
  (pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid)) / 1024 AS toast_kb
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'm') AND ${PG_SKIP}
ORDER BY pg_total_relation_size(c.oid) DESC, 1, 2;`,
  mysql: `-- trawl:sizes
SELECT table_schema AS \`schema\`, table_name AS \`table\`, table_rows AS \`rows\`,
  (data_length + index_length) / 1024 AS reserved_kb, data_length / 1024 AS data_kb, index_length / 1024 AS index_kb, data_free / 1024 AS free_kb
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
ORDER BY data_length + index_length DESC, table_name;`,
};

// What the numbers are, under the grid.
export const SIZES_NOTE = {
  sqlserver: "Rows and space from sys.partitions and sys.allocation_units, as sp_spaceused counts them; reserved is everything allocated, unused what's allocated but empty.",
  postgres: 'rows is the planner\'s estimate (pg_class.reltuples, as of the last VACUUM or ANALYZE; empty until then). reserved is pg_total_relation_size, data the table itself, index pg_indexes_size, toast the rest (TOAST and the free-space and visibility maps).',
  mysql: "All of these are InnoDB's estimates, from information_schema.TABLES: rows can be off by half, and MySQL 8 caches them for a day (ANALYZE TABLE refreshes them). free is the free space in the table's tablespace.",
};

const mb = (v) => (v == null ? null : Math.round((Number(v) / 1024) * 100) / 100);

/** SIZES_SQL's rows as a result set for Results: numbers throughout, the KB columns as MB, biggest first. */
export function buildSizes(sets) {
  const set = sets[0];
  if (!set) return { columns: [], rows: [], truncated: false };
  const names = set.columns.map((c) => c.name);
  const isKb = names.map((n) => /_kb$/.test(n));
  const columns = names.map((n, i) => ({ name: isKb[i] ? n.replace(/_kb$/, '_mb') : n, type: i < 2 ? 'nvarchar' : isKb[i] ? 'Decimal' : 'BigInt' }));
  const rows = set.rows.map((r) => r.map((v, i) => (i < 2 ? v : isKb[i] ? mb(v) : num(v))));
  const at = names.indexOf('reserved_kb');
  if (at >= 0) rows.sort((x, y) => (y[at] ?? 0) - (x[at] ?? 0));
  return { columns, rows, truncated: false };
}
