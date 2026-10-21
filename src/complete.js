// Completion in the console, as SSMS's IntelliSense or DataGrip's: from the text around the cursor
// and the schema, the names and keywords that could come next. Pure, like editor.js; ConsoleView
// only draws the list and maps keys to it.
import { findObject, objectName } from './schema.js';
import { FUNCTIONS, KEYWORDS, mask, quoteIdent, splitStatements } from './sql.js';

const FILL = '\u0001';

const FUNCTION_SET = new Set(FUNCTIONS);
const WORDS = [...KEYWORDS].filter((k) => !FUNCTION_SET.has(k) && k !== 'GO').sort();

// The syntax shown under the cursor inside a built-in function's parentheses. `?` marks an optional
// argument and `...` one that can repeat.
const SIGNATURES = {
  ABS: 'numeric_expression', AVG: 'expression', CAST: 'expression AS data_type', CEILING: 'numeric_expression',
  CHARINDEX: 'expression_to_find, expression_to_search, start_location?', CHOOSE: 'index, value, value...',
  COALESCE: 'expression, expression...', CONCAT: 'value, value, value...', CONCAT_WS: 'separator, value, value, value...',
  CONVERT: 'data_type, expression, style?', COUNT: 'expression | *', COUNT_BIG: 'expression | *',
  DATEADD: 'datepart, number, date', DATEDIFF: 'datepart, startdate, enddate', DATEDIFF_BIG: 'datepart, startdate, enddate',
  DATEFROMPARTS: 'year, month, day', DATENAME: 'datepart, date', DATEPART: 'datepart, date', DATETRUNC: 'datepart, date',
  DAY: 'date', DB_NAME: 'database_id?', EOMONTH: 'start_date, month_to_add?', FIRST_VALUE: 'scalar_expression',
  FLOOR: 'numeric_expression', FORMAT: 'value, format, culture?', GREATEST: 'expression, expression...',
  HASHBYTES: "'algorithm', input", IIF: 'boolean_expression, true_value, false_value', ISDATE: 'expression',
  ISJSON: 'expression', ISNULL: 'check_expression, replacement_value', ISNUMERIC: 'expression',
  JSON_QUERY: 'expression, path?', JSON_VALUE: 'expression, path', LAG: 'scalar_expression, offset?, default?',
  LAST_VALUE: 'scalar_expression', LEAD: 'scalar_expression, offset?, default?', LEAST: 'expression, expression...',
  LEFT: 'character_expression, integer_expression', LEN: 'string_expression', LOWER: 'character_expression',
  LTRIM: 'character_expression', MAX: 'expression', MIN: 'expression', MONTH: 'date', NTILE: 'integer_expression',
  NULLIF: 'expression, expression', OBJECT_ID: "'object_name', 'object_type'?", OBJECT_NAME: 'object_id, database_id?',
  OPENJSON: 'json_expression, path?', PATINDEX: "'%pattern%', expression", POWER: 'float_expression, y',
  QUOTENAME: "character_string, 'quote_character'?", REPLACE: 'string_expression, string_pattern, string_replacement',
  REPLICATE: 'string_expression, integer_expression', REVERSE: 'string_expression', RIGHT: 'character_expression, integer_expression',
  ROUND: 'numeric_expression, length, function?', RTRIM: 'character_expression', SCHEMA_NAME: 'schema_id?',
  SIGN: 'numeric_expression', SPACE: 'integer_expression', SQRT: 'float_expression', STDEV: 'expression',
  STRING_AGG: 'expression, separator', STRING_SPLIT: 'string, separator, enable_ordinal?',
  STUFF: 'character_expression, start, length, replace_with_expression', SUBSTRING: 'expression, start, length',
  SUM: 'expression', SWITCHOFFSET: 'datetimeoffset_expression, timezoneoffset_expression',
  TODATETIMEOFFSET: 'datetime_expression, timezoneoffset_expression', TRANSLATE: 'input_string, characters, translations',
  TRIM: 'characters FROM? string', TRY_CAST: 'expression AS data_type', TRY_CONVERT: 'data_type, expression, style?',
  TRY_PARSE: 'string_value AS data_type', UPPER: 'character_expression', VAR: 'expression', YEAR: 'date',
};

// Words that can follow a table but are no alias: FROM dbo.T WHERE …, JOIN x OPTION (…).
const NOT_ALIAS = new Set([...KEYWORDS, 'OPTION', 'PIVOT', 'UNPIVOT', 'TABLESAMPLE', 'WINDOW']);
// After these comes a table or view.
const TAKES_TABLE = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'APPLY']);
// After these (and a space) the list opens before anything is typed: what comes next is clear.
const OPENS_LIST = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'APPLY', 'EXEC', 'EXECUTE', 'USE', 'ON']);

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

/**
 * ON conditions for the table joined last in `sqlBefore` (the statement up to the cursor), from the
 * foreign keys between it and each table before it: "c.Id = p.ClubId". Several columns join with AND.
 */
export function joinConditions(sqlBefore, schema) {
  const refs = tablesIn(sqlBefore, schema).filter((t) => t.object);
  const joined = refs.at(-1);
  if (!joined) return [];
  const owner = (t) => ident(t.alias ?? t.object.name);
  const here = objectName(joined.object);
  const out = [];
  for (const other of refs.slice(0, -1)) {
    const there = objectName(other.object);
    for (const f of schema.foreignKeys ?? []) {
      let pairs;
      if (f.from === here && f.to === there) pairs = f.columns.map(([c, r]) => [`${owner(joined)}.${ident(c)}`, `${owner(other)}.${ident(r)}`]);
      else if (f.to === here && f.from === there) pairs = f.columns.map(([c, r]) => [`${owner(joined)}.${ident(r)}`, `${owner(other)}.${ident(c)}`]);
      else continue;
      const text = pairs.map(([x, y]) => `${x} = ${y}`).join(' AND ');
      // Typing the other table's alias first finds it too.
      const swapped = pairs.map(([x, y]) => `${y} = ${x}`).join(' AND ');
      out.push({ label: text, insert: text, match: [text, swapped], kind: 'join', detail: f.name });
    }
  }
  return out;
}

const EXEC = new RegExp(String.raw`\bEXEC(?:UTE)?\s+(?:@[\w@#$]+\s*=\s*)?(${NAME}(?:\.${NAME}){0,2})(\s[\s\S]*)?$`, 'i');

/**
 * EXEC proc … with the cursor among its arguments (`src` is the statement up to the cursor):
 * { proc, rest, restMasked }, `rest` being the arguments so far, or null.
 */
function execCall(src, schema) {
  const r = src.match(EXEC);
  if (!r || r[2] === undefined) return null;
  const m = mask(src);
  const restMasked = m.slice(src.length - r[2].length);
  if (m[r.index] === FILL || restMasked.includes(';')) return null;
  const proc = findObject(schema, r[1]);
  return proc?.params ? { proc, rest: r[2], restMasked } : null;
}

// The arguments written so far at the top level of a call: how many commas, outside parentheses.
const commasIn = (masked) => {
  let depth = 0;
  let n = 0;
  for (const ch of masked) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && !depth) n++;
  }
  return n;
};

const parseParams = (spec) =>
  spec ? spec.split(', ').map((p) => ({ text: p.replace(/\?$|\.\.\.$/, ''), optional: p.endsWith('?'), repeats: p.endsWith('...') })) : [];

/**
 * The syntax to show while typing a call: inside a built-in function's (or the schema's function's)
 * parentheses, or among an EXEC's arguments. { name, params: [{ text, optional, repeats }], index,
 * exec }, `index` being the argument the cursor is on; or null.
 */
export function signatureAt(editor, schema) {
  const { lines, row, col } = editor;
  const text = lines.join('\n');
  const m = mask(text);
  const at = lineStartOffset(lines, row) + col;
  const st = splitStatements(text).find((s) => s.line <= row + 1 && row + 1 <= s.endLine);
  const start = lineStartOffset(lines, (st?.line ?? row + 1) - 1);
  const exec = schema && execCall(text.slice(start, at), schema);
  if (exec) {
    const params = exec.proc.params.map((p) => ({ text: `${p.name} ${p.type}${p.output ? ' OUTPUT' : ''}`, optional: false, repeats: false }));
    return { name: objectName(exec.proc), params, index: commasIn(exec.restMasked), exec: true };
  }
  // Back from the cursor to the parenthesis it's inside, counting the commas on the way.
  let depth = 0;
  let commas = 0;
  for (let i = at - 1; i >= Math.max(start, at - 4000); i--) {
    const ch = m[i];
    if (ch === ')') depth++;
    else if (ch === ',' && !depth) commas++;
    else if (ch === ';') break;
    else if (ch === '(') {
      if (depth) {
        depth--;
        continue;
      }
      const called = text.slice(0, i).match(new RegExp(String.raw`(${NAME}(?:\.${NAME}){0,2})\s*$`))?.[1];
      const builtin = called && !called.includes('.') && SIGNATURES[called.toUpperCase()];
      if (builtin != null) return { name: called.toUpperCase(), params: parseParams(builtin), index: commas, exec: false };
      const fn = called && schema && findObject(schema, called);
      if (fn?.kind === 'function' && fn.params) {
        return { name: objectName(fn), params: fn.params.map((p) => ({ text: `${p.name} ${p.type}`, optional: false, repeats: false })), index: commas, exec: false };
      }
      // A parenthesis that isn't a call (a subquery, (a + b)): the call may be further out.
      commas = 0;
    }
  }
  return null;
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
 * { label, insert, kind, detail }. `force` (ctrl+n) offers a list before anything is typed.
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
  const statementAt = (src) => splitStatements(src).filter((s) => s.line <= row + 1 && row + 1 <= s.endLine);

  // EXEC proc …: the parameters not given yet, as "@name = ", where the next argument starts.
  const exec = schema && execCall(text.slice(lineStartOffset(lines, (statementAt(text)[0]?.line ?? row + 1) - 1), at), schema);
  if (exec) {
    const args = exec.rest.trim();
    if (args && !args.endsWith(',')) return { from, word, items: [] };
    const given = new Set([...exec.rest.matchAll(/(@[\w@#$]+)\s*=/g)].map((g) => g[1].toLowerCase()));
    const params = exec.proc.params
      .filter((p) => !given.has(p.name.toLowerCase()))
      .map((p) => ({ label: p.name, insert: `${p.name} = `, kind: 'parameter', detail: `${p.type}${p.output ? ' output' : ''}` }));
    const items = rank(params, word);
    return { from, word, items: items.length === 1 && items[0].insert.trim() === word ? [] : items };
  }
  if (word.startsWith('@')) return null;

  // SELECT * (or p.*) just typed: its columns, written out, in place of the star.
  const star = head.match(new RegExp(String.raw`(?:^|[^\w@#$\]"*])((?:${NAME}\.)?)\*$`));
  if (star && schema) {
    const starAt = col - star[1].length - 1;
    const pre = m.slice(0, lineStartOffset(lines, row) + starAt);
    const prev = pre.match(/([\w@#$]+|[^\s\u0001])[\s\u0001]*$/)?.[1].toUpperCase();
    const clause = [...pre.matchAll(/\b(SELECT|FROM|WHERE|JOIN|ON|GROUP|ORDER|HAVING|SET|VALUES)\b/gi)].at(-1)?.[1].toUpperCase();
    const listStart = prev === 'SELECT' || prev === 'DISTINCT' || prev === ',' || /\bTOP\s*\(?\s*\d+\s*\)?[\s\u0001]*$/i.test(pre);
    if (clause !== 'SELECT' || !listStart) return { from: col, word, items: [] };
    const scope = tablesIn(statementAt(text).map((s) => s.text).join('\n'), schema);
    const owner = (t) => ident(t.alias ?? t.object.name);
    let refs = scope;
    if (star[1]) {
      const q = bare(star[1].slice(0, -1)).toLowerCase();
      refs = scope.filter((t) => t.alias?.toLowerCase() === q || (!t.alias && t.object?.name.toLowerCase() === q));
    }
    // A table Trawl doesn't know (a temp table, a CTE) would lose its columns, so then nothing.
    if (!refs.length || refs.some((t) => !t.object)) return { from: col, word, items: [] };
    const qualify = Boolean(star[1]) || refs.length > 1;
    const names = refs.flatMap((t) => t.object.columns.map((c) => (qualify ? `${owner(t)}.${ident(c.name)}` : ident(c.name))));
    if (!names.length) return { from: col, word, items: [] };
    const insert = names.join(', ');
    return { from: starAt, word: head.slice(starAt), items: [{ label: insert, insert, kind: 'expand', detail: `all ${names.length} columns` }] };
  }

  const qualifier = head.slice(0, from).match(new RegExp(String.raw`((?:${NAME}\.)+)$`))?.[1] ?? '';
  const before = m.slice(0, at - qualifier.length);
  const prev = before.match(/([\w@#$]+|[^\s\u0001])[\s\u0001]*$/)?.[1].toUpperCase() ?? '';
  const clause = [...before.matchAll(/\b(SELECT|FROM|WHERE|JOIN|ON|GROUP|ORDER|HAVING|SET|VALUES)\b/gi)].at(-1)?.[1].toUpperCase();
  // Before anything is typed, only where it's clear what comes next (FROM's tables, ON's joins).
  if (!word && !qualifier && !force && !OPENS_LIST.has(prev)) return { from, word, items: [] };

  const bracket = word.startsWith('[');
  // A [name] still being typed would hide the rest of the statement, so close it to read the scope.
  const closed = bracket && line[col] !== ']' ? [...lines.slice(0, row), `${head}]${line.slice(col)}`, ...lines.slice(row + 1)].join('\n') : text;
  const here = statementAt(closed);
  const statement = here.map((s) => s.text).join('\n');
  const scope = schema ? tablesIn(statement, schema) : [];
  const joins = prev === 'ON' && !qualifier && schema ? joinConditions(text.slice(lineStartOffset(lines, (here[0]?.line ?? row + 1) - 1), at), schema) : [];
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
      ...joins,
      ...columns.filter((c) => !seen.has(c.label) && seen.add(c.label)),
      ...(bracket ? [] : WORDS.map((k) => ({ label: cased(k), insert: cased(k), match: [k], kind: 'keyword', detail: 'keyword' }))),
      ...(bracket ? [] : FUNCTIONS.map((f) => ({ label: `${cased(f)}()`, insert: `${cased(f)}(`, match: [f], kind: 'function', detail: 'function' }))),
      ...ofKind(['table', 'view']).map((o) => objectItem(o, true)),
    ];
  }
  if (!word && !qualifier && !force && prev === 'ON') items = joins;
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
