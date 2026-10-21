// /deadlocks: the server's recent deadlocks, each drawn as a small tree of who waited for whom, as
// Activity draws its blocking chains. SQL Server keeps them in the system_health Extended Events
// session (its .xel files, else its ring buffer) as deadlock graphs, XML that this parses with
// regexes (it's machine-written and regular, as DataGrip's files are); Azure SQL Database keeps them
// in master; MySQL has only the latest, in SHOW ENGINE INNODB STATUS, as text; Postgres writes them
// to its server log, where SQL can't read them. Pure, apart from the SQL it hands the session.
import { duration } from './activity.js';

const rowsOf = (set) => (set ? set.rows.map((row) => Object.fromEntries(set.columns.map((c, i) => [c.name, row[i]]))) : []);
const num = (v) => (v == null || v === '' ? null : Number(v));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Which kind of SQL Server, and where you are: Azure SQL Database (5) keeps them in master.
export const DEADLOCK_PROBE_SQL = `-- trawl:deadlocks-probe
SELECT CONVERT(int, SERVERPROPERTY('EngineEdition')) AS engine_edition, DB_NAME() AS database_name;`;

// system_health's files keep days of them; its ring buffer only the last few megabytes of events.
export const DEADLOCK_FILE_SQL = `-- trawl:deadlocks file
SELECT CONVERT(nvarchar(max), event_data) AS event_xml
FROM sys.fn_xe_file_target_read_file(N'system_health*.xel', NULL, NULL, NULL)
WHERE object_name = N'xml_deadlock_report';`;

export const DEADLOCK_RING_SQL = `-- trawl:deadlocks ring
SELECT CONVERT(nvarchar(max), e.x.query('.')) AS event_xml
FROM (
  SELECT CAST(t.target_data AS xml) AS data
  FROM sys.dm_xe_session_targets t
  JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
  WHERE s.name = N'system_health' AND t.target_name = N'ring_buffer'
) r
CROSS APPLY r.data.nodes('RingBufferTarget/event[@name="xml_deadlock_report"]') AS e(x);`;

// Azure SQL Database, in master: every database on the logical server's deadlocks, as Microsoft's
// "Analyze and prevent deadlocks" page reads them.
export const DEADLOCK_AZURE_SQL = `-- trawl:deadlocks azure
SELECT CONVERT(nvarchar(max), event_data) AS event_xml
FROM sys.fn_xe_telemetry_blob_target_read_file('dl', NULL, NULL, NULL)
WHERE object_name = N'database_xml_deadlock_report';`;

export const SOURCES = {
  file: "system_health's event files",
  ring: "system_health's ring buffer",
  azure: "Azure SQL Database's deadlock telemetry (master's sys.fn_xe_telemetry_blob_target_read_file)",
  innodb: 'SHOW ENGINE INNODB STATUS, which keeps only the latest',
};

/**
 * Where to read them, from the probe's row: { sources: [{ id, sql, parse }] } in the order to try,
 * or { unavailable } saying why there's nothing to read here.
 */
export function sqlServerDeadlockPlan(probe) {
  const edition = num(probe?.engine_edition);
  if (edition === 5) {
    if (String(probe?.database_name ?? '').toLowerCase() !== 'master') {
      return { unavailable: "Azure SQL Database has no system_health session to read; it keeps the deadlocks of every database on the server in master. /use master, then /deadlocks again." };
    }
    return { sources: [{ id: 'azure', sql: DEADLOCK_AZURE_SQL, parse: 'xml' }] };
  }
  return { sources: [{ id: 'file', sql: DEADLOCK_FILE_SQL, parse: 'xml' }, { id: 'ring', sql: DEADLOCK_RING_SQL, parse: 'xml' }] };
}

// Postgres only counts them (pg_stat_database), so the probe is the count.
export const PG_DEADLOCK_PROBE_SQL = `-- trawl:deadlocks-probe
SELECT current_database() AS database_name, deadlocks, stats_reset FROM pg_stat_database WHERE datname = current_database();`;

export function postgresDeadlockPlan(probe) {
  const n = num(probe?.deadlocks);
  const since = probe?.stats_reset instanceof Date ? ` since ${probe.stats_reset.toISOString().slice(0, 10)}` : '';
  const counted = n != null ? ` pg_stat_database counts ${plural(n, 'deadlock')} in ${probe.database_name}${since}.` : '';
  return {
    unavailable: `PostgreSQL writes deadlocks only to its server log ("ERROR: deadlock detected", with each process's query in the DETAIL), where SQL can't read them back.${counted} log_lock_waits = on logs the lock waits that lead up to them too.`,
  };
}

export const MYSQL_DEADLOCK_SQL = `-- trawl:deadlocks innodb
SHOW ENGINE INNODB STATUS`;

export const mysqlDeadlockPlan = () => ({ sources: [{ id: 'innodb', sql: MYSQL_DEADLOCK_SQL, parse: 'innodb' }] });

// ---- SQL Server's deadlock graph

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const unescapeXml = (s) =>
  String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m)));

const attrs = (s) => Object.fromEntries([...String(s ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], unescapeXml(m[2])]));
const tidy = (s) => unescapeXml(s).replace(/\r\n?/g, '\n').replace(/^\s*\n|\s+$/g, '').replace(/^\s+/, '');

// The lock kinds a deadlock graph's resource list has, as SQL Server's own lock names say them.
const RESOURCE_KINDS = {
  keylock: 'KEY',
  pagelock: 'PAGE',
  ridlock: 'RID',
  objectlock: 'OBJECT',
  hobtlock: 'HOBT',
  extentlock: 'EXTENT',
  databaselock: 'DATABASE',
  filelock: 'FILE',
  allocunitlock: 'ALLOCATION_UNIT',
  applicationlock: 'APPLICATION',
  metadatalock: 'METADATA',
  exchangeEvent: 'parallel exchange',
  threadpool: 'worker threads',
  resourceWait: 'memory grant',
};

function resourceLabel(tag, a) {
  const kind = RESOURCE_KINDS[tag] ?? tag;
  const object = a.objectname ?? a.objectName ?? (a.subresource ? `${a.subresource}` : '');
  const where = tag === 'pagelock' && a.pageid ? ` page ${a.fileid ?? '?'}:${a.pageid}` : tag === 'ridlock' && a.pageid ? ` ${a.fileid ?? '?'}:${a.pageid}` : '';
  const index = a.indexname ? ` (${a.indexname})` : '';
  const app = tag === 'applicationlock' && a.resource ? ` ${a.resource}` : '';
  return `${kind}${object ? ` ${object}` : ''}${index}${where}${app}`.trim();
}

/**
 * One deadlock event (system_health's xml_deadlock_report, or Azure's database_xml_deadlock_report)
 * as { at, database, victims, processes, resources }, or null when it has no deadlock graph. A
 * process is { id, spid, ecid, login, host, app, database, lockMode, waitResource, waitMs, isolation,
 * tranCount, tranName, procedure, statement, batch }; a resource { kind, label, owners, waiters },
 * each owner and waiter { id, mode }.
 */
export function parseDeadlockXml(xml) {
  const text = String(xml ?? '');
  const graph = text.match(/<deadlock\b[^>]*>([\s\S]*?)<\/deadlock>/);
  if (!graph) return null;
  const ts = text.match(/<event\b[^>]*\btimestamp="([^"]+)"/)?.[1];
  const at = ts ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(ts) ? ts : `${ts}Z`) : null;
  const dbName = text.match(/<data\s+name="database_name"\s*>[\s\S]*?<value>([^<]*)<\/value>/)?.[1];
  const body = graph[1];
  const victims = [...body.matchAll(/<victimProcess\s+id="([^"]+)"/g)].map((m) => m[1]);
  const list = body.match(/<process-list>([\s\S]*?)<\/process-list>/)?.[1] ?? '';
  const processes = [...list.matchAll(/<process\s([^>]*?)(?:\/>|>([\s\S]*?)<\/process>)/g)].map((m) => {
    const a = attrs(m[1]);
    const inner = m[2] ?? '';
    const frames = [...inner.matchAll(/<frame\s([^>]*?)(?:\/>|>([\s\S]*?)<\/frame>)/g)].map((f) => ({ ...attrs(f[1]), text: tidy(f[2] ?? '') }));
    const proc = frames.find((f) => f.procname && !/^(adhoc|unknown)$/i.test(f.procname))?.procname ?? null;
    const batch = tidy(inner.match(/<inputbuf>([\s\S]*?)<\/inputbuf>/)?.[1] ?? '');
    return {
      id: a.id,
      spid: num(a.spid),
      ecid: num(a.ecid) ?? 0,
      login: a.loginname ?? '',
      host: a.hostname ?? '',
      app: a.clientapp ?? '',
      database: a.currentdbname ?? '',
      lockMode: a.lockMode ?? '',
      waitResource: a.waitresource ?? '',
      waitMs: num(a.waittime),
      isolation: (a.isolationlevel ?? '').replace(/\s*\(\d+\)$/, ''),
      tranCount: num(a.trancount),
      tranName: a.transactionname ?? '',
      procedure: proc,
      // A frame whose text the server no longer had says "unknown".
      statement: frames.find((f) => f.text && f.text !== 'unknown')?.text ?? '',
      batch,
    };
  });
  const resList = body.match(/<resource-list>([\s\S]*?)<\/resource-list>/)?.[1] ?? '';
  const resources = [...resList.matchAll(/<(\w+)\s([^>]*?)>([\s\S]*?)<\/\1>/g)].map((m) => {
    const a = attrs(m[2]);
    const people = (tag) => [...m[3].matchAll(new RegExp(`<${tag}\\s([^>]*?)\\/?>`, 'g'))].map((x) => attrs(x[1])).map((x) => ({ id: x.id, mode: x.mode ?? '' }));
    return { kind: m[1], label: resourceLabel(m[1], a), mode: a.mode ?? '', owners: people('owner'), waiters: people('waiter') };
  });
  return { at, database: dbName ? unescapeXml(dbName) : null, victims, processes, resources };
}

/** The deadlock events' rows (event_xml), parsed, newest first. */
export function buildDeadlocks(sets) {
  return rowsOf(sets[0])
    .map((r) => parseDeadlockXml(r.event_xml))
    .filter(Boolean)
    .sort((x, y) => (y.at?.getTime() ?? 0) - (x.at?.getTime() ?? 0));
}

// ---- MySQL's InnoDB monitor

const unquote = (s) => String(s).replace(/`((?:[^`]|``)*)`/g, (m, n) => n.replace(/``/g, '`'));

// A lock line of the monitor's: where it is (`base`), its label and the mode.
function innodbLock(line) {
  let m = line.match(/^RECORD LOCKS space id (\d+) page no (\d+) .*?index (\S+) of table (\S+) trx id \d+ lock[_ ]mode (.*?)(?: waiting)?$/);
  if (m) return { base: `${m[4]}|${m[3]}|${m[1]}:${m[2]}`, label: `RECORD ${unquote(m[4])} (${unquote(m[3])}) page ${m[1]}:${m[2]}`, mode: m[5].trim(), heaps: [] };
  m = line.match(/^TABLE LOCK table (\S+) trx id \d+ lock[_ ]mode (.*?)(?: waiting)?$/);
  if (m) return { base: m[1], label: `TABLE ${unquote(m[1])}`, mode: m[2].trim(), heaps: [] };
  return null;
}

/**
 * SHOW ENGINE INNODB STATUS's text: its LATEST DETECTED DEADLOCK section as a deadlock, in the same
 * shape as parseDeadlockXml's (the transactions are processes 1, 2…), in a list of one; or none.
 * `at` is the server's clock, as the text gives it. A lock waited for is held by whoever holds a
 * lock on the same page of the same index with one of the same records (heap numbers) in it.
 */
export function parseInnodbDeadlock(status) {
  const text = String(status ?? '').replace(/\r\n?/g, '\n');
  const section = text.match(/-{4,}\nLATEST DETECTED DEADLOCK\n-{4,}\n([\s\S]*?)(?=\n-{4,}\n[A-Z][A-Z /]+\n-{4,}\n|$)/)?.[1];
  if (!section) return [];
  const lines = section.split('\n');
  const at = lines[0].match(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/)?.[0] ?? null;
  const processes = new Map();
  const locks = [];
  const victims = [];
  const proc = (id) => {
    if (!processes.has(id)) processes.set(id, { id, spid: null, ecid: 0, login: '', host: '', app: '', database: '', lockMode: '', waitResource: '', waitMs: null, isolation: '', tranCount: null, tranName: '', procedure: null, statement: '', batch: '', active: '' });
    return processes.get(id);
  };
  let current = null;
  let part = null;
  let query = null;
  for (const line of lines.slice(1)) {
    let m;
    if ((m = line.match(/^\*\*\* \((\d+)\) (TRANSACTION|HOLDS THE LOCK\(S\)|WAITING FOR THIS LOCK TO BE GRANTED):/))) {
      current = proc(m[1]);
      part = m[2] === 'TRANSACTION' ? 'tran' : m[2].startsWith('HOLDS') ? 'holds' : 'waits';
      query = null;
      continue;
    }
    if ((m = line.match(/^\*\*\* WE ROLL BACK TRANSACTION \((\d+)\)/))) {
      victims.push(m[1]);
      current = null;
      continue;
    }
    if (!current) continue;
    if (part === 'tran') {
      if ((m = line.match(/^TRANSACTION \S+, (ACTIVE .*)$/))) current.active = m[1].trim();
      else if ((m = line.match(/^MySQL thread id (\d+),.*?query id \d+ (\S+)(?: (\S+))?/))) {
        current.spid = Number(m[1]);
        current.host = m[2] ?? '';
        current.login = m[3] ?? '';
        query = [];
      } else if (query) {
        query.push(line);
        current.statement = query.join('\n').trim();
      }
      continue;
    }
    if ((m = line.match(/^Record lock, heap no (\d+)/))) {
      locks.at(-1)?.heaps.push(Number(m[1]));
      continue;
    }
    const lock = innodbLock(line.trim());
    if (lock) locks.push({ ...lock, id: current.id, holds: part === 'holds' });
  }
  const overlap = (a, b) => a.base === b.base && (!a.heaps.length || !b.heaps.length || a.heaps.some((h) => b.heaps.includes(h)));
  const heapsText = (l) => (l.heaps.length ? ` heap no ${l.heaps.join(', ')}` : '');
  const resources = [];
  for (const w of locks.filter((l) => !l.holds)) {
    const owners = locks.filter((h) => h.holds && h.id !== w.id && overlap(h, w)).map((h) => ({ id: h.id, mode: h.mode }));
    resources.push({ kind: 'innodb', label: `${w.label}${heapsText(w)}`, mode: '', owners, waiters: [{ id: w.id, mode: w.mode }] });
    const p = proc(w.id);
    p.lockMode = w.mode;
    p.waitResource = `${w.label}${heapsText(w)}`;
  }
  // Before MySQL 8.0.18 the monitor says what the second transaction holds but not the first's:
  // the one waited for is then the other transaction, as far as anyone can tell.
  const all = [...processes.values()];
  for (const r of resources) {
    if (r.owners.length || all.length !== 2) continue;
    const other = all.find((p) => p.id !== r.waiters[0].id);
    if (other) r.owners.push({ id: other.id, mode: '?' });
  }
  if (!all.length) return [];
  return [{ at, database: null, victims, processes: all, resources }];
}

/** SHOW ENGINE INNODB STATUS's row (Type, Name, Status) as deadlocks. */
export const buildInnodbDeadlocks = (sets) => parseInnodbDeadlock(rowsOf(sets[0])[0]?.Status ?? rowsOf(sets[0])[0]?.status ?? '');

// ---- Showing them

/** When it happened: system_health's times are UTC; MySQL's are the server's clock, as it wrote them. */
export const deadlockTime = (d) => (d.at instanceof Date && !Number.isNaN(d.at.getTime()) ? `${d.at.toISOString().slice(0, 19).replace('T', ' ')} UTC` : (d.at ?? 'at an unknown time'));

const who = (p) => (p ? `${p.spid != null ? `session ${p.spid}` : `transaction ${p.id}`}${p.ecid ? ` (thread ${p.ecid})` : ''}` : 'an unknown session');

/** The tables and indexes a deadlock was over, for the list: "dbo.Clubs, dbo.Players". */
function objects(d) {
  const names = d.resources.map((r) => r.label.replace(/^(KEY|PAGE|RID|OBJECT|HOBT|RECORD|TABLE) /, '').replace(/ \(.*$| page .*$/, '')).filter((s) => s && !/^(parallel|worker|memory)/.test(s));
  return [...new Set(names)];
}

/** One line for the list: the victim, how many took part, and over what. */
export function deadlockSummary(d) {
  const byId = new Map(d.processes.map((p) => [p.id, p]));
  const victims = d.victims.map((v) => who(byId.get(v))).join(', ');
  const sessions = new Set(d.processes.map((p) => p.spid ?? p.id)).size;
  return [victims ? `victim ${victims}` : 'no victim named', plural(sessions, 'session'), objects(d).join(', ')].filter(Boolean).join(' · ');
}

/**
 * The viewer's text for one deadlock: who waited for whom as a tree from the victim (each line under
 * the one whose lock it wanted, until the circle closes), then each session's SQL, then the locks.
 */
export function deadlockText(d) {
  const byId = new Map(d.processes.map((p) => [p.id, p]));
  const victims = new Set(d.victims);
  const out = [];
  const where = d.database ?? d.processes.find((p) => p.database)?.database;
  const sessions = new Set(d.processes.map((p) => p.spid ?? p.id)).size;
  out.push(`Deadlock ${deadlockTime(d)}${where ? ` in ${where}` : ''}: ${plural(sessions, 'session')}, ${d.victims.length ? `${d.victims.map((v) => who(byId.get(v))).join(' and ')} chosen as the victim (rolled back)` : 'no victim named'}.`, '');
  // What each process waits for: the resources it's a waiter on, and who holds them.
  const waits = (id) =>
    d.resources.flatMap((r) => {
      const w = r.waiters.find((x) => x.id === id);
      return w ? [{ r, mode: w.mode, holders: r.owners.filter((o) => o.id !== id) }] : [];
    });
  const seen = new Set();
  const describe = (p) => [p.login && `${p.login}${p.host ? ` on ${p.host}` : ''}`, p.app].filter(Boolean).join(' · ');
  const walk = (id, depth) => {
    const p = byId.get(id);
    const lead = depth ? `${'  '.repeat(depth)}└ ` : '';
    const pad = ' '.repeat(2 * depth + 4);
    if (seen.has(id)) return void out.push(`${lead}${who(p)}: back to the start, so neither can go on`);
    seen.add(id);
    const mark = victims.has(id) ? '✗ ' : depth ? '' : '  ';
    out.push(`${lead}${mark}${who(p)}${describe(p) ? ` · ${describe(p)}` : ''}${victims.has(id) ? ' · the victim' : ''}`);
    const ws = waits(id);
    for (const w of ws) out.push(`${pad}wants ${w.mode || 'a lock'} on ${w.r.label}${w.holders.length ? `, which ${w.holders.map((h) => `${who(byId.get(h.id))} holds${h.mode && h.mode !== '?' ? ` (${h.mode})` : ''}`).join(' and ')}` : ''}`);
    for (const w of ws) for (const h of w.holders) walk(h.id, depth + 1);
  };
  const start = [...d.victims, ...d.processes.map((p) => p.id)];
  for (const id of start) if (!seen.has(id) && byId.has(id)) walk(id, 0);
  out.push('', 'Sessions');
  for (const p of d.processes) {
    const facts = [victims.has(p.id) ? 'the victim' : null, p.isolation, p.tranCount ? plural(p.tranCount, 'open transaction') : null, p.waitMs != null ? `waited ${duration(p.waitMs)}` : null, p.active || null, p.database || null, p.procedure ? `in ${p.procedure}` : null].filter(Boolean);
    out.push(`  ${who(p)}${facts.length ? ` · ${facts.join(' · ')}` : ''}`);
    const sql = p.statement || p.batch;
    out.push(...(sql ? sql.split('\n').map((l) => `      ${l}`) : ['      (no SQL text)']));
    if (p.statement && p.batch && p.batch !== p.statement) out.push('    in the batch:', ...p.batch.split('\n').map((l) => `      ${l}`));
  }
  if (d.resources.length) {
    out.push('', 'Locks');
    for (const r of d.resources) {
      const held = r.owners.map((o) => `${who(byId.get(o.id))} holds ${o.mode && o.mode !== '?' ? o.mode : 'it'}`);
      const wanted = r.waiters.map((w) => `${who(byId.get(w.id))} wants ${w.mode || 'it'}`);
      out.push(`  ${r.label}: ${[...held, ...wanted].join(' · ') || 'nobody listed'}`);
    }
  }
  return out.join('\n');
}
