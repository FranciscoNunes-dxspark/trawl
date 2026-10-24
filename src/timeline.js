// What Trawl adds to the family's activity log (family.js logActivity), and how /timeline and /wiring
// show the log and a project's wiring. Pure. A write is said by its kinds of statement and the
// tables they change, the connection and the rows: never its values, which the SQL's literals hold.
import { APP_NAMES } from './family.js';
import { classify, mask, splitStatements, withoutLeadingComments } from './sql.js';
import { relTime } from './text.js';

// The statement's verb and what it acts on, read on the mask (strings and comments blanked), so no
// literal can come through: INSERT INTO t, UPDATE t, DELETE FROM t, MERGE INTO t, CREATE TABLE t…
const VERB = /^\s*(INSERT\s+(?:IGNORE\s+)?(?:INTO\s+)?|UPDATE\s+|DELETE\s+(?:FROM\s+)?|MERGE\s+(?:INTO\s+)?|TRUNCATE\s+(?:TABLE\s+)?|(?:CREATE|ALTER|DROP)\s+(?:OR\s+(?:ALTER|REPLACE)\s+)?(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?(?:TABLE|VIEW|PROCEDURE|PROC|FUNCTION|TRIGGER|INDEX|SCHEMA|DATABASE|SEQUENCE|TYPE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?)/i;
const NAME = /^(?:[\w$#@]+|\[[^\]]*\]|"[^"]*"|`[^`]*`)(?:\.(?:[\w$#@]+|\[[^\]]*\]|"[^"]*"|`[^`]*`)){0,2}/;

// Where a statement starts inside a block (BEGIN TRY … END CATCH, IF … BEGIN … END).
const INNER = /(?:^|[;\n]|\b(?:BEGIN|TRY|THEN|ELSE)\b)[ \t]*(?=(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP)\b)/gi;

function kindAt(src, masked, from) {
  const m = VERB.exec(masked.slice(from));
  if (!m) return null;
  const verb = m[1].trim().replace(/\s+/g, ' ').toUpperCase().replace(/ IF (NOT )?EXISTS$/, '');
  // Quoted names are blanked in the mask too: the name is read from the text at the same place.
  const name = NAME.exec(src.slice(from + m[0].length))?.[0];
  return name ? `${verb} ${name}` : verb;
}

/** A write statement's kinds: ["UPDATE dbo.Players"], a block's statements inside it, or its first word alone. */
export function statementKinds(text) {
  const src = withoutLeadingComments(text);
  const masked = mask(src);
  const first = kindAt(src, masked, 0);
  if (first) return [first];
  const inner = [...masked.matchAll(INNER)].map((m) => kindAt(src, masked, m.index + m[0].length)).filter(Boolean);
  return inner.length ? inner : [(masked.match(/^\s*(\w+)/)?.[1] ?? '').toUpperCase()].filter(Boolean);
}

/** One write statement as "UPDATE dbo.Players", "CREATE TABLE dbo.T", or its first word alone. */
export const statementKind = (text) => statementKinds(text).join(', ');

/** The writes in a script, each kind once with how many times: ["UPDATE dbo.Players ×2", "DELETE FROM dbo.Log"]. */
export function writeKinds(sql, { dialect = 'sqlserver' } = {}) {
  const counts = new Map();
  for (const s of splitStatements(sql)) {
    if (!classify(s.text, { dialect }).write) continue;
    for (const k of statementKinds(s.text)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
}

/** The rows the server said the statements changed ("3 rows affected"), or null when it said none. */
export function rowsChanged(messages = []) {
  let n = null;
  for (const m of messages) {
    const x = /^(\d+) rows? affected/.exec(m);
    if (x) n = (n ?? 0) + Number(x[1]);
  }
  return n;
}

const rowsText = (n) => (n == null ? '' : ` · ${n.toLocaleString('en')} row${n === 1 ? '' : 's'}`);

/** The log's line for writes that took effect: "UPDATE dbo.Players on dev/ClubA · 3 rows". */
export function writeText(kinds, where, rows) {
  return `${kinds.join(', ')} on ${where}${rowsText(rows)}`;
}

/** The log's line for the end of a transaction, with what it held: "COMMIT on dev/ClubA: UPDATE dbo.Players · 3 rows". */
export function endText(verb, where, pending) {
  const kinds = pending?.kinds ?? [];
  return `${verb} on ${where}${kinds.length ? `: ${kinds.join(', ')}${rowsText(pending.rows)}${verb === 'ROLLBACK' && pending.rows ? ' undone' : ''}` : ''}`;
}

/** Writes held in an open transaction, added to as more run: { kinds, rows }. */
export function addPending(pending, kinds, rows) {
  const counts = new Map();
  for (const k of [...(pending?.kinds ?? []), ...kinds]) {
    const [, base, n] = /^(.*?)(?: ×(\d+))?$/.exec(k);
    counts.set(base, (counts.get(base) ?? 0) + Number(n ?? 1));
  }
  const total = pending?.rows == null && rows == null ? null : (pending?.rows ?? 0) + (rows ?? 0);
  return { kinds: [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)), rows: total };
}

/** Whether a statement ends the open transaction: 'COMMIT', 'ROLLBACK' or null. */
export function endsTransaction(sql) {
  const m = /^\s*(COMMIT|ROLLBACK)\b/i.exec(withoutLeadingComments(sql));
  return m ? m[1].toUpperCase() : null;
}

/** /timeline's rows: [{ label, detail, text }], newest first, as the family's log has them. */
export function timelineItems(entries, { now = Date.now() } = {}) {
  return entries.map((e) => {
    const when = new Date(e.at);
    const stampText = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    const app = APP_NAMES[e.app] ?? e.app;
    return {
      label: `${relTime(e.at, now).padStart(3)}  ${app}`,
      detail: e.text,
      text: [`${app} · ${e.kind ?? 'info'} · ${stampText}`, ...(e.project ? [e.project] : []), '', e.text].join('\n'),
      entry: e,
    };
  });
}

/** /wiring's text: what a project points at, grouped by the file it's in, values already masked (family.js projectWiring). */
export function wiringText(dir, wiring) {
  if (!wiring.length) return `Nothing in ${dir} points anywhere: Trawl looks at appsettings*.json, .env files and Hail's http-client env files for addresses, hosts, ports and connection strings.`;
  const groups = new Map();
  for (const w of wiring) groups.set(w.source, [...(groups.get(w.source) ?? []), w]);
  const out = [`What ${dir} points at, by file (secrets masked as ••••):`];
  for (const [source, list] of groups) {
    out.push('', source);
    const w = Math.min(40, Math.max(...list.map((x) => x.key.length)));
    for (const x of list) out.push(`  ${x.key.padEnd(w)}  ${x.value}`);
  }
  return out.join('\n');
}
