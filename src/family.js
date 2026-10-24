// What the sibling apps (splice, trawl, sonar, bosun, hail) share about each other: what one copies
// for another, the project a folder is and what it points at, the mascots' moods, and what each app
// did. The same file in every app (scripts/shared-check.js), so it names no app as "this".
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const FAMILY = ['splice', 'trawl', 'sonar', 'bosun', 'hail'];

/** What each app is for, in a picker's words. */
export const ROLES = { splice: 'git', trawl: 'SQL', sonar: 'Azure', bosun: 'processes', hail: 'HTTP' };

// ---------------------------------------------------------------------------------------------------
// Sharing: what one app hands another is a command line, copied for you to paste into the other app's
// prompt and run there: a plain command where one says it (`/azure-sql …`, `/blame src/a.js:42`), else
// `/take <context>`, a thing under one app's cursor in one word. Nothing secret ever goes into one:
// the receiving app fetches a secret itself.

/** An argument as the prompts' splitArgs reads it back: quoted only when it has to be. */
export function quoteArg(arg) {
  const s = String(arg);
  return s && /^[^\s"\\]+$/.test(s) ? s : `"${s.replace(/["\\]/g, '\\$&')}"`;
}

/** Splits command arguments on spaces, keeping "quoted parts" together (\ escapes inside them). */
export function splitArgs(s) {
  const out = [];
  for (const m of String(s ?? '').matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}

/**
 * A path argument as a command takes it: one a sibling quoted with quoteArg (spaces, Windows
 * backslashes) comes back as it was; a path typed in quotes by hand, with lone backslashes in it,
 * just loses the quotes.
 */
export function pathArg(text) {
  const s = String(text ?? '').trim();
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (!m) return s;
  return /^(?:[^\\]|\\[\\"])*$/.test(m[1]) ? m[1].replace(/\\(.)/g, '$1') : m[1];
}

/** The command line `/command args…`, to paste into another app's prompt. */
export const shareLine = (command, args = []) => [`/${command}`, ...args.map(quoteArg)].join(' ');

/** `/take <context>`: a context as a command line every app's prompt takes. */
export const takeLine = (kind, data) => shareLine('take', [encodeContext(kind, data)]);

/** The context in what was typed at a prompt (`/take family:v1:…`, or the context alone), or null. */
export const contextIn = (line) => decodeContext(String(line ?? '').trim().replace(/^\/?take\s+/, ''));

/** The apps' names as they're written, and their mascots'. */
export const APP_NAMES = { splice: 'Splice', trawl: 'Trawl', sonar: 'Sonar', bosun: 'Bosun', hail: 'Hail' };
export const PET_NAMES = { splice: 'Twig', trawl: 'Glim', sonar: 'Ping', bosun: 'Squawk', hail: 'Hoot' };

/** Which apps take each kind of context with /take. */
export const TAKEN_BY = {
  exception: ['splice', 'sonar', 'bosun'],
  request: ['hail'],
  rows: ['trawl', 'hail'],
  query: ['trawl'],
  commit: ['splice', 'sonar'],
  file: ['splice'],
  logline: ['sonar', 'hail', 'bosun'],
};

const either = (apps) => apps.map((a) => APP_NAMES[a] ?? a).join(' or ');

/** The log line for a share copied for `apps` (one app or a list), with the line or the context's description. */
export function copiedNote(apps, line) {
  const list = [].concat(apps);
  const what = contextIn(line) ? describeContext(contextIn(line)) : line;
  return `Copied for ${either(list)}: paste it into ${list.length === 1 ? `${APP_NAMES[list[0]] ?? list[0]}'s` : "one's"} prompt. ${what}`;
}

/** What `self` says when given a context it doesn't take. */
export function notMine(self, context) {
  const apps = (TAKEN_BY[context.kind] ?? []).filter((a) => a !== self);
  return `That's ${describeContext(context)}${apps.length ? `, for ${either(apps)}: paste it into ${apps.length === 1 ? 'its' : "one's"} prompt instead` : ''}.`;
}

/**
 * The paste rule: input that arrived at once while a view had the keys, as the prompt should take it
 * (paste brackets and a trailing newline taken off), when it's a command line or a bare context; else
 * null. A view opens the prompt with it, not running it.
 */
export function pastedLine(input) {
  const s = String(input ?? '').replace(/\x1b\[20[01]~/g, '').replace(/[\r\n]+$/, '');
  if (s.length < 2 || /[\r\n]/.test(s)) return null;
  return s.startsWith('/') || decodeContext(s) ? s : null;
}

/**
 * The line for Trawl's prompt that saves a connection to `db` (databaseOf's), named `name`:
 * `/azure-sql` for an Azure SQL server signing in with Entra (no user, or Entra in the string), else
 * `/add`, the port as Trawl writes it (host,port for SQL Server, host:port otherwise). Never a password.
 */
export function trawlLine(db, name) {
  if (/\.database\.windows\.net$/i.test(db.server) && (!db.user || db.entra)) return shareLine('azure-sql', [db.server, ...(db.database ? [db.database] : [])]);
  const server = db.port ? `${db.server}${db.kind === 'sqlserver' ? ',' : ':'}${db.port}` : db.server;
  return shareLine('add', [
    name,
    server,
    ...(db.database ? [db.database] : []),
    ...(db.kind && db.kind !== 'sqlserver' ? ['--kind', db.kind] : []),
    ...(db.user && !db.entra ? ['--user', db.user] : []),
    ...(db.trustCert ? ['--trust-cert'] : []),
  ]);
}

// Contexts, each one word:
//   exception { app, message, type, frames: [{ file, line, method }], operationId, time, request? }
//   request   { method, url, headers: { name: value }, body, name? }
//   rows      { server?, database?, table?, columns: [name], rows: [[value]] }
//   query     { sql, server?, database? }
//   commit    { repo?, hash, subject? }
//   file      { path, line? }
//   logline   { project?, process, text, time?, requestId? }

const PREFIX = 'family:v1:';
export const CONTEXT_KINDS = ['exception', 'request', 'rows', 'query', 'commit', 'file', 'logline'];

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** One line holding `data` as a context of `kind`. */
export function encodeContext(kind, data) {
  if (!CONTEXT_KINDS.includes(kind)) throw new Error(`No context called ${kind}.`);
  return `${PREFIX}${kind}:${b64url(JSON.stringify(data))}`;
}

/** { kind, data } when `text` is (only) a context, with any surrounding whitespace or paste brackets; else null. */
export function decodeContext(text) {
  const s = String(text ?? '').replace(/\x1b\[20[01]~/g, '').trim();
  const m = /^family:v1:([a-z]+):([A-Za-z0-9_-]+)$/.exec(s);
  if (!m || !CONTEXT_KINDS.includes(m[1])) return null;
  try {
    const data = JSON.parse(unb64url(m[2]));
    return data && typeof data === 'object' ? { kind: m[1], data } : null;
  } catch {
    return null;
  }
}

/** A context's one-line description, for a log line or a question. */
export function describeContext({ kind, data }) {
  switch (kind) {
    case 'exception': return `exception ${data.type ?? ''}${data.message ? `: ${data.message}` : ''}`.trim();
    case 'request': return `request ${data.method ?? 'GET'} ${data.url ?? ''}`.trim();
    case 'rows': return `${data.rows?.length ?? 0} row${data.rows?.length === 1 ? '' : 's'}${data.table ? ` of ${data.table}` : ''}`;
    case 'query': return `query ${String(data.sql ?? '').replace(/\s+/g, ' ').slice(0, 60)}`;
    case 'commit': return `commit ${String(data.hash ?? '').slice(0, 10)}${data.subject ? ` ${data.subject}` : ''}`;
    case 'file': return `${data.path}${data.line ? `:${data.line}` : ''}`;
    case 'logline': return `${data.process ?? 'log'}: ${data.text ?? ''}`;
    default: return kind;
  }
}

/** The stack frames in an exception's text: [{ file, line, method }], .NET, Node, Python and Java styles. */
export function stackFrames(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    let m;
    if ((m = /^\s*at (.+?) in (.+?):line (\d+)/.exec(line))) out.push({ method: m[1], file: m[2], line: Number(m[3]) });
    else if ((m = /^\s*at (?:(.+?) \()?(?:file:\/\/\/?)?((?:[A-Za-z]:)?[^():]+):(\d+):\d+\)?\s*$/.exec(line))) out.push({ method: m[1] ?? null, file: m[2], line: Number(m[3]) });
    else if ((m = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?/.exec(line))) out.push({ method: m[3] ?? null, file: m[1], line: Number(m[2]) });
    else if ((m = /^\s*at ([\w$.<>]+)\((\w+\.\w+):(\d+)\)/.exec(line))) out.push({ method: m[1], file: m[2], line: Number(m[3]) });
  }
  return out.filter((f) => !/node_modules|node:internal|^internal\//.test(f.file));
}

/** The file of `files` (paths relative to a checkout, / separated) a frame's path most likely is: the longest matching tail. */
export function matchFrameFile(framePath, files) {
  const parts = String(framePath).replace(/\\/g, '/').split('/').filter(Boolean);
  let best = null;
  let bestLen = 0;
  for (const f of files) {
    const fp = f.split('/');
    let n = 0;
    while (n < fp.length && n < parts.length && fp[fp.length - 1 - n].toLowerCase() === parts[parts.length - 1 - n].toLowerCase()) n++;
    if (n > bestLen) (best = f), (bestLen = n);
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------
// The project a folder is part of, as each sibling would see it.

/** The checkout `dir` is in (the folder holding .git), or null. */
export function repoRoot(dir) {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The fields of an ADO.NET or ODBC style connection string, keys lower-cased. */
export function parseConnectionString(s) {
  const out = {};
  for (const part of String(s).split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * A database a connection string or URL names: { kind, server, port?, database?, user?, password?, entra }
 * (kind 'sqlserver', 'postgres' or 'mysql'), or null. The password is there for the caller to hand
 * on safely, never to show or log.
 */
export function databaseOf(text) {
  const s = String(text ?? '').trim();
  const url = /^(postgres(?:ql)?|mysql|mariadb|sqlserver|mssql):\/\//i.exec(s);
  if (url) {
    try {
      const u = new URL(s);
      const kind = /^postgres/i.test(url[1]) ? 'postgres' : /^(mysql|mariadb)/i.test(url[1]) ? 'mysql' : 'sqlserver';
      return { kind, server: u.hostname, port: u.port ? Number(u.port) : undefined, database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined, user: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined, entra: false, trustCert: false };
    } catch {
      return null;
    }
  }
  const f = parseConnectionString(s);
  const server = f.server ?? f['data source'] ?? f.address ?? f.addr ?? f['network address'] ?? f.host;
  if (!server) return null;
  const m = /^(?:tcp:)?([^,]+?)(?:,(\d+))?$/i.exec(server);
  const kind = f.host && !f.server && !f['data source'] ? (f.port === '3306' ? 'mysql' : 'postgres') : 'sqlserver';
  return {
    kind,
    server: m ? m[1] : server,
    port: m?.[2] ? Number(m[2]) : f.port ? Number(f.port) : undefined,
    database: f.database ?? f['initial catalog'] ?? undefined,
    user: f['user id'] ?? f.uid ?? f.user ?? f.username ?? undefined,
    password: f.password ?? f.pwd ?? undefined,
    entra: /active directory/i.test(f.authentication ?? '') || /^(sspi|true|yes)$/i.test(f['integrated security'] ?? f.trusted_connection ?? ''),
    trustCert: /^(true|yes)$/i.test(f.trustservercertificate ?? f['trust server certificate'] ?? ''),
  };
}

function safeRead(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** The .http and .rest files in `dir` and the two levels below it, skipping dependencies and dot folders. */
export function httpFilesIn(dir, depth = 2) {
  const out = [];
  const walk = (d, left) => {
    let names;
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (e.isFile() && /\.(http|rest)$/i.test(e.name)) out.push(join(d, e.name));
      else if (e.isDirectory() && left > 0 && !e.name.startsWith('.') && !['node_modules', 'bin', 'obj', 'dist', 'build'].includes(e.name)) walk(join(d, e.name), left - 1);
    }
  };
  walk(dir, depth);
  return out;
}

/**
 * What the siblings would find in `dir`: { dir, repo, crew, httpFiles, databases: [{ name, source, ...databaseOf }] }.
 * `crew` is true when Bosun has something to run (bosun.json, a Procfile, a compose file, or package.json's dev or start script).
 * Databases come from appsettings*.json ConnectionStrings and DATABASE_URL-style lines in .env files.
 */
export function projectAt(dir) {
  const root = resolve(dir);
  const has = (f) => existsSync(join(root, f));
  let pkg = null;
  try {
    pkg = JSON.parse(safeRead(join(root, 'package.json')) ?? 'null');
  } catch {}
  const crew = has('bosun.json') || has('Procfile') || ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'].some(has) || Boolean(pkg?.scripts?.dev || pkg?.scripts?.start);
  const databases = [];
  const add = (name, source, text) => {
    const db = databaseOf(text);
    if (db) databases.push({ name, source, ...db });
  };
  let files = [];
  try {
    files = readdirSync(root);
  } catch {}
  for (const f of files.filter((f) => /^appsettings(\.[\w-]+)?\.json$/i.test(f))) {
    try {
      const cs = JSON.parse(safeRead(join(root, f)).replace(/^﻿/, '')).ConnectionStrings ?? {};
      for (const [name, value] of Object.entries(cs)) if (typeof value === 'string') add(name, f, value);
    } catch {}
  }
  for (const f of files.filter((f) => /^\.env(\.[\w-]+)?$/.test(f))) {
    for (const line of (safeRead(join(root, f)) ?? '').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]*(?:DATABASE|DB|SQL|POSTGRES|MYSQL)[A-Z0-9_]*(?:URL|URI|CONNECTION(?:_STRING)?))\s*=\s*(['"]?)(.+)\2\s*$/i.exec(line);
      if (m) add(m[1], f, m[3]);
    }
  }
  return { dir: root, repo: repoRoot(root), crew, httpFiles: httpFilesIn(root), databases };
}

// Secrets never leave this file whole: values are masked before anything shows or keeps them.
const SECRET_KEY = /pass(word)?|pwd|secret|token|api[-_]?key|access[-_]?key|account[-_]?key|private|credential|signature|sas\b/i;
const SECRET_FIELD = /^(password|pwd|accountkey|sharedaccesskey|sharedaccesssignature|client ?secret|token|apikey|api key)$/i;
export const MASK = '••••';

/** `value` safe to show: passwords in URLs and connection strings masked, the whole value when its key names a secret. */
export function maskValue(key, value) {
  const s = String(value ?? '');
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^@\s/]*@/i.test(s)) return s.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)[^@\s/]*@/i, `$1${MASK}@`);
  if (/[^=;]+=[^;]*;/.test(s) && /;|=/.test(s) && /(server|data source|host|endpoint|accountname)=/i.test(s))
    return s.replace(/(^|;)\s*([^=;]+?)\s*=\s*([^;]*)/g, (m, sep, k, v) => (SECRET_FIELD.test(k.trim()) ? `${sep}${k}=${MASK}` : m));
  if (/\bBearer\s+\S+/i.test(s)) return s.replace(/\b(Bearer\s+)\S+/gi, `$1${MASK}`);
  return SECRET_KEY.test(String(key ?? '')) && s ? MASK : s;
}

/** Free text with what looks like a secret in it masked: key=value pairs named as secrets, bearer tokens, URL passwords. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)[^@\s/]+@/gi, `$1${MASK}@`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${MASK}`)
    .replace(/\b((?:pass(?:word)?|pwd|secret|token|api[-_]?key|accountkey|sharedaccesskey)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,&]+)/gi, `$1${MASK}`);
}

const WIRING_KEY = /url|uri|host|endpoint|connection|port|database|server|base[-_]?address|address|origin|domain|dsn/i;
const looksWired = (key, value) => WIRING_KEY.test(key) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || Boolean(databaseOf(value));

/**
 * What the project in `dir` points at, for one view in every app: [{ key, value, source }] from its
 * appsettings*.json (every setting, by its section path), .env files and Hail's http-client env files
 * (`env:name.key`), keeping addresses, hosts, ports and connection strings, every value through maskValue.
 */
export function projectWiring(dir) {
  const root = resolve(dir);
  const out = [];
  const add = (key, value, source) => {
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const v = String(value);
    if (v && looksWired(key, v)) out.push({ key, value: maskValue(key, v), source });
  };
  const walk = (obj, prefix, source) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const key = prefix ? `${prefix}:${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key, source);
      else add(key, v, source);
    }
  };
  let files = [];
  try {
    files = readdirSync(root);
  } catch {}
  for (const f of files.filter((f) => /^appsettings(\.[\w-]+)?\.json$/i.test(f))) {
    try {
      walk(JSON.parse(safeRead(join(root, f)).replace(/^﻿/, '')), '', f);
    } catch {}
  }
  for (const f of files.filter((f) => /^\.env(\.[\w-]+)?$/.test(f) && !/\.example$/.test(f))) {
    for (const line of (safeRead(join(root, f)) ?? '').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(['"]?)(.*)\2\s*$/.exec(line);
      if (m) add(m[1], m[3], f);
    }
  }
  for (const f of ['http-client.env.json', 'http-client.private.env.json']) {
    try {
      const envs = JSON.parse(safeRead(join(root, f)) ?? 'null') ?? {};
      for (const [env, vars] of Object.entries(envs)) if (vars && typeof vars === 'object') for (const [k, v] of Object.entries(vars)) add(`env:${env}.${k}`, v, f);
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Moods: each app writes how its mascot feels, and why, to one small file per app in the family's
// folder (~/.family, or FAMILY_HOME), so the others can react to it.

export const familyDir = (env = process.env) => env.FAMILY_HOME ?? join(homedir(), '.family');

/** Records `app`'s mood ({ mood, reason }); never throws. */
export function writeMood(app, { mood, reason = '' }, { dir = familyDir(), now = Date.now() } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${app}.mood.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ app, mood, reason, at: now }));
    renameSync(`${file}.tmp`, file);
  } catch {}
}

/** The other apps' moods written in the last `maxAge` ms: [{ app, mood, reason, at }], newest first. */
export function readMoods(self, { dir = familyDir(), now = Date.now(), maxAge = 15 * 60_000 } = {}) {
  const out = [];
  for (const app of FAMILY) {
    if (app === self) continue;
    const p = join(dir, `${app}.mood.json`);
    try {
      if (now - statSync(p).mtimeMs > maxAge) continue;
      const m = JSON.parse(readFileSync(p, 'utf8'));
      if (m && now - m.at <= maxAge) out.push(m);
    } catch {}
  }
  return out.sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------------------------------------------
// The family's activity: each app adds what it did that changes something (a push, a write to a
// database, a restart, a crash) to one log in the family's folder, so any of them can show what
// happened, in order, across all five. Nothing secret goes in: the text is passed through redactSecrets.

const ACTIVITY_FILE = 'activity.jsonl';
const ACTIVITY_MAX = 1024 * 1024;

/** Adds `{ text, kind?, project? }` from `app` to the family's activity log; never throws. */
export function logActivity(app, { text, kind = 'info', project } = {}, { dir = familyDir(), now = Date.now(), max = ACTIVITY_MAX } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, ACTIVITY_FILE);
    const line = JSON.stringify({ at: now, app, kind, text: redactSecrets(text).slice(0, 500), ...(project ? { project: resolve(project) } : {}) }) + '\n';
    appendFileSync(file, line);
    if (statSync(file).size > max) {
      // Keep the newer half, from a whole line.
      const kept = readFileSync(file, 'utf8').slice(-Math.floor(max / 2));
      writeFileSync(`${file}.tmp`, kept.slice(kept.indexOf('\n') + 1));
      renameSync(`${file}.tmp`, file);
    }
  } catch {}
}

/** The activity log, newest first: [{ at, app, kind, text, project? }], since `since` (ms), for `project` (and entries with none) when given, at most `limit`. */
export function readActivity({ dir = familyDir(), since = 0, project, limit = 200 } = {}) {
  let text = '';
  try {
    text = readFileSync(join(dir, ACTIVITY_FILE), 'utf8');
  } catch {
    return [];
  }
  const want = project ? resolve(project) : null;
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (e.at < since) break;
      if (want && e.project && e.project !== want) continue;
      out.push(e);
    } catch {}
  }
  return out;
}
