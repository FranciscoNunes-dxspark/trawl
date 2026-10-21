// Formatting a query: each clause on a line of its own, SELECT's columns (and SET's assignments) one a
// line under it, joins indented under FROM with their ON under them, AND and OR indented, subqueries
// indented in their parentheses, and reserved words in capitals. Deliberately conservative: comments
// and strings stay as they are, and so does the spacing inside an expression (a=b stays a=b).
import { KEYWORDS, mask } from './sql.js';

const FILL = '\u0001';

// Words SQL Server doesn't reserve, which might be a column's name: left as they're written.
const NOT_RESERVED = new Set(['NEXT', 'ROW', 'ROWS', 'ONLY', 'NOCOUNT', 'OFFSET', 'OUTPUT', 'PARTITION', 'TRY', 'CATCH', 'THROW', 'USING', 'GO']);
const UPPER = new Set([...KEYWORDS, 'APPLY'].filter((k) => !NOT_RESERVED.has(k)));
const CLAUSES = new Set(['SELECT', 'FROM', 'WHERE', 'HAVING', 'VALUES', 'SET']);
const JOIN_MODS = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER']);
const SET_OPS = new Set(['UNION', 'EXCEPT', 'INTERSECT']);
// Where a SELECT's columns (or SET's assignments) end, at the level of the query.
const LIST_ENDS = new Set(['FROM', 'INTO', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'OPTION', 'FOR', 'WINDOW', 'OUTPUT', 'WHEN', ...SET_OPS, 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);
// What can come between SELECT and its first column, besides TOP (n).
const SELECT_MODS = new Set(['DISTINCT', 'ALL', 'PERCENT', 'WITH', 'TIES']);
// Statements this formats; anything else (a procedure, a block) is left alone.
const QUERY = /^(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)$/;

/** Words, punctuation and masked runs (strings, comments, [names]), with the space before each. */
function tokenize(src) {
  const m = mask(src);
  const out = [];
  let gap = '';
  for (let i = 0; i < src.length; ) {
    const ch = m[i];
    let j = i + 1;
    let kind = 'punct';
    if (ch === FILL) {
      while (j < src.length && m[j] === FILL) j++;
      kind = src.startsWith('--', i) ? 'line' : src.startsWith('/*', i) ? 'block' : 'raw';
    } else if (/\s/.test(ch)) {
      gap += ch;
      i++;
      continue;
    } else if (/[\w@#$]/.test(ch)) {
      while (j < src.length && /[\w@#$]/.test(m[j])) j++;
      kind = 'word';
    }
    out.push({ text: src.slice(i, j), kind, space: gap.length > 0, newline: gap.includes('\n') });
    gap = '';
    i = j;
  }
  return out;
}

/** Formats `sql`, or returns null when it isn't a query (a procedure, a block, a SET option). */
export function formatSql(sql) {
  const tokens = tokenize(String(sql).replace(/\r\n?/g, '\n').trim());
  const firstWord = tokens.find((t) => t.kind === 'word');
  if (!firstWord || !QUERY.test(firstWord.text.toUpperCase())) return null;
  if (tokens.some((t) => t.kind === 'word' && /^(BEGIN|CREATE|ALTER|DECLARE|IF|WHILE)$/i.test(t.text))) return null;

  const word = (k) => (tokens[k]?.kind === 'word' ? tokens[k].text.toUpperCase() : null);
  const nextWord = (k) => {
    for (let j = k + 1; j < tokens.length; j++) if (tokens[j].kind === 'word') return [j, word(j)];
    return [-1, null];
  };
  // "LEFT OUTER JOIN" starts at LEFT: is this word the first of a join?
  const startsJoin = (k) => {
    let j = k;
    while (JOIN_MODS.has(word(j))) j = nextWord(j)[0];
    const w = word(j);
    return (w === 'JOIN' || w === 'APPLY') && !JOIN_MODS.has(word(k - 1));
  };

  // The list after SELECT (past DISTINCT and TOP (n)) or SET: where each of its items starts and where
  // it ends. A comment on a comma's line stays there; commas in a call's parentheses or a CASE are
  // inside an item. With one item, nothing breaks.
  const listFrom = (k) => {
    let j = k + 1;
    while (j < tokens.length) {
      if (SELECT_MODS.has(word(j))) j++;
      else if (word(j) === 'TOP') {
        j++;
        if (tokens[j]?.text !== '(') j++;
        else {
          for (let depth = 0; j < tokens.length; j++) {
            if (tokens[j].text === '(') depth++;
            else if (tokens[j].text === ')' && !--depth) break;
          }
          j++;
        }
      } else break;
    }
    const items = [j];
    let depth = 0;
    let cases = 0;
    for (; j < tokens.length; j++) {
      const t = tokens[j];
      const w = word(j);
      if (t.text === '(') depth++;
      else if (t.text === ')' && !depth--) break;
      else if (w === 'CASE') cases++;
      else if (w === 'END' && cases) cases--;
      else if (!depth && !cases && (t.text === ';' || LIST_ENDS.has(w))) break;
      else if (!depth && !cases && t.text === ',') {
        const comment = ['line', 'block'].includes(tokens[j + 1]?.kind) && !tokens[j + 1].newline;
        items.push(j + (comment ? 2 : 1));
      }
    }
    return { items: new Set(items.length > 1 ? items : []), end: j };
  };

  let out = '';
  let list = { items: new Set(), end: -1 };
  const parens = [];
  let cases = 0;
  let clause = null;
  let between = false;
  const indent = () => '  '.repeat(parens.filter((p) => p.sub).length);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const prev = tokens[k - 1];
    const w = word(k);
    let sep = k === 0 ? '' : t.space ? ' ' : '';
    // In a list of several items, each item (and a comment line among them) is indented under its clause.
    const inList = list.items.size > 0 && k < list.end;
    if (prev?.kind === 'line' || ((t.kind === 'line' || t.kind === 'block') && t.newline)) sep = `\n${indent()}${inList ? '  ' : ''}`;
    if (list.items.has(k)) sep = `\n${indent()}  `;
    // Clauses break the line only at the level of the query (or a subquery), never inside an
    // expression's parentheses or a CASE.
    const level = (!parens.length || parens.at(-1).sub) && !cases;
    if (w && level && k > 0) {
      const brk = `\n${indent()}`;
      if (CLAUSES.has(w) || SET_OPS.has(w) || ((w === 'GROUP' || w === 'ORDER') && nextWord(k)[1] === 'BY')) sep = brk;
      else if (w === 'INTO' && clause === 'SELECT') sep = brk;
      // Joins under FROM, and their ON (with its AND and OR) under them.
      else if (startsJoin(k)) sep = `${brk}  `;
      else if (w === 'ON' && clause === 'JOIN') sep = `${brk}    `;
      else if ((w === 'AND' || w === 'OR') && clause === 'ON' && !between) sep = `${brk}    `;
      else if ((w === 'AND' || w === 'OR') && ['WHERE', 'HAVING'].includes(clause) && !between) sep = `${brk}  `;
      else if ((SET_OPS.has(word(k - 1)) && w !== 'ALL') || (word(k - 1) === 'ALL' && SET_OPS.has(word(k - 2)))) sep = brk;
    }
    if (prev?.text === ';' && !parens.length) sep = '\n';
    if (w === 'AND' && between) between = false;
    if (w === 'BETWEEN') between = true;
    if (w && level) {
      if (w === 'SELECT' || w === 'SET') list = listFrom(k);
      if (CLAUSES.has(w) || w === 'ON' || w === 'GROUP' || w === 'ORDER' || (w === 'INTO' && clause === 'SELECT')) clause = w;
      else if (w === 'JOIN' || w === 'APPLY') clause = 'JOIN';
    }
    if (w === 'CASE') cases++;
    else if (w === 'END' && cases) cases--;
    // Reserved words in capitals, except as part of a dotted name (t.[order] is already quoted).
    const dotted = prev?.text === '.' || tokens[k + 1]?.text === '.';
    const text = w && UPPER.has(w) && !dotted ? w : t.text;
    out += sep + text;
    // A subquery's clauses are its own; the outer one carries on after the parenthesis.
    if (t.text === '(') parens.push({ sub: ['SELECT', 'WITH'].includes(nextWord(k)[1]) && tokens[k + 1]?.kind === 'word', clause });
    else if (t.text === ')' && parens.length) clause = parens.pop().clause;
  }
  return out;
}
