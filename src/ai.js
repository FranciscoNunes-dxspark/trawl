// What Claude may see of a connection, and the /ask conversation with the claude CLI.
// A connection's `ai` level decides: 'off' (nothing), 'schema' (table and column names, SQL text
// and error messages) or 'results' (rows too). Rows are data that leaves this machine, so a
// connection only sends them once you've said so.
import { execFile } from 'node:child_process';
import { objectName } from './schema.js';

export const AI_LEVELS = ['off', 'schema', 'results'];

export const AI_LABELS = { off: 'nothing', schema: 'schema only', results: 'schema and results' };

/** The connection's level: what it says, else 'schema' (the demo shows everything, it's made up). */
export const aiLevel = (conn) => (AI_LEVELS.includes(conn?.ai) ? conn.ai : conn?.demo ? 'results' : 'schema');

export const canSeeSchema = (conn) => aiLevel(conn) !== 'off';
export const canSeeResults = (conn) => aiLevel(conn) === 'results';

/** One table or view on one line: dbo.Players(Id int PK, ClubId int, Name nvarchar(100) null). */
export function tableLine(o) {
  const cols = o.columns.map((c) => `${c.name} ${c.type}${c.pk ? ' PK' : ''}${c.nullable ? ' null' : ''}`);
  return `${objectName(o)}(${cols.join(', ')})`;
}

/**
 * The schema as Claude reads it. When the whole thing is too long, the tables whose names
 * share a word with the question come first in full, and the rest by name only.
 */
export function schemaText(schema, question = '', { maxChars = 60_000 } = {}) {
  const tables = schema.objects.filter((o) => o.kind === 'table' || o.kind === 'view');
  const full = tables.map(tableLine);
  if (full.join('\n').length <= maxChars) return full.join('\n');
  const words = new Set(question.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
  const hit = (o) => [...words].some((w) => o.name.toLowerCase().includes(w) || w.includes(o.name.toLowerCase()));
  const out = [];
  let size = 0;
  for (const o of [...tables.filter(hit), ...tables.filter((o) => !hit(o))]) {
    const line = tableLine(o);
    if (size + line.length > maxChars * 0.8) break;
    out.push(line);
    size += line.length + 1;
  }
  const rest = tables.filter((o) => !out.some((l) => l.startsWith(`${objectName(o)}(`)));
  return `${out.join('\n')}\n-- More tables, columns not shown: ${rest.map(objectName).join(', ')}`;
}

export const ASK_SYSTEM = `You write T-SQL for Microsoft SQL Server / Azure SQL.
Answer with exactly one \`\`\`sql code block holding the query, then at most two short sentences on what it does or what you assumed.
Use only the tables and columns in the schema you are given; if the question can't be answered from them, say so instead of guessing.
Prefer reads. Never write DROP, TRUNCATE, or an UPDATE or DELETE without a WHERE. Use TOP rather than LIMIT.`;

/** The prompt for one /ask: the database, its schema, and the question. */
export function askPrompt({ question, schema, database }) {
  return `Database: ${database}\n\nSchema (schema.table(column type ...)):\n${schemaText(schema, question)}\n\nQuestion: ${question}`;
}

export const EXPLAIN_SYSTEM = `You explain Microsoft SQL Server execution plans to the developer who ran the query.
You get the query and its estimated plan as SHOWPLAN_TEXT (no rows of data).
In plain text with no Markdown headings, at most about 25 short lines:
1. What the plan does, step by step, from the operators that read data up to the result.
2. What is likely to cost the most, and why (scans of big tables, key lookups, sorts, hash joins, implicit conversions, missing index warnings).
3. Concrete changes worth trying: an index (with its CREATE INDEX), a rewrite of a predicate, or "nothing to change" when it is already fine.
Only talk about the tables, columns and operators in the plan; don't invent statistics or row counts that aren't there.`;

/** The prompt for explaining a plan: the query and its plan, never any rows. */
export function explainPrompt({ sql, plan, database }) {
  return `Database: ${database}\n\nQuery:\n${sql}\n\nEstimated plan (SHOWPLAN_TEXT):\n${plan}`;
}

/** Splits Claude's answer into the SQL and the note around it. */
export function parseAnswer(text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n');
  const block = t.match(/```(?:sql|tsql|t-sql)?[ \t]*\n([\s\S]*?)```/i);
  if (!block) return { sql: null, note: t.trim() };
  const note = (t.slice(0, block.index) + t.slice(block.index + block[0].length)).replace(/\s+/g, ' ').trim();
  return { sql: block[1].trim(), note };
}

/** The answer as console text: the question and Claude's note as comments, then the SQL. */
export function consoleText({ question, sql, note }) {
  const comment = (s) => s.split('\n').map((l) => `-- ${l}`).join('\n');
  return [comment(`Asked Claude: ${question}`), note ? comment(note) : null, sql].filter(Boolean).join('\n');
}

/**
 * Asks the claude CLI, signed in as you, with no tools and none of your MCP servers: it can
 * only answer. The prompt goes in on stdin, so its length and contents never reach a shell.
 */
export function askClaude({ prompt, system = ASK_SYSTEM, signal, execImpl = execFile }) {
  const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', system];
  return new Promise((resolve, reject) => {
    const child = execImpl('claude', args, { signal, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err?.name === 'AbortError') return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (err?.code === 'ENOENT') return reject(new Error('The Claude Code CLI (claude) is not installed or not on the PATH. Get it from https://claude.com/claude-code'));
      let out;
      try {
        out = JSON.parse(stdout);
      } catch {
        return reject(new Error((stderr || stdout || err?.message || 'claude gave no answer').trim().split('\n').slice(-3).join('\n')));
      }
      if (out.is_error) return reject(new Error(String(out.result ?? 'Claude could not answer.').trim()));
      resolve(String(out.result ?? ''));
    });
    child.stdin?.end(prompt);
  });
}
