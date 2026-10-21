// What differs between the databases Trawl talks to: SQL Server (the default, through tedious),
// PostgreSQL (pg) and MySQL (mysql2). A connection's `kind` picks one; everything here is pure text:
// quoting, TOP or LIMIT, how a transaction starts, how a script splits into statements, and the
// catalog, plan and activity queries (sessions, SQL Agent jobs, top queries), each shaped like SQL
// Server's so the same code reads them.
import { SCHEMA_SQL } from './schema.js';
import { ACTIVITY_SQL, AGENT_PROBE_SQL, JOBS_SQL, TOP_PROBE_SQL, queryStatsSql, queryStoreSql } from './activity.js';

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Text put into a query safely, each kind's own way: SQL Server's N'…', Postgres's E'…' (whose
// backslashes mean the same whatever standard_conforming_strings says), and MySQL's as hex, which no
// sql_mode (NO_BACKSLASH_ESCAPES, ANSI_QUOTES) reads differently.
const nstr = (s) => `N'${String(s).replace(/'/g, "''")}'`;
const estr = (s) => `E'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
const hexstr = (s) => `CONVERT(X'${Buffer.from(String(s), 'utf8').toString('hex')}' USING utf8mb4)`;

/**
 * `text` for LIKE '%…%' with ESCAPE '!': its own %, _ and ! (and, for SQL Server, [) matched as
 * themselves, lower-cased for a search that ignores case.
 */
export const likePattern = (text, { brackets = false } = {}) => `%${String(text).toLowerCase().replace(brackets ? /[!%_[]/g : /[!%_]/g, '!$&')}%`;

const SQLSERVER = {
  kind: 'sqlserver',
  label: 'SQL Server',
  quote: (name) => `[${String(name).replace(/]/g, ']]')}]`,
  // The first rows of `q`, those `where` (a condition) picks when it's given.
  selectTop: (q, limit, where) => `SELECT TOP (${limit}) * FROM ${q}${where ? ` WHERE ${where}` : ''}`,
  begin: 'BEGIN TRANSACTION;',
  commit: 'COMMIT TRANSACTION;',
  rollback: 'ROLLBACK TRANSACTION;',
  // Ahead of a read run in a transaction that is rolled back (fan-out, trawl mcp).
  readOnlyPrefix: 'SET XACT_ABORT ON;\nBEGIN TRANSACTION;',
  count: 'COUNT_BIG(*)',
  identity: 'IDENTITY(1,1)',
  schemaSql: SCHEMA_SQL,
  activitySql: ACTIVITY_SQL,
  kill: (id) => `KILL ${id};`,
  // SQL Agent's jobs (activity.js): the probe says whether this kind of server has the Agent at all.
  jobs: { probe: AGENT_PROBE_SQL, sql: JOBS_SQL },
  // The costliest queries: Query Store when it's on for the database, else the plan cache.
  topQueries: {
    probe: TOP_PROBE_SQL,
    plan: ({ database, store }, order) =>
      store === 'READ_ONLY' || store === 'READ_WRITE'
        ? { sql: queryStoreSql(order), source: 'query_store' }
        : {
            sql: queryStatsSql(order),
            source: 'dm_exec_query_stats',
            note: store
              ? `Query Store is ${store.toLowerCase().replace('_', ' ')} for ${database}, so this is the plan cache, since the server last restarted. ALTER DATABASE … SET QUERY_STORE = ON turns it on.`
              : `This server has no Query Store (SQL Server 2016 and later do), so this is the plan cache, since the last restart.`,
          },
  },
  // SET SHOWPLAN_TEXT and SET STATISTICS PROFILE, handled in actions.js showPlan and showActualPlan.
  explain: null,
  // /grep: the views, procedures, functions and triggers whose definition has the text in it.
  grepSql: (text) => `-- trawl:grep
SELECT s.name AS [schema], o.name, RTRIM(o.type) AS type, OBJECT_NAME(o.parent_object_id) AS parent, m.definition
FROM sys.sql_modules m
JOIN sys.objects o ON o.object_id = m.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('V', 'P', 'FN', 'IF', 'TF', 'TR') AND o.is_ms_shipped = 0
  AND LOWER(m.definition) LIKE LOWER(${nstr(likePattern(text, { brackets: true }))}) ESCAPE N'!'
ORDER BY s.name, o.name;`,
  // /uses: what refers to an object (rel 'used_by'), what it refers to ('uses'), and the triggers on
  // it ('trigger'), from the dependencies SQL Server records. A reference it couldn't bind to an id
  // (a procedure's, made before the table) is matched by its name.
  usesSql: (o) => `-- trawl:uses
DECLARE @schema sysname = ${nstr(o.schema)}, @name sysname = ${nstr(o.name)};
DECLARE @id int = OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@name));
SELECT 'used_by' AS rel, s.name AS [schema], o.name, RTRIM(o.type) AS type, OBJECT_NAME(o.parent_object_id) AS parent, CAST(NULL AS sysname) AS [database]
FROM sys.sql_expression_dependencies d
JOIN sys.objects o ON o.object_id = d.referencing_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE d.referencing_id <> @id AND (d.referenced_id = @id
  OR (d.referenced_id IS NULL AND d.referenced_database_name IS NULL AND d.referenced_entity_name = @name AND ISNULL(d.referenced_schema_name, @schema) = @schema))
UNION
SELECT 'uses', COALESCE(rs.name, d.referenced_schema_name), COALESCE(ro.name, d.referenced_entity_name), RTRIM(ro.type), NULL, d.referenced_database_name
FROM sys.sql_expression_dependencies d
LEFT JOIN sys.objects ro ON ro.object_id = d.referenced_id
LEFT JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
WHERE d.referencing_id = @id AND d.referenced_class = 1 AND ISNULL(d.referenced_id, 0) <> @id
UNION
SELECT 'trigger', s.name, t.name, 'TR', OBJECT_NAME(t.parent_id), NULL
FROM sys.triggers t
JOIN sys.objects o ON o.object_id = t.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE t.parent_id = @id
ORDER BY 1, 2, 3;`,
  // What /uses finds by the name in definitions, where the catalog doesn't say (none here).
  usesByName: null,
  // What this session's open transaction holds (transactions.js locksText): its locks in this
  // database, by object, kind of resource and mode, without the shared lock every session has on it.
  locksSql: `-- trawl:locks
SELECT object_name, resource_type, request_mode, COUNT(*) AS locks FROM (
  SELECT COALESCE(OBJECT_SCHEMA_NAME(CASE WHEN l.resource_type = 'OBJECT' THEN l.resource_associated_entity_id ELSE p.object_id END) + N'.'
      + OBJECT_NAME(CASE WHEN l.resource_type = 'OBJECT' THEN l.resource_associated_entity_id ELSE p.object_id END), l.resource_type) AS object_name,
    l.resource_type, l.request_mode
  FROM sys.dm_tran_locks l
  LEFT JOIN sys.partitions p ON p.hobt_id = l.resource_associated_entity_id AND l.resource_type IN ('KEY', 'PAGE', 'RID', 'HOBT')
  WHERE l.request_session_id = @@SPID AND l.resource_database_id = DB_ID() AND l.resource_type <> 'DATABASE'
) x
GROUP BY object_name, resource_type, request_mode
ORDER BY object_name, resource_type, request_mode;`,
  explainAnalyze: null,
  defaultPort: 1433,
};

const PG_SKIP = `('pg_catalog', 'information_schema')`;

const POSTGRES = {
  kind: 'postgres',
  label: 'PostgreSQL',
  quote: (name) => `"${String(name).replace(/"/g, '""')}"`,
  selectTop: (q, limit, where) => `SELECT * FROM ${q}${where ? ` WHERE ${where}` : ''} LIMIT ${limit}`,
  begin: 'BEGIN;',
  commit: 'COMMIT;',
  rollback: 'ROLLBACK;',
  readOnlyPrefix: 'BEGIN READ ONLY;',
  count: 'COUNT(*)',
  identity: 'GENERATED BY DEFAULT AS IDENTITY',
  schemaSql: `-- trawl:schema
SELECT current_database() AS db;
SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname;
SELECT n.nspname AS "schema", c.relname AS name, CASE WHEN c.relkind IN ('v', 'm') THEN 'V' ELSE 'U' END AS type,
  CASE WHEN c.relkind IN ('r', 'p') THEN GREATEST(c.reltuples, 0)::bigint END AS "rows"
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ${PG_SKIP} AND n.nspname NOT LIKE 'pg\\_%'
UNION ALL
SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'P' ELSE 'FN' END, NULL
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prokind IN ('f', 'p') AND n.nspname NOT IN ${PG_SKIP} AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 1, 2;
SELECT n.nspname AS "schema", c.relname AS "object", a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
  NULL AS max_length, NULL AS precision, NULL AS scale, NOT a.attnotnull AS is_nullable,
  (a.attidentity <> '' OR COALESCE(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%') AS is_identity, a.attgenerated <> '' AS is_computed,
  CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) THEN 1 ELSE 0 END AS pk
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ${PG_SKIP} AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY n.nspname, c.relname, a.attnum;
SELECT con.conname AS name, n.nspname AS "schema", c.relname AS "object", a.attname AS "column",
  rn.nspname AS ref_schema, rc.relname AS ref_object, ra.attname AS ref_column
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refnum, ord)
JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refnum
WHERE con.contype = 'f'
ORDER BY con.conname, k.ord;
SELECT r.routine_schema AS "schema", r.routine_name AS "object", p.parameter_name AS name, p.data_type AS type,
  NULL AS max_length, NULL AS precision, NULL AS scale, p.parameter_mode IN ('OUT', 'INOUT') AS is_output
FROM information_schema.routines r
JOIN information_schema.parameters p ON p.specific_schema = r.specific_schema AND p.specific_name = r.specific_name
WHERE r.routine_schema NOT IN ${PG_SKIP}
ORDER BY r.routine_schema, r.routine_name, p.ordinal_position;`,
  activitySql: `-- trawl:activity
SELECT pg_backend_pid() AS me;
SELECT pid AS session_id, usename AS login_name, COALESCE(client_hostname, client_addr::text, '') AS host_name,
  application_name AS program_name, datname AS database_name,
  CASE WHEN state = 'active' AND wait_event_type = 'Lock' THEN 'suspended' WHEN state = 'active' THEN 'running' WHEN state = 'idle' THEN 'sleeping' ELSE state END AS status,
  NULL AS command, CASE WHEN wait_event IS NOT NULL THEN wait_event_type || ':' || wait_event END AS wait_type, NULL AS wait_time,
  CASE WHEN state = 'active' THEN (EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)::bigint END AS elapsed_ms,
  (pg_blocking_pids(pid))[1] AS blocking_session_id, CASE WHEN xact_start IS NOT NULL THEN 1 ELSE 0 END AS open_transaction_count,
  NULL AS cpu_ms, NULL AS logical_reads, query_start AS last_request_start_time, query AS sql_text
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY pid;`,
  kill: (id) => `SELECT pg_terminate_backend(${id});`,
  jobs: { unavailable: 'PostgreSQL has no SQL Agent, so there are no jobs to list (pg_cron does that work there).' },
  topQueries: {
    probe: `-- trawl:top-probe
SELECT current_database() AS database_name, (SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements') AS query_store;`,
    plan: ({ database, store }, order) => {
      if (!store) return { unavailable: `pg_stat_statements isn't installed in ${database}. To have it, add pg_stat_statements to shared_preload_libraries in postgresql.conf, restart the server, then run CREATE EXTENSION pg_stat_statements; in this database.` };
      // Version 1.8 (PostgreSQL 13) split total_time into planning and execution.
      const [major, minor] = store.split('.').map(Number);
      const time = major > 1 || minor >= 8 ? 'total_exec_time' : 'total_time';
      return {
        source: 'pg_stat_statements',
        sql: `-- trawl:top-queries
SELECT * FROM (
  SELECT 'pg_stat_statements' AS source, s.queryid::text AS query_id, MIN(s.query) AS sql_text, NULL::bigint AS plans,
    SUM(s.calls) AS executions, SUM(s.${time}) AS total_ms, NULL::float8 AS cpu_ms,
    SUM(s.shared_blks_hit + s.shared_blks_read) AS logical_reads, NULL::timestamptz AS last_run
  FROM pg_stat_statements s
  WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  GROUP BY s.queryid
) q
ORDER BY COALESCE(q.${order}, 0) DESC
LIMIT 100;`,
      };
    },
  },
  explain: (sql) => `EXPLAIN ${sql.replace(/;\s*$/, '')}`,
  // A trigger has no schema of its own: it's listed in its table's. Extensions' functions are left out.
  grepSql: (text) => `-- trawl:grep
SELECT * FROM (
SELECT n.nspname AS "schema", c.relname AS name, 'V' AS type, NULL::text AS parent,
  CASE c.relkind WHEN 'm' THEN 'CREATE MATERIALIZED VIEW ' ELSE 'CREATE OR REPLACE VIEW ' END || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || E' AS\\n' || pg_get_viewdef(c.oid, true) AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('v', 'm') AND n.nspname NOT IN ${PG_SKIP} AND n.nspname NOT LIKE 'pg\\_%'
UNION ALL
SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'P' ELSE 'FN' END, NULL, pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prokind IN ('f', 'p') AND n.nspname NOT IN ${PG_SKIP} AND n.nspname NOT LIKE 'pg\\_%'
  AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.classid = 'pg_proc'::regclass AND x.objid = p.oid AND x.deptype = 'e')
UNION ALL
SELECT n.nspname, t.tgname, 'TR', c.relname, pg_get_triggerdef(t.oid, true)
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname NOT IN ${PG_SKIP} AND n.nspname NOT LIKE 'pg\\_%'
) d
WHERE d.definition ILIKE ${estr(likePattern(text))} ESCAPE '!'
ORDER BY 1, 2;`,
  // pg_depend knows what a view reads (its rewrite rule's dependencies) and the triggers on a table;
  // what a function's body uses it doesn't, so /uses finds those by name (usesByName).
  usesSql: (o) => {
    const rel = `to_regclass(${estr(`${POSTGRES.quote(o.schema)}.${POSTGRES.quote(o.name)}`)})`;
    const procs = `SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${estr(o.schema)} AND p.proname = ${estr(o.name)}`;
    return `-- trawl:uses
SELECT * FROM (
SELECT 'used_by' AS rel, vn.nspname AS "schema", v.relname AS name, 'V' AS type, NULL::text AS parent, NULL::text AS "database"
FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class JOIN pg_namespace vn ON vn.oid = v.relnamespace
WHERE d.classid = 'pg_rewrite'::regclass AND v.relkind IN ('v', 'm') AND v.oid IS DISTINCT FROM ${rel}
  AND ((d.refclassid = 'pg_class'::regclass AND d.refobjid = ${rel}) OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid IN (${procs})))
UNION
SELECT 'uses', rn.nspname, rc.relname, CASE WHEN rc.relkind IN ('v', 'm') THEN 'V' ELSE 'U' END, NULL, NULL
FROM pg_rewrite r JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid AND d.refclassid = 'pg_class'::regclass
JOIN pg_class rc ON rc.oid = d.refobjid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE r.ev_class = ${rel} AND rc.oid <> r.ev_class
UNION
SELECT 'uses', pn.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'P' ELSE 'FN' END, NULL, NULL
FROM pg_rewrite r JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid AND d.refclassid = 'pg_proc'::regclass
JOIN pg_proc p ON p.oid = d.refobjid JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE r.ev_class = ${rel} AND pn.nspname NOT IN ${PG_SKIP}
UNION
SELECT 'trigger', n.nspname, t.tgname, 'TR', c.relname, NULL
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE t.tgrelid = ${rel} AND NOT t.tgisinternal
) u
ORDER BY 1, 2, 3;`;
  },
  // The kinds whose definitions /uses reads for names: what refers to the object, and what it refers to.
  usesByName: { usedBy: ['procedure', 'function', 'trigger'], uses: ['procedure', 'function'], what: 'routines and triggers' },
  // This backend's locks, but not its own transaction id's or those this query takes on the catalog.
  locksSql: `-- trawl:locks
SELECT COALESCE(n.nspname || '.' || c.relname, l.locktype) AS object_name, l.locktype AS resource_type, l.mode AS request_mode, COUNT(*) AS locks
FROM pg_locks l
LEFT JOIN pg_class c ON c.oid = l.relation
LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE l.pid = pg_backend_pid() AND l.granted AND l.locktype NOT IN ('virtualxid', 'transactionid')
  AND COALESCE(n.nspname, '') NOT IN ('pg_catalog', 'information_schema')
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;`,
  // The actual plan: this one runs the statement (actions.js showActualPlan rolls a write back).
  explainAnalyze: (sql) => `EXPLAIN (ANALYZE, BUFFERS) ${sql.replace(/;\s*$/, '')}`,
  defaultPort: 5432,
};

const MYSQL = {
  kind: 'mysql',
  label: 'MySQL',
  quote: (name) => `\`${String(name).replace(/`/g, '``')}\``,
  selectTop: (q, limit, where) => `SELECT * FROM ${q}${where ? ` WHERE ${where}` : ''} LIMIT ${limit}`,
  begin: 'START TRANSACTION;',
  commit: 'COMMIT;',
  rollback: 'ROLLBACK;',
  readOnlyPrefix: 'START TRANSACTION READ ONLY;',
  count: 'COUNT(*)',
  identity: 'AUTO_INCREMENT',
  schemaSql: `-- trawl:schema
SELECT DATABASE() AS db;
SELECT schema_name AS name FROM information_schema.schemata ORDER BY schema_name;
SELECT table_schema AS \`schema\`, table_name AS name, CASE table_type WHEN 'VIEW' THEN 'V' ELSE 'U' END AS type, table_rows AS \`rows\`
FROM information_schema.tables WHERE table_schema = DATABASE()
UNION ALL
SELECT routine_schema, routine_name, CASE routine_type WHEN 'PROCEDURE' THEN 'P' ELSE 'FN' END, NULL
FROM information_schema.routines WHERE routine_schema = DATABASE()
ORDER BY 1, 2;
SELECT table_schema AS \`schema\`, table_name AS \`object\`, column_name AS name, column_type AS type,
  NULL AS max_length, NULL AS \`precision\`, NULL AS scale, is_nullable = 'YES' AS is_nullable,
  extra LIKE '%auto_increment%' AS is_identity, (extra LIKE '%VIRTUAL%' OR extra LIKE '%STORED%' OR extra LIKE '%PERSISTENT%') AS is_computed,
  column_key = 'PRI' AS pk
FROM information_schema.columns WHERE table_schema = DATABASE()
ORDER BY table_name, ordinal_position;
SELECT constraint_name AS name, table_schema AS \`schema\`, table_name AS \`object\`, column_name AS \`column\`,
  referenced_table_schema AS ref_schema, referenced_table_name AS ref_object, referenced_column_name AS ref_column
FROM information_schema.key_column_usage
WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL
ORDER BY constraint_name, ordinal_position;
SELECT specific_schema AS \`schema\`, specific_name AS \`object\`, parameter_name AS name, data_type AS type,
  NULL AS max_length, NULL AS \`precision\`, NULL AS scale, parameter_mode IN ('OUT', 'INOUT') AS is_output
FROM information_schema.parameters
WHERE specific_schema = DATABASE() AND ordinal_position > 0
ORDER BY specific_name, ordinal_position;`,
  activitySql: `-- trawl:activity
SELECT CONNECTION_ID() AS me;
SELECT id AS session_id, user AS login_name, host AS host_name, NULL AS program_name, db AS database_name,
  CASE WHEN command = 'Sleep' THEN 'sleeping' WHEN state LIKE '%lock%' THEN 'suspended' ELSE 'running' END AS status,
  command, state AS wait_type, NULL AS wait_time, CASE WHEN command <> 'Sleep' THEN time * 1000 END AS elapsed_ms,
  NULL AS blocking_session_id, 0 AS open_transaction_count, NULL AS cpu_ms, NULL AS logical_reads,
  NULL AS last_request_start_time, info AS sql_text
FROM information_schema.processlist
ORDER BY id;`,
  kill: (id) => `KILL ${id};`,
  jobs: { unavailable: 'MySQL has no SQL Agent, so there are no jobs to list (its event scheduler does that work there).' },
  topQueries: {
    probe: `-- trawl:top-probe
SELECT DATABASE() AS database_name, @@performance_schema AS query_store;`,
    plan: ({ store }, order) =>
      String(store) !== '1'
        ? { unavailable: 'performance_schema is off on this server. To have it, set performance_schema = ON in my.cnf (my.ini on Windows) and restart the server.' }
        : {
            source: 'performance_schema',
            sql: `-- trawl:top-queries
SELECT * FROM (
  SELECT 'performance_schema' AS source, DIGEST AS query_id, DIGEST_TEXT AS sql_text, NULL AS plans,
    COUNT_STAR AS executions, SUM_TIMER_WAIT / 1000000000 AS total_ms, NULL AS cpu_ms,
    SUM_ROWS_EXAMINED AS logical_reads, LAST_SEEN AS last_run
  FROM performance_schema.events_statements_summary_by_digest
  WHERE SCHEMA_NAME = DATABASE()
) q
ORDER BY COALESCE(q.${order}, 0) DESC
LIMIT 100;`,
          },
  },
  explain: (sql) => `EXPLAIN ${sql.replace(/;\s*$/, '')}`,
  // information_schema has the bodies only (no CREATE line): a view's SELECT, a routine's BEGIN … END.
  grepSql: (text) => `-- trawl:grep
SELECT * FROM (
SELECT routine_schema AS \`schema\`, routine_name AS name, CASE routine_type WHEN 'PROCEDURE' THEN 'P' ELSE 'FN' END AS type, NULL AS parent, routine_definition AS definition
FROM information_schema.routines WHERE routine_schema = DATABASE()
UNION ALL
SELECT table_schema, table_name, 'V', NULL, view_definition FROM information_schema.views WHERE table_schema = DATABASE()
UNION ALL
SELECT trigger_schema, trigger_name, 'TR', event_object_table, action_statement FROM information_schema.triggers WHERE trigger_schema = DATABASE()
) d
WHERE LOWER(d.definition) LIKE LOWER(${hexstr(likePattern(text))}) ESCAPE '!'
ORDER BY 1, 2;`,
  // Only the triggers on a table come from the catalog; the rest /uses finds by name.
  usesSql: (o) => `-- trawl:uses
SELECT 'trigger' AS rel, trigger_schema AS \`schema\`, trigger_name AS name, 'TR' AS type, event_object_table AS parent, NULL AS \`database\`
FROM information_schema.triggers
WHERE event_object_schema = ${hexstr(o.schema)} AND event_object_table = ${hexstr(o.name)}
ORDER BY trigger_name;`,
  usesByName: { usedBy: ['view', 'procedure', 'function', 'trigger'], uses: ['view', 'procedure', 'function'], what: 'views, routines and triggers' },
  // InnoDB's locks for this connection, from performance_schema.data_locks (MySQL 8.0 and later).
  locksSql: `-- trawl:locks
SELECT CONCAT(l.OBJECT_SCHEMA, '.', l.OBJECT_NAME) AS object_name, l.LOCK_TYPE AS resource_type, l.LOCK_MODE AS request_mode, COUNT(*) AS locks
FROM performance_schema.data_locks l
JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID
WHERE t.PROCESSLIST_ID = CONNECTION_ID()
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;`,
  locksUnavailable: 'MySQL keeps them in performance_schema.data_locks from 8.0 on; this server or login has no such table, so they can’t be listed.',
  // MySQL 8.0.18 and later; MariaDB has ANALYZE instead.
  explainAnalyze: (sql) => `EXPLAIN ANALYZE ${sql.replace(/;\s*$/, '')}`,
  defaultPort: 3306,
};

export const DIALECTS = { sqlserver: SQLSERVER, postgres: POSTGRES, mysql: MYSQL };

// What /add --kind takes, and the names DataGrip and people use for them.
const ALIASES = { sqlserver: 'sqlserver', mssql: 'sqlserver', azure: 'sqlserver', postgres: 'postgres', postgresql: 'postgres', pg: 'postgres', mysql: 'mysql', mariadb: 'mysql' };

/** The kind a name means ("pg", "postgresql", "mariadb"…), or null. */
export const kindOf = (name) => ALIASES[String(name ?? '').toLowerCase()] ?? null;

/** The dialect of a connection (or of a session, by its connection): SQL Server unless `kind` says otherwise. */
export function dialectOf(connOrSession) {
  const conn = connOrSession?.conn ?? connOrSession;
  return DIALECTS[kindOf(conn?.kind)] ?? SQLSERVER;
}

/** schema.name quoted the dialect's way: [dbo].[T], "public"."t", `shop`.`t`. */
export const qualifiedFor = (dialect, schema, name) => `${dialect.quote(schema)}.${dialect.quote(name)}`;

/** The first rows of a table, the dialect's way. */
export const selectTopFor = (dialect, schema, name, limit) => `${dialect.selectTop(qualifiedFor(dialect, schema, name), limit)};`;

/** The query that reads a view's, procedure's or function's own CREATE text, for Postgres and MySQL. */
export function definitionSqlFor(dialect, o) {
  if (dialect.kind === 'postgres') {
    const q = sq(`${dialect.quote(o.schema)}.${dialect.quote(o.name)}`);
    if (o.kind === 'view') return `SELECT 'CREATE OR REPLACE VIEW ' || ${sq(qualifiedFor(dialect, o.schema, o.name))} || E' AS\\n' || pg_get_viewdef(${q}::regclass, true) AS definition;`;
    if (o.kind === 'trigger') return `SELECT pg_get_triggerdef(t.oid, true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${sq(o.schema)} AND t.tgname = ${sq(o.name)} AND NOT t.tgisinternal LIMIT 1;`;
    return `SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${sq(o.schema)} AND p.proname = ${sq(o.name)} LIMIT 1;`;
  }
  const what = { view: 'VIEW', procedure: 'PROCEDURE', trigger: 'TRIGGER' }[o.kind] ?? 'FUNCTION';
  return `SHOW CREATE ${what} ${qualifiedFor(dialect, o.schema, o.name)};`;
}

/**
 * Splits a Postgres or MySQL script into the statements a driver sends one at a time: at each `;`
 * outside comments, strings, quoted names and (Postgres) $tag$ bodies. MySQL's # comments and
 * backslash escapes count too. Each is { text, line, repeat: 1 }, as splitBatches gives SQL Server's.
 */
export function splitScript(text, dialect) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const mysql = dialect.kind === 'mysql';
  const out = [];
  let start = 0;
  let i = 0;
  const flush = (end) => {
    const piece = src.slice(start, end);
    const code = piece.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|;/g, '').trim();
    if (code && !(mysql && /^(#[^\n]*\s*)+$/.test(code))) {
      const lead = piece.search(/\S/);
      out.push({ text: piece.trim().replace(/;$/, '').trim(), line: src.slice(0, start + lead).split('\n').length, repeat: 1 });
    }
    start = end;
  };
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if ((ch === '-' && next === '-') || (mysql && ch === '#')) {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
    } else if (ch === '/' && next === '*') {
      let depth = 0;
      while (i < src.length) {
        if (src[i] === '/' && src[i + 1] === '*') (depth++, (i += 2));
        else if (src[i] === '*' && src[i + 1] === '/') {
          i += 2;
          if (!--depth || mysql) break;
        } else i++;
      }
    } else if (ch === "'" || ch === '"' || (mysql && ch === '`')) {
      let j = i + 1;
      while (j < src.length) {
        if (mysql && src[j] === '\\') j += 2;
        else if (src[j] === ch && src[j + 1] === ch) j += 2;
        else if (src[j] === ch) break;
        else j++;
      }
      i = j + 1;
    } else if (!mysql && ch === '$') {
      const tag = src.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
      if (tag && !/[\w$]/.test(src[i - 1] ?? '')) {
        const end = src.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? src.length : end + tag[0].length;
      } else i++;
    } else if (ch === ';') {
      i++;
      flush(i);
    } else i++;
  }
  flush(src.length);
  return out;
}
