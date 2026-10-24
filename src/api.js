// /api: a query as an HTTP endpoint. Claude writes a stub that runs the statement (its parameters as
// route or query parameters) in the project's language, and Trawl shows it, saves it where you say
// and copies a Hail `/take request` line for calling it. The prompt and reading the answer are pure;
// `projectLanguage` looks at a folder.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scriptVariables } from './sql.js';

/** The languages /api writes: the word you type, what Claude is told, the file's extension. */
export const API_LANGUAGES = {
  csharp: { name: 'C# (ASP.NET Core minimal API)', ext: 'cs', words: ['csharp', 'c#', 'cs', 'dotnet', '.net'] },
  node: { name: 'Node.js (Express)', ext: 'js', words: ['node', 'express', 'js', 'javascript', 'ts', 'typescript'] },
  python: { name: 'Python (FastAPI)', ext: 'py', words: ['python', 'py', 'fastapi'] },
  go: { name: 'Go (net/http)', ext: 'go', words: ['go', 'golang'] },
};

/** The language a word names (csharp, c#, node, express…), or null. */
export function apiLanguage(word) {
  const w = String(word ?? '').trim().toLowerCase();
  return Object.keys(API_LANGUAGES).find((k) => API_LANGUAGES[k].words.includes(w)) ?? null;
}

/**
 * The project's language, from what is in `dir` and two levels under it: C# when there's a *.csproj,
 * Node when there's a package.json (C# first: a .NET project often has one for its front end), else null.
 */
export function projectLanguage(dir, depth = 2) {
  let found = null;
  const walk = (d, left) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && /\.csproj$/i.test(e.name)) found = 'csharp';
      else if (e.isFile() && e.name === 'package.json' && !found) found = 'node';
    }
    if (found === 'csharp' || left <= 0) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'bin', 'obj', 'dist', 'build'].includes(e.name)) walk(join(d, e.name), left - 1);
  };
  walk(dir, depth);
  return found;
}

export const API_SYSTEM = `You turn one SQL statement into an HTTP endpoint that runs it, for the developer who wrote the query.
Answer with one JSON object and nothing else (no Markdown, no code fences), with these fields:
  "code": the whole source file of the endpoint, ready to drop into the project: the route, reading its parameters, running the SQL with parameters (never by pasting values into the SQL text), and returning the rows as JSON (or the rows affected, for a write);
  "language": the language you wrote it in;
  "method": the HTTP method (GET for a read, POST, PUT or DELETE for a write);
  "path": the route, starting with /, with route parameters in braces as the framework writes them (/players/{id}), and query parameters left out of it;
  "body": for POST and PUT, an example JSON body the endpoint takes (an object), else null.
Each SQL parameter (@name, :name, $1 or ?) becomes a route parameter when it identifies one thing (an id) and a query parameter otherwise. Name the endpoint after what the query returns.
Use the database's usual client library for the language and the database kind on the first line (Microsoft.Data.SqlClient or Dapper for SQL Server in C#, Npgsql for PostgreSQL, MySqlConnector for MySQL; mssql, pg or mysql2 in Node), and take the connection string from configuration or an environment variable, never written into the code.`;

/** The prompt for /api: the database, the language, the statement and its parameters. Never rows. */
export function apiPrompt({ sql, language, label = 'SQL Server', database = null, columns = [] }) {
  const params = scriptVariables(sql).map((v) => v.name);
  return [
    `Database kind: ${label}${database ? ` (database ${database})` : ''}`,
    `Language: ${API_LANGUAGES[language]?.name ?? language}`,
    params.length ? `Parameters in the SQL: ${params.join(', ')}` : 'The SQL has no parameters.',
    ...(columns.length ? [`Columns it returns: ${columns.join(', ')}`] : []),
    '',
    'SQL:',
    sql.trim(),
  ].join('\n');
}

/**
 * Claude's answer as { code, language, method, path, body }: the JSON object in it (fenced or not).
 * Throws when there's no code in it.
 */
export function parseApi(text) {
  const t = String(text ?? '').trim();
  const fenced = t.match(/```(?:json)?[ \t]*\n([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, t, t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)].filter(Boolean);
  let out = null;
  for (const c of candidates) {
    try {
      out = JSON.parse(c);
      if (out && typeof out === 'object') break;
    } catch {}
    out = null;
  }
  if (!out || typeof out.code !== 'string' || !out.code.trim()) throw new Error(`Claude's answer had no endpoint in it: ${t.split('\n')[0].slice(0, 120) || '(nothing)'}`);
  const method = String(out.method ?? 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
  const path = `/${String(out.path ?? '/').trim().replace(/^\/+/, '')}`;
  const body = out.body == null || out.body === '' ? null : out.body;
  return { code: out.code.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n'), language: String(out.language ?? ''), method, path, body };
}

/** The request Hail takes (family.js's `request` context) for calling the endpoint: `{{host}}` and the path. */
export function apiRequest({ method, path, body }, { name } = {}) {
  const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  return { method, url: `{{host}}${path}`, headers: text ? { 'Content-Type': 'application/json' } : {}, body: text, ...(name ? { name } : {}) };
}

/** A file name for the endpoint: what the path names, in the language's way (PlayersEndpoint.cs, players.js). */
export function apiFileName({ path }, language) {
  const words = String(path).split('/').filter((p) => p && !/^[{:]/.test(p)).map((p) => p.replace(/[^A-Za-z0-9]+/g, ' ').trim()).filter(Boolean);
  const base = words.join(' ') || 'query';
  const ext = API_LANGUAGES[language]?.ext ?? 'txt';
  if (language === 'csharp') return `${base.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join('')}Endpoint.${ext}`;
  return `${base.toLowerCase().split(/\s+/).join(language === 'python' || language === 'go' ? '_' : '-')}.${ext}`;
}
