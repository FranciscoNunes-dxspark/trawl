// Pure T-SQL text handling: where batches and statements start and end, what a statement would
// change, and how values are shown and exported. Nothing here talks to a database.

// Every character inside a comment, string or quoted identifier becomes FILL in the mask, newlines
// included, so the mask lines up with the source and keywords or semicolons in there are never seen.
const FILL = '\u0001';

/** Masks comments (nested /* *\/ too), 'strings', "identifiers" and [identifiers] in `src`. */
export function mask(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const fill = (from, to) => {
    out += FILL.repeat(to - from);
    i = to;
  };
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '-' && next === '-') {
      const end = src.indexOf('\n', i);
      fill(i, end < 0 ? n : end);
    } else if (ch === '/' && next === '*') {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (src[j] === '/' && src[j + 1] === '*') (depth++, (j += 2));
        else if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
          if (!depth) break;
        } else j++;
      }
      fill(i, Math.min(j, n));
    } else if (ch === "'" || ch === '"' || ch === '[') {
      // A doubled closing character is an escaped one: 'it''s', [a]]b].
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < n) {
        if (src[j] === close) {
          if (src[j + 1] === close) j += 2;
          else break;
        } else j++;
      }
      fill(i, Math.min(j + 1, n));
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const GO_LINE = /^[ \t]*go(?:[ \t]+(\d+))?[ \t\u0001]*$/i;
const hasCode = (masked) => /[^\s\u0001;]/.test(masked);

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const normalise = (text) => String(text ?? '').replace(/\r\n?/g, '\n');

/**
 * Splits a script into the batches SQL Server runs one at a time: `GO` on a line of its own
 * ends one (`GO 3` runs it three times). Each is { text, line, repeat }, `line` counting from 1.
 */
export function splitBatches(text) {
  const src = normalise(text);
  const m = mask(src);
  const lineOf = lineIndex(src);
  const out = [];
  let start = 0;
  let off = 0;
  const flush = (end, repeat = 1) => {
    if (hasCode(m.slice(start, end))) {
      const lead = src.slice(start, end).search(/\S/);
      out.push({ text: src.slice(start, end).trim(), line: lineOf(start + lead), repeat });
    }
  };
  for (const line of m.split('\n')) {
    const lineStart = off;
    off += line.length + 1;
    const go = line.match(GO_LINE);
    if (!go) continue;
    flush(lineStart, Math.max(1, Number(go[1] ?? 1)));
    start = Math.min(off, src.length);
  }
  flush(src.length);
  return out;
}

const NOT_A_BLOCK = new Set(['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION']);
const MODULES = new Set(['PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW']);

/** CREATE [OR ALTER] / ALTER followed by a procedure, function, trigger or view. */
function isModuleHeader(words) {
  if (words[0] !== 'CREATE' && words[0] !== 'ALTER') return false;
  const kind = words[1] === 'OR' && words[2] === 'ALTER' ? words[3] : words[1];
  return MODULES.has(kind);
}

/**
 * Splits a script into statements, the units the Query view lists and runs. A statement ends at
 * a `;`, a `GO` line or a blank line, except inside parentheses or a BEGIN/CASE … END block.
 * A procedure, function, trigger or view runs on to the next `GO`, as SQL Server requires.
 * Each is { text, line, endLine, label }, with `label` the statement's first line of code.
 */
export function splitStatements(text) {
  const src = normalise(text);
  const m = mask(src);
  const lineOf = lineIndex(src);
  const out = [];
  let start = 0;
  let paren = 0;
  let blocks = [];
  let whole = false;
  let words = [];
  const wordAfter = (pos) => m.slice(pos).match(/^[\s\u0001]*(\w+)/)?.[1].toUpperCase() ?? null;

  const flush = (end) => {
    const piece = m.slice(start, end);
    if (hasCode(piece)) {
      const lead = src.slice(start, end).search(/\S/);
      const trail = src.slice(start, end).trimEnd().length;
      const codeAt = piece.search(/[^\s\u0001]/);
      const lineStart = src.lastIndexOf('\n', start + codeAt - 1) + 1;
      const lineEnd = src.indexOf('\n', start + codeAt);
      out.push({
        text: src.slice(start + lead, start + trail),
        line: lineOf(start + lead),
        endLine: lineOf(start + trail - 1),
        label: src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd).trim(),
      });
    }
    start = end;
    paren = 0;
    blocks = [];
    whole = false;
    words = [];
  };

  let off = 0;
  for (const line of m.split('\n')) {
    const lineStart = off;
    off += line.length + 1;
    if (GO_LINE.test(line)) {
      flush(lineStart);
      start = Math.min(off, src.length);
      continue;
    }
    if (/^[ \t]*$/.test(line)) {
      if (!paren && !blocks.length && !whole) flush(lineStart);
      continue;
    }
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === ';' && !paren && !blocks.length && !whole) flush(lineStart + j + 1);
      else if (/[A-Za-z_@#]/.test(ch) && (j === 0 || !/[\w@#$]/.test(line[j - 1]))) {
        const word = line.slice(j).match(/^[\w@#$]+/)[0];
        const w = word.toUpperCase();
        const after = lineStart + j + word.length;
        j += word.length - 1;
        if (words.length < 4) {
          words.push(w);
          if (isModuleHeader(words)) whole = true;
        }
        if (w === 'CASE') blocks.push('CASE');
        else if (w === 'BEGIN' && !NOT_A_BLOCK.has(wordAfter(after))) blocks.push('BEGIN');
        else if (w === 'END') {
          // Closing the outermost BEGIN ends the statement, unless ELSE or BEGIN CATCH carries on.
          if (blocks.pop() !== 'BEGIN' || blocks.length || paren || whole) continue;
          const next = wordAfter(after);
          if (next === 'TRY' || next === 'ELSE') continue;
          if (next === 'CATCH') {
            const catchEnd = after + m.slice(after).search(/CATCH/i) + 'CATCH'.length;
            flush(catchEnd);
            j = catchEnd - lineStart - 1;
            continue;
          }
          flush(after);
        }
      }
    }
  }
  flush(src.length);
  return out;
}

/** The statement covering 1-based `line`, or the nearest one above it. */
export function statementAt(statements, line) {
  let best = null;
  for (const s of statements) if (s.line <= line) best = s;
  return best ?? statements[0] ?? null;
}

// Words that make a statement change something. EXEC is in: a procedure could do anything.
const WRITES = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'EXEC', 'EXECUTE',
  'GRANT', 'REVOKE', 'DENY', 'INTO', 'BULK', 'DBCC', 'BACKUP', 'RESTORE', 'KILL', 'SHUTDOWN', 'RECONFIGURE',
]);
// System procedures that only read, so running them is fine on a read-only connection.
const READ_PROCS = new Set([
  'SP_HELP', 'SP_HELPTEXT', 'SP_HELPINDEX', 'SP_HELPCONSTRAINT', 'SP_COLUMNS', 'SP_TABLES', 'SP_WHO', 'SP_WHO2',
  'SP_SPACEUSED', 'SP_DATABASES', 'SP_LOCK', 'SP_DESCRIBE_FIRST_RESULT_SET',
]);
// At the same nesting depth, these start another statement, so a WHERE after them isn't ours.
const STARTS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'TRUNCATE', 'CREATE', 'ALTER', 'EXEC', 'EXECUTE', 'DECLARE', 'PRINT', 'IF']);

function tokens(src) {
  const m = mask(src);
  const out = [];
  let depth = 0;
  for (const t of m.matchAll(/[\w@#$]+|[()]/g)) {
    if (t[0] === '(') depth++;
    else if (t[0] === ')') depth = Math.max(0, depth - 1);
    else out.push({ w: t[0].toUpperCase(), depth, at: t.index, next: m[t.index + t[0].length] });
  }
  return out;
}

// The name right after `at` in the source, skipping TOP (n) and FROM: "DELETE TOP (5) FROM dbo.T" → dbo.T.
function targetAfter(src, at) {
  const m = src.slice(at).match(/^\s+(?:TOP\s*\([^)]*\)\s*)?(?:FROM\s+)?((?:\[[^\]]*\]|"[^"]*"|[\w#@$]+)(?:\s*\.\s*(?:\[[^\]]*\]|"[^"]*"|[\w#@$]+))*)/i);
  return m ? m[1].replace(/\s+/g, '') : '';
}

/**
 * What one statement would do: { write, danger }. `danger` lists the reasons to ask first:
 * UPDATE or DELETE with no WHERE, DROP, TRUNCATE.
 */
export function classify(statement) {
  const src = normalise(statement);
  const toks = tokens(src);
  const words = toks.slice(0, 4).map((t) => t.w);
  const danger = [];
  let write = false;
  const module = isModuleHeader(words);
  for (let i = 0; i < toks.length; i++) {
    const { w, depth, at, next } = toks[i];
    if (!WRITES.has(w)) continue;
    const following = toks[i + 1];
    if (w === 'EXEC' || w === 'EXECUTE') {
      // "EXEC sys.sp_help" arrives as SYS then SP_HELP.
      const proc = following?.w === 'SYS' ? toks[i + 2]?.w : following?.w;
      if (READ_PROCS.has(proc)) continue;
    }
    // IF UPDATE(col) in a trigger, ON DELETE CASCADE, FOR/AFTER/INSTEAD OF UPDATE: not statements.
    const before = toks[i - 1]?.w;
    if ((w === 'UPDATE' || w === 'DELETE' || w === 'INSERT') && (next === '(' || ['ON', 'FOR', 'AFTER', 'OF'].includes(before) || toks[i - 1]?.next === ',')) continue;
    write = true;
    if (module) continue;
    const name = () => targetAfter(src, at + w.length);
    if ((w === 'UPDATE' || w === 'DELETE') && following?.w !== 'STATISTICS') {
      let where = false;
      for (let j = i + 1; j < toks.length; j++) {
        if (toks[j].depth < depth) break;
        if (toks[j].depth > depth) continue;
        if (toks[j].w === 'WHERE' || toks[j].w === 'CURRENT') {
          where = true;
          break;
        }
        if (STARTS.has(toks[j].w)) break;
      }
      if (!where) danger.push(`${w} with no WHERE changes every row of ${name() || 'the table'}`);
    } else if (w === 'DROP' && following) {
      danger.push(`DROP ${following.w} ${targetAfter(src, following.at + following.w.length)}`.trim());
    } else if (w === 'TRUNCATE') {
      const from = following?.w === 'TABLE' ? following.at + following.w.length : at + w.length;
      danger.push(`TRUNCATE removes every row of ${targetAfter(src, from) || 'the table'}`);
    }
  }
  return { write, danger };
}

/** classify() over every statement of a script, merged. */
export function classifyScript(text) {
  const parts = splitStatements(text).map((s) => classify(s.text));
  return { write: parts.some((p) => p.write), danger: parts.flatMap((p) => p.danger) };
}

/** Quotes a name for T-SQL: dbo → [dbo], a]b → [a]]b]. */
export function quoteIdent(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

export const qualified = (schema, name) => `${quoteIdent(schema)}.${quoteIdent(name)}`;

export const selectTop = (schema, name, limit) => `SELECT TOP (${limit}) * FROM ${qualified(schema, name)};`;

/** A statement on one line, for titles and history rows. */
export function oneLine(sql) {
  return normalise(sql).replace(/\s+/g, ' ').trim();
}

const NUMERIC = /^(Int|BigInt|SmallInt|TinyInt|Decimal|Numeric|Float|Real|Money|SmallMoney)/i;
export const isNumericType = (type) => NUMERIC.test(type ?? '');

/** A value as the grid shows it. NULL is spelled out so it can't be mistaken for an empty string. */
export function formatValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return String(v);
    return v.toISOString().replace('T', ' ').replace(/Z$/, '').replace(/\.000$/, '').replace(/ 00:00:00$/, '');
  }
  if (Buffer.isBuffer(v)) {
    const hex = v.subarray(0, 64).toString('hex').toUpperCase();
    return `0x${hex}${v.length > 64 ? '…' : ''}`;
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = formatValue(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One result set as CSV, header row first. NULL becomes an empty cell. */
export function toCsv(set) {
  const lines = [set.columns.map((c) => csvCell(c.name)).join(',')];
  for (const row of set.rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** One result set as a JSON array of objects. Dates become ISO strings, binary 0x… hex. */
export function toJson(set) {
  const rows = set.rows.map((row) =>
    Object.fromEntries(set.columns.map((c, i) => [c.name, Buffer.isBuffer(row[i]) ? formatValue(row[i]) : row[i] ?? null])),
  );
  return JSON.stringify(rows, null, 2) + '\n';
}

const KEYWORDS = new Set(
  `ADD ALL ALTER AND ANY AS ASC BACKUP BEGIN BETWEEN BREAK BY CASCADE CASE CAST CATCH CHECK COLUMN COMMIT CONSTRAINT
  CONTINUE CONVERT CREATE CROSS CURSOR DATABASE DECLARE DEFAULT DELETE DESC DISTINCT DROP ELSE END ESCAPE EXCEPT EXEC
  EXECUTE EXISTS FETCH FOR FOREIGN FROM FULL FUNCTION GO GOTO GRANT GROUP HAVING IDENTITY IF IN INDEX INNER INSERT
  INTERSECT INTO IS JOIN KEY LEFT LIKE MERGE NEXT NOCOUNT NOT NULL OF OFF OFFSET ON ONLY OR ORDER OUTER OUTPUT OVER
  PARTITION PERCENT PRIMARY PRINT PROC PROCEDURE RAISERROR REFERENCES RETURN RETURNS REVOKE RIGHT ROLLBACK ROW ROWS
  SCHEMA SELECT SET TABLE THEN THROW TOP TRAN TRANSACTION TRIGGER TRUNCATE TRY UNION UNIQUE UPDATE USE USING VALUES
  VIEW WAITFOR WHEN WHERE WHILE WITH`.split(/\s+/),
);

/**
 * Splits a script into coloured runs per line: { text, kind } with kind 'keyword', 'string',
 * 'comment', 'number', 'variable' or null. Comments and strings spanning lines stay coloured.
 */
export function highlight(text) {
  const src = normalise(text);
  const m = mask(src);
  // What each masked run is, from the character it starts with.
  const kinds = new Array(src.length).fill(null);
  for (let i = 0; i < src.length; ) {
    if (m[i] !== FILL) {
      i++;
      continue;
    }
    const kind = src[i] === '-' || src[i] === '/' ? 'comment' : src[i] === "'" ? 'string' : null;
    let j = i;
    while (j < src.length && m[j] === FILL) kinds[j++] = kind;
    i = j;
  }
  for (const t of m.matchAll(/[@#]?[A-Za-z_][\w$#@]*|\b\d+(\.\d+)?\b/g)) {
    const w = t[0];
    const kind = /^\d/.test(w) ? 'number' : w.startsWith('@') ? 'variable' : KEYWORDS.has(w.toUpperCase()) ? 'keyword' : null;
    if (kind) for (let k = 0; k < w.length; k++) kinds[t.index + k] = kind;
  }
  // N'…' is a string too.
  for (let i = 0; i + 1 < src.length; i++) if ((src[i] === 'N' || src[i] === 'n') && kinds[i + 1] === 'string' && src[i + 1] === "'") kinds[i] = 'string';
  const out = [];
  let off = 0;
  for (const line of src.split('\n')) {
    const runs = [];
    for (let k = 0; k < line.length; k++) {
      const kind = kinds[off + k];
      if (runs.length && runs.at(-1).kind === kind) runs.at(-1).text += line[k];
      else runs.push({ text: line[k], kind });
    }
    out.push(runs);
    off += line.length + 1;
  }
  return out;
}
