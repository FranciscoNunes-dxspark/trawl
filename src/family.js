// What the sibling apps (splice, trawl, sonar, bosun, hail) share about each other: what one copies
// for another, the project a folder is, and the mascots' moods. The same file in every app
// (scripts/shared-check.js), so it names no app as "this".
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
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

/** The command line `/command args…`, to paste into another app's prompt. */
export const shareLine = (command, args = []) => [`/${command}`, ...args.map(quoteArg)].join(' ');

/** `/take <context>`: a context as a command line every app's prompt takes. */
export const takeLine = (kind, data) => shareLine('take', [encodeContext(kind, data)]);

/** The context in what was typed at a prompt (`/take family:v1:…`, or the context alone), or null. */
export const contextIn = (line) => decodeContext(String(line ?? '').trim().replace(/^\/?take\s+/, ''));

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
      return { kind, server: u.hostname, port: u.port ? Number(u.port) : undefined, database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined, user: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined, entra: false };
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
  const crew = has('bosun.json') || has('Procfile') || has('docker-compose.yml') || has('compose.yaml') || Boolean(pkg?.scripts?.dev || pkg?.scripts?.start);
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
