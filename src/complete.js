// Completion in the console, as SSMS's IntelliSense or DataGrip's: from the text around the cursor
// and the schema, the names and keywords that could come next. Pure, like editor.js; ConsoleView
// only draws the list and maps keys to it.
import { findObject, objectName } from './schema.js';
import { KEYWORDS, mask, quoteIdent, splitStatements } from './sql.js';

const FILL = '\u0001';

// Built-in functions, offered with their opening parenthesis. LEFT and RIGHT stay keywords (joins).
const FUNCTIONS = `ABS AVG CAST CEILING CHARINDEX CHOOSE COALESCE CONCAT CONCAT_WS CONVERT COUNT COUNT_BIG CUME_DIST
  DATEADD DATEDIFF DATEDIFF_BIG DATEFROMPARTS DATENAME DATEPART DATETRUNC DAY DB_NAME DENSE_RANK EOMONTH FIRST_VALUE
  FLOOR FORMAT GETDATE GETUTCDATE GREATEST HASHBYTES IIF ISDATE ISJSON ISNULL ISNUMERIC JSON_QUERY JSON_VALUE LAG
  LAST_VALUE LEAD LEAST LEN LOWER LTRIM MAX MIN MONTH NEWID NTILE NULLIF OBJECT_ID OBJECT_NAME OPENJSON PATINDEX
  POWER QUOTENAME RANK REPLACE REPLICATE REVERSE ROUND ROW_NUMBER RTRIM SCHEMA_NAME SCOPE_IDENTITY SIGN SPACE SQRT
  STDEV STRING_AGG STRING_SPLIT STUFF SUBSTRING SUM SUSER_SNAME SWITCHOFFSET SYSDATETIME SYSDATETIMEOFFSET
  SYSUTCDATETIME TODATETIMEOFFSET TRANSLATE TRIM TRY_CAST TRY_CONVERT TRY_PARSE UPPER VAR YEAR`.split(/\s+/);
const FUNCTION_SET = new Set(FUNCTIONS);
const WORDS = [...KEYWORDS].filter((k) => !FUNCTION_SET.has(k) && k !== 'GO').sort();

// Words that can follow a table but are no alias: FROM dbo.T WHERE …, JOIN x OPTION (…).
const NOT_ALIAS = new Set([...KEYWORDS, 'OPTION', 'PIVOT', 'UNPIVOT', 'TABLESAMPLE', 'WINDOW']);
// After these comes a table or view.
const TAKES_TABLE = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'APPLY']);

const NAME = String.raw`(?:\[(?:[^\]]|\]\])*\]|"[^"]*"|[\w@#$]+)`;
const REF = new RegExp(String.raw`^\s+(${NAME}(?:\s*\.\s*${NAME}){0,2})`);
const ALIAS = new RegExp(String.raw`^\s+(?:AS\s+)?(${NAME})`, 'i');
const bare = (part) => part.trim().replace(/^\[(.*)\]$/s, '$1').replace(/]]/g, ']').replace(/^"(.*)"$/s, '$1');
const partsOf = (text) => [...text.matchAll(new RegExp(NAME, 'g'))].map((m) => bare(m[0]));

/** A name as it can be typed: bare when it's a plain word, [bracketed] otherwise. */
export const ident = (name) => (/^[A-Za-z_][\w@#$]*$/.test(name) && !NOT_ALIAS.has(name.toUpperCase()) ? name : quoteIdent(name));

/**
 * The tables a statement reads or writes, from its FROM, JOIN, UPDATE and INTO clauses:
 * [{ name, alias, object }], `object` being the schema's entry or null (a temp table, a CTE).
 */
export function tablesIn(sql, schema) {
  const m = mask(sql);
  const out = [];
  for (const k of m.matchAll(/\b(FROM|JOIN|UPDATE|INTO|APPLY)\b/gi)) {
    let pos = k.index + k[0].length;
    for (;;) {
      const r = sql.slice(pos).match(REF);
      if (!r) break;
      const name = r[1].replace(/\s+/g, '');
      pos += r[0].length;
      const a = sql.slice(pos).match(ALIAS);
      const alias = a && !NOT_ALIAS.has(a[1].toUpperCase()) ? bare(a[1]) : null;
      if (alias) pos += a[0].length;
      out.push({ name, alias, object: findObject(schema, name) });
      // FROM a x, b y: a list of them.
      const comma = k[1].toUpperCase() === 'FROM' && sql.slice(pos).match(/^\s*,/);
      if (!comma) break;
      pos += comma[0].length;
    }
  }
  return out;
}

const lineStartOffset = (lines, row) => lines.slice(0, row).reduce((n, l) => n + l.length + 1, 0);

// Prefix matches first, in the order the candidates came (the context put the likeliest first),
// then names that contain the text, for two letters or more. Keywords only match a prefix.
function rank(items, word) {
  const q = word.toLowerCase();
  if (!q) return items;
  const starts = [];
  const contains = [];
  for (const it of items) {
    const keys = (it.match ?? [it.label]).map((s) => s.toLowerCase());
    if (keys.some((s) => s.startsWith(q))) starts.push(it);
    else if (q.length >= 2 && it.kind !== 'keyword' && it.kind !== 'function' && keys.some((s) => s.includes(q))) contains.push(it);
  }
  return [...starts, ...contains];
}

/**
 * What to offer at the cursor: { from, word, items } with `from` the column where the word being
 * typed starts (the text `accept` replaces), or null inside a comment or string. Each item is
 * { label, insert, kind, detail }. `force` (ctrl+space) offers a list before anything is typed.
 */
export function completeAt(editor, schema, { force = false } = {}) {
  const { lines, row, col } = editor;
  const line = lines[row];
  const head = line.slice(0, col);
  const word = head.match(/(\[(?:[^\]]|\]\])*|[\w@#$]*)$/)[0];
  const from = col - word.length;
  const text = lines.join('\n');
  const m = mask(text);
  const at = lineStartOffset(lines, row) + from;
  // Inside a comment or a string (a masked run that isn't the [name] being typed): nothing.
  if (at > 0 && m[at - 1] === FILL && !word.startsWith('[')) {
    let i = at - 1;
    while (i > 0 && m[i - 1] === FILL) i--;
    if (text[i] !== '[' && text[i] !== '"') return null;
  }
  if (word.startsWith('@')) return null;

  const qualifier = head.slice(0, from).match(new RegExp(String.raw`((?:${NAME}\.)+)$`))?.[1] ?? '';
  const before = m.slice(0, at - qualifier.length);
  const prev = before.match(/([\w@#$]+|[^\s\u0001])[\s\u0001]*$/)?.[1].toUpperCase() ?? '';
  const clause = [...before.matchAll(/\b(SELECT|FROM|WHERE|JOIN|ON|GROUP|ORDER|HAVING|SET|VALUES)\b/gi)].at(-1)?.[1].toUpperCase();
  if (!word && !qualifier && !force) return { from, word, items: [] };

  const bracket = word.startsWith('[');
  // A [name] still being typed would hide the rest of the statement, so close it to read the scope.
  const closed = bracket && line[col] !== ']' ? [...lines.slice(0, row), `${head}]${line.slice(col)}`, ...lines.slice(row + 1)].join('\n') : text;
  const statement = splitStatements(closed)
    .filter((s) => s.line <= row + 1 && row + 1 <= s.endLine)
    .map((s) => s.text)
    .join('\n');
  const scope = schema ? tablesIn(statement, schema) : [];
  const typed = bracket ? word.slice(1) : word;
  const name = (n) => (bracket ? quoteIdent(n) : ident(n));
  const objects = schema?.objects ?? [];

  const columnsOf = (o, label) =>
    o.columns.map((c) => ({ label: c.name, insert: name(c.name), kind: 'column', detail: `${c.type}${label ? ` · ${label}` : ''}` }));
  const objectItem = (o, qualified) => ({
    label: o.name,
    insert: qualified ? `${ident(o.schema)}.${name(o.name)}` : name(o.name),
    match: [o.name, objectName(o)],
    kind: o.kind,
    detail: `${o.schema} · ${o.kind}`,
  });
  const ofKind = (kinds, list = objects) => list.filter((o) => kinds.includes(o.kind));
  const schemaItems = () =>
    [...new Set(objects.map((o) => o.schema))].map((s) => ({ label: s, insert: `${ident(s)}.`, kind: 'schema', detail: 'schema' }));
  const wanted = prev === 'EXEC' || prev === 'EXECUTE' ? ['procedure'] : ['table', 'view', 'function'];

  let items;
  if (qualifier) {
    // alias. table. schema. schema.table. db.schema.table.
    const parts = partsOf(qualifier);
    const last = parts.at(-1).toLowerCase();
    const inScope =
      parts.length === 1 &&
      (scope.find((t) => t.alias?.toLowerCase() === last) ?? scope.find((t) => !t.alias && t.object?.name.toLowerCase() === last));
    const schemaName = [...new Set(objects.map((o) => o.schema))].find((s) => s.toLowerCase() === last);
    const object = inScope ? inScope.object : !schemaName && findObject(schema, parts.slice(-2).join('.'));
    if (object) items = columnsOf(object, object.name);
    else if (schemaName) items = ofKind(wanted, objects.filter((o) => o.schema === schemaName)).map((o) => objectItem(o, false));
    else items = [];
  } else if (prev === 'USE') {
    items = (schema?.databases ?? []).map((d) => ({ label: d, insert: name(d), kind: 'database', detail: 'database' }));
  } else if (TAKES_TABLE.has(prev) || prev === 'EXEC' || prev === 'EXECUTE' || (prev === ',' && clause === 'FROM')) {
    items = [...ofKind(wanted).map((o) => objectItem(o, true)), ...schemaItems()];
  } else {
    // Anywhere else: the columns of the tables in this statement, then keywords and functions,
    // then tables. A column in more than one of them comes with its alias, to say which.
    const counts = new Map();
    for (const t of scope) for (const c of t.object?.columns ?? []) counts.set(c.name.toLowerCase(), (counts.get(c.name.toLowerCase()) ?? 0) + 1);
    const columns = scope.flatMap((t) => {
      if (!t.object) return [];
      const owner = t.alias ?? t.object.name;
      return columnsOf(t.object, owner).map((c) =>
        counts.get(c.label.toLowerCase()) > 1 ? { ...c, label: `${owner}.${c.label}`, insert: `${ident(owner)}.${c.insert}`, match: [c.label] } : c,
      );
    });
    const seen = new Set();
    const lower = /[a-z]/.test(typed) && typed === typed.toLowerCase();
    const cased = (k) => (lower ? k.toLowerCase() : k);
    items = [
      ...columns.filter((c) => !seen.has(c.label) && seen.add(c.label)),
      ...(bracket ? [] : WORDS.map((k) => ({ label: cased(k), insert: cased(k), match: [k], kind: 'keyword', detail: 'keyword' }))),
      ...(bracket ? [] : FUNCTIONS.map((f) => ({ label: `${cased(f)}()`, insert: `${cased(f)}(`, match: [f], kind: 'function', detail: 'function' }))),
      ...ofKind(['table', 'view']).map((o) => objectItem(o, true)),
    ];
  }
  items = rank(items, typed);
  // Nothing to add when the one suggestion is what's already there.
  if (items.length === 1 && items[0].insert.toLowerCase() === word.toLowerCase()) items = [];
  return { from, word, items: items.slice(0, 100) };
}

/** Replaces the word being typed with `item`, leaving the cursor after it. */
export function accept(editor, completion, item) {
  const lines = [...editor.lines];
  const line = lines[editor.row];
  // [Na|] becomes [Name]|, not [Name]]|.
  const rest = item.insert.endsWith(']') && line[editor.col] === ']' ? line.slice(editor.col + 1) : line.slice(editor.col);
  lines[editor.row] = line.slice(0, completion.from) + item.insert + rest;
  return { lines, row: editor.row, col: completion.from + item.insert.length };
}
