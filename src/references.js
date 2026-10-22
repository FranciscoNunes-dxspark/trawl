// Searching inside definitions (/grep) and what refers to what (/uses, u in the Explorer). Pure: the
// catalog queries are each dialect's grepSql and usesSql (dialects.js); actions.js runs them and shows
// what these make of the rows.
import { objectName, rowsOf } from './schema.js';

// sys.objects' types (and the ones the other dialects' queries give in the same letters).
const KINDS = { U: 'table', V: 'view', P: 'procedure', FN: 'function', IF: 'function', TF: 'function', TR: 'trigger', SN: 'synonym' };

export const kindOfType = (type) => (type == null ? null : KINDS[String(type).trim().toUpperCase()] ?? 'other');

/**
 * Where `text` appears in a definition, ignoring case: { count, lines: [{ line, text }] }, each line
 * (numbered from 1) once however many times it has the text, trimmed.
 */
export function matchesIn(definition, text) {
  const q = String(text ?? '').toLowerCase();
  const out = { count: 0, lines: [] };
  if (!q || definition == null) return out;
  String(definition)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((l, i) => {
      const low = l.toLowerCase();
      let n = 0;
      for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, at + q.length)) n++;
      if (!n) return;
      out.count += n;
      out.lines.push({ line: i + 1, text: l.trim() });
    });
  return out;
}

/**
 * grepSql's rows as the /grep list: each object whose definition has the text, with its kind, the
 * table a trigger is on, how many times it's there and the lines it's on. A row the server matched
 * but the text isn't in (a collation that folds accents, say) is left out.
 */
export function grepHits(sets, text) {
  return sets
    .flatMap(rowsOf)
    .map((r) => ({ schema: r.schema, name: r.name, kind: kindOfType(r.type) ?? 'other', parent: r.parent ?? null, ...matchesIn(r.definition, text) }))
    .filter((h) => h.count);
}

// A name in a definition, as a whole word: dbo.Players and [Players] count, PlayersArchive and #Players don't.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function mentions(definition, name) {
  if (definition == null || !name) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_@#$])${escapeRe(String(name))}(?![\\p{L}\\p{N}_@#$])`, 'iu').test(String(definition));
}

const key = (x) => `${x.kind}|${String(x.schema ?? '').toLowerCase()}|${String(x.name).toLowerCase()}`;

function addTo(list, item) {
  const old = list.find((x) => key(x) === key(item));
  if (!old) list.push(item);
  // What the catalog says beats what was found by name.
  else if (old.byName && !item.byName) old.byName = false;
}

/**
 * What /uses reports about `obj`: { usedBy, uses, triggers, keysIn, keysOut }. `rows` are usesSql's
 * (rel: used_by, uses or trigger). Where the dialect's catalog doesn't say (`byName`, its usesByName),
 * `named` are grepSql's rows for the object's name, those of the kinds in byName.usedBy that mention it
 * as a word being taken to use it, and `own` is the object's own definition, read for the names of the
 * schema's other objects. Those found that way are marked `byName`. Foreign keys come from the schema.
 */
export function usesReport(obj, schema, { rows = [], named = [], own = null, byName = null } = {}) {
  const self = { kind: obj.kind, schema: obj.schema, name: obj.name };
  const isSelf = (x) => key(x) === key(self);
  const usedBy = [];
  const uses = [];
  const triggers = [];
  for (const r of rows) {
    const item = { kind: kindOfType(r.type), schema: r.schema ?? null, name: r.name, parent: r.parent ?? null, database: r.database ?? null, byName: false };
    if (r.rel === 'trigger') addTo(triggers, { ...item, kind: 'trigger' });
    else if (r.rel === 'uses') addTo(uses, item);
    else addTo(usedBy, item);
  }
  if (byName) {
    for (const r of named) {
      const item = { kind: kindOfType(r.type), schema: r.schema, name: r.name, parent: r.parent ?? null, database: null, byName: true };
      if (!byName.usedBy.includes(item.kind) || isSelf(item) || !mentions(r.definition, obj.name)) continue;
      // A trigger on a table names it in its own definition: it's listed as one of the table's.
      if (item.kind === 'trigger' && triggers.some((t) => key(t) === key(item))) continue;
      addTo(usedBy, item);
    }
    if (own != null && byName.uses.includes(obj.kind)) {
      for (const o of schema?.objects ?? []) {
        const item = { kind: o.kind, schema: o.schema, name: o.name, parent: null, database: null, byName: true };
        if (!isSelf(item) && mentions(own, o.name)) addTo(uses, item);
      }
    }
  }
  const name = objectName(obj);
  const keys = schema?.foreignKeys ?? [];
  return {
    usedBy: usedBy.filter((x) => !(x.kind === 'trigger' && triggers.some((t) => key(t) === key(x)))),
    uses,
    triggers,
    keysIn: obj.kind === 'table' ? keys.filter((f) => f.to === name) : [],
    keysOut: obj.kind === 'table' ? keys.filter((f) => f.from === name) : [],
  };
}

const GROUPS = [
  ['table', 'Tables'],
  ['view', 'Views'],
  ['procedure', 'Procedures'],
  ['function', 'Functions'],
  ['trigger', 'Triggers'],
  ['synonym', 'Synonyms'],
  ['other', 'Other'],
  [null, 'Not in this database (another one, or missing)'],
];

const itemName = (x) => [x.database, x.schema, x.name].filter(Boolean).join('.');

function groupLines(items) {
  const lines = [];
  for (const [kind, title] of GROUPS) {
    const these = items.filter((x) => x.kind === kind).sort((a, b) => itemName(a).localeCompare(itemName(b)));
    if (!these.length) continue;
    lines.push(`  ${title}`);
    for (const x of these) lines.push(`    ${itemName(x)}${x.kind === 'trigger' && x.parent ? `  (on ${x.parent})` : ''}${x.byName ? '  · by name' : ''}`);
  }
  return lines;
}

const keyColumns = (f, i) => f.columns.map((c) => c[i]).join(', ');

/**
 * The report as the viewer shows it: what uses the object, grouped by kind (then the triggers on it
 * and the tables whose foreign keys refer to it), and what it uses (then its own foreign keys). `label`
 * names the server kind for `byName` (its usesByName), which says what was found by name.
 */
export function usesText(obj, report, { database, label, byName = null } = {}) {
  const { usedBy, uses, triggers, keysIn, keysOut } = report;
  const lines = [`${obj.kind} ${objectName(obj)}${database ? ` in ${database}` : ''}`, '', 'Used by'];
  const by = groupLines(usedBy);
  if (triggers.length) by.push('  Triggers on it', ...triggers.map((t) => `    ${itemName(t)}`));
  if (keysIn.length) by.push('  Tables, through their foreign keys', ...keysIn.map((f) => `    ${f.from} (${keyColumns(f, 0)}) → ${keyColumns(f, 1)}  ${f.name}`));
  lines.push(...(by.length ? by : ['  Nothing found.']), '', 'Uses');
  const to = groupLines(uses);
  if (keysOut.length) to.push('  Tables, through its foreign keys', ...keysOut.map((f) => `    ${f.to} (${keyColumns(f, 0)} → ${keyColumns(f, 1)})  ${f.name}`));
  lines.push(...(to.length ? to : ['  Nothing found.']), '');
  if (byName) {
    lines.push(
      `${label}'s catalog doesn't record what ${byName.what} refer to,`,
      'so those marked "by name" were found by the name in their definitions:',
      "a mention in a comment counts too, and SQL built as a string at run time doesn't.",
    );
  } else lines.push("From SQL Server's own record of the dependencies (sys.sql_expression_dependencies),", "which doesn't see SQL built as a string at run time (EXEC of a string).");
  return lines.join('\n');
}

/** "3 objects use it, it uses 2": the activity log's line. */
export function usesSummary(report) {
  const n = report.usedBy.length + report.triggers.length + report.keysIn.length;
  const m = report.uses.length + report.keysOut.length;
  const things = (k) => `${k} object${k === 1 ? '' : 's'}`;
  return `Used by ${things(n)}, uses ${things(m)}: the report is on screen.`;
}
