// `trawl mcp`: Trawl as an MCP server over stdio, so Claude Code can read your databases through
// your saved connections. It only ever reads: anything the write check flags is refused, every
// query also runs inside a transaction that is rolled back, and a connection's Claude access
// level decides whether rows may be returned at all (ai.js). Each query is logged for History.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AI_LABELS, aiLevel, canSeeResults, canSeeSchema, tableLine } from './ai.js';
import { configDir, loadConfig } from './config.js';
import { DEMO_CONNECTIONS, describeConn, isReadOnly } from './connections.js';
import { connect } from './db.js';
import { buildSchema, describeObject, findObject, objectName } from './schema.js';
import { dialectOf } from './dialects.js';
import { classifyScript, formatValue } from './sql.js';
import { VERSION } from './version.js';

const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const MAX_ROWS = 1000;
const CELL = 200;

const INSTRUCTIONS = `Trawl reads SQL Server / Azure SQL (and PostgreSQL and MySQL) databases through the user's saved Trawl connections.
list_connections says which kind each is; write the SQL for that kind (TOP for SQL Server, LIMIT for the others).
Start with list_connections, then list_tables and describe_table before writing a query.
run_query only reads: writes are refused and everything runs in a transaction that is rolled back.
Some connections only share their schema; run_query says so when rows can't be returned.`;

const TOOLS = [
  {
    name: 'list_connections',
    description: 'The saved Trawl connections: name, server/database, whether it is production, and what Claude may see of it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tables',
    description: 'Tables, views and routines of a database, with approximate row counts.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name from list_connections' },
        database: { type: 'string', description: 'Another database on the same server (default: the connection’s own)' },
        filter: { type: 'string', description: 'Only names containing this text' },
      },
      required: ['connection'],
    },
  },
  {
    name: 'describe_table',
    description: 'Columns, types, nullability and primary key of a table or view.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string', description: 'schema.table, [schema].[table] or a bare name' },
        database: { type: 'string' },
      },
      required: ['connection', 'table'],
    },
  },
  {
    name: 'run_query',
    description: `Runs a read-only T-SQL query and returns the rows. Writes (INSERT, UPDATE, DELETE, DDL, EXEC of non-system procedures, SELECT INTO) are refused. At most ${MAX_ROWS} rows per result set.`,
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        sql: { type: 'string', description: 'T-SQL; use TOP to keep results small' },
        database: { type: 'string' },
        max_rows: { type: 'integer', description: `Rows per result set (default 100, at most ${MAX_ROWS})` },
      },
      required: ['connection', 'sql'],
    },
  },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

class ToolError extends Error {}

/** A result set as a plain-text table, long cells cut short. */
export function setText(set, { truncatedAt } = {}) {
  const cell = (v) => {
    const s = formatValue(v).replace(/\s+/g, ' ');
    return s.length > CELL ? `${s.slice(0, CELL)}…` : s;
  };
  const head = set.columns.map((c) => c.name);
  const rows = set.rows.map((r) => r.map(cell));
  const widths = head.map((h, i) => Math.min(60, Math.max(h.length, ...rows.map((r) => r[i].length))));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join(' | ').trimEnd();
  const out = [line(head), widths.map((w) => '-'.repeat(w)).join('-+-'), ...rows.map(line)];
  out.push(set.truncated ? `(first ${set.rows.length} rows; there are more${truncatedAt ? `, raise max_rows up to ${MAX_ROWS}` : ''})` : `(${set.rows.length} row${set.rows.length === 1 ? '' : 's'})`);
  return out.join('\n');
}

/**
 * The server's state: open sessions by connection and database, and how to log a query.
 * `options.demo` adds the demo connections; `options.log` replaces the History log (tests).
 */
export function createServer({ demo = false, log = logQuery, open = connect } = {}) {
  const sessions = new Map();

  const connections = () => {
    const saved = loadConfig().connections;
    return demo ? [...DEMO_CONNECTIONS, ...saved.filter((c) => !DEMO_CONNECTIONS.some((d) => d.name === c.name))] : saved;
  };

  const findConn = (name) => {
    const all = connections();
    const conn = all.find((c) => c.name.toLowerCase() === String(name ?? '').toLowerCase());
    if (!conn) throw new ToolError(`No connection called "${name}". Saved: ${all.map((c) => c.name).join(', ') || '(none yet; add them in Trawl)'}.`);
    if (!canSeeSchema(conn)) throw new ToolError(`${conn.name} is closed to Claude (its Claude access is "off"). In Trawl, /ai schema or /ai results opens it.`);
    return conn;
  };

  const session = async (conn, database) => {
    const key = `${conn.name}|${database ?? ''}`;
    const s = sessions.get(key);
    if (s && !s.closed) return s;
    const fresh = await open(conn, { database });
    fresh.onEnd = () => sessions.delete(key);
    sessions.set(key, fresh);
    return fresh;
  };

  // One request at a time per connection (it can't run two at once), though Claude may call
  // tools in parallel.
  const queues = new Map();
  const exclusive = (conn, database, fn) => {
    const key = `${conn.name}|${database ?? ''}`;
    const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    queues.set(key, next.catch(() => {}));
    return next;
  };

  // The catalog changes rarely, and list_tables then describe_table would read it twice.
  const schemas = new Map();
  const schemaOf = (conn, database) =>
    exclusive(conn, database, async () => {
      const key = `${conn.name}|${database ?? ''}`;
      const hit = schemas.get(key);
      if (hit && Date.now() - hit.at < 60_000) return hit;
      const read = async () => buildSchema((await (await session(conn, database)).run(dialectOf(conn).schemaSql, { limit: 1_000_000 })).sets);
      // A connection that dropped since the last call (the server closes idle ones) is opened again.
      const fresh = { at: Date.now(), schema: await read().catch((e) => (e.lost ? read() : Promise.reject(e))) };
      schemas.set(key, fresh);
      return fresh;
    });

  const tools = {
    async list_connections() {
      const all = connections();
      if (!all.length) return 'No connections are saved yet. Add them in Trawl (/add, or /import datagrip).';
      return all
        .map((c) => `${c.name}: ${describeConn(c)}${c.prod ? ', production' : ''}${isReadOnly(c) ? ', read-only' : ''}; Claude may see ${AI_LABELS[aiLevel(c)]}`)
        .join('\n');
    },
    async list_tables({ connection, database, filter }) {
      const conn = findConn(connection);
      const { schema } = await schemaOf(conn, database);
      const q = String(filter ?? '').toLowerCase();
      const objs = schema.objects.filter((o) => !q || objectName(o).toLowerCase().includes(q));
      const lines = objs.map((o) => `${objectName(o)} (${o.kind}${o.rows != null ? `, ~${o.rows} rows` : ''})`);
      return `${schema.database}: ${objs.length} of ${schema.objects.length} objects\n${lines.join('\n')}`;
    },
    async describe_table({ connection, table, database }) {
      const conn = findConn(connection);
      const { schema } = await schemaOf(conn, database);
      const o = findObject(schema, table);
      if (!o) throw new ToolError(`No table or view called ${table} in ${schema.database}. list_tables shows what there is.`);
      return `${describeObject(o, schema)}\n\nCompact: ${tableLine(o)}`;
    },
    async run_query({ connection, sql, database, max_rows }) {
      const conn = findConn(connection);
      const text = String(sql ?? '').trim();
      if (!text) throw new ToolError('The query is empty.');
      if (!canSeeResults(conn)) throw new ToolError(`${conn.name} only shares its schema with Claude, not rows. The user can allow rows in Trawl with /ai results (on that connection).`);
      const { write, danger } = classifyScript(text, { dialect: dialectOf(conn).kind });
      if (write) throw new ToolError(`Refused: this changes data or schema${danger.length ? ` (${danger.join('; ')})` : ''}. Trawl's MCP tools only read; run writes yourself in Trawl.`);
      const limit = Math.max(1, Math.min(MAX_ROWS, Number(max_rows) || 100));
      return exclusive(conn, database, () => runRead(conn, database, text, limit));
    },
  };

  // A read whose connection drops part-way runs once more on a new one: it only reads, and inside
  // a transaction that is rolled back, so running it again changes nothing.
  async function runRead(conn, database, text, limit, retried = false) {
    const s = await session(conn, database);
    const entry = { sql: text, conn: conn.name, database: s.database, at: Date.now(), via: 'claude' };
    try {
      // A second lock behind the write check: whatever runs is rolled back.
      const res = await s.run(`${dialectOf(conn).readOnlyPrefix}\n${text}`, { limit });
      const parts = res.sets.map((set, i) => `${res.sets.length > 1 ? `Result set ${i + 1}\n` : ''}${setText(set, { truncatedAt: limit })}`);
      const notes = res.messages.filter((m) => !/rows? affected$/.test(m));
      log({ ...entry, ok: true, summary: `${res.sets.map((x) => `${x.rows.length} rows`).join(' · ') || 'no rows'} · ${res.ms} ms` });
      return [...parts, ...notes].join('\n\n') || 'The query ran and returned no result set.';
    } catch (e) {
      if (e.lost && !retried) return runRead(conn, database, text, limit, true);
      // The two lines Trawl adds in front don't count.
      const message = e.line ? `Line ${Math.max(1, e.line - dialectOf(conn).readOnlyPrefix.split('\n').length)}: ${e.message}` : e.message;
      log({ ...entry, ok: false, summary: message.split('\n')[0] });
      throw new ToolError(message);
    } finally {
      if (!s.closed && (await s.tranCount().catch(() => 0))) await s.run(dialectOf(conn).rollback).catch(() => {});
    }
  }

  /** Handles one JSON-RPC message; resolves with the response, or null for a notification. */
  async function handle(msg) {
    const reply = (result) => (msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => (msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS.at(-1),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'trawl', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params ?? {};
        if (!tools[name]) return fail(-32602, `Unknown tool: ${name}`);
        try {
          return reply({ content: [{ type: 'text', text: await tools[name](args) }] });
        } catch (e) {
          // Tool failures go back to Claude as results it can read and act on.
          return reply({ content: [{ type: 'text', text: e instanceof ToolError ? e.message : `Error: ${e.message}` }], isError: true });
        }
      }
      default:
        if (msg.method?.startsWith('notifications/')) return null;
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  const close = () => {
    for (const s of sessions.values()) s.close();
    sessions.clear();
  };

  return { handle, close, tools };
}

/** Appends a query Claude ran to the log the History view shows. */
export function logQuery(entry) {
  try {
    mkdirSync(configDir(), { recursive: true });
    appendFileSync(join(configDir(), 'claude-history.jsonl'), JSON.stringify(entry) + '\n');
  } catch {
    // History is a convenience; a read-only home folder mustn't break the tools.
  }
}

/** Runs the server on stdin/stdout: one JSON-RPC message per line. Logs go to stderr only. */
export function serve({ demo = false, input = process.stdin, output = process.stdout } = {}) {
  const server = createServer({ demo });
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const res = await server.handle(msg).catch((e) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message } }));
    if (res) output.write(JSON.stringify(res) + '\n');
  });
  rl.on('close', () => {
    server.close();
    process.exit(0);
  });
  process.stderr.write(`trawl ${VERSION} MCP server ready${demo ? ' (with the demo connections)' : ''}\n`);
}

