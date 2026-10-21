// /generate: rows of made-up but plausible data for a table, as INSERT statements to read and run.
// Each value fits its column (type, length, nullability), names, emails, dates and amounts are
// guessed from the column's name, foreign keys take key values the referenced table already has
// (read by actions.js with refValuesSql), and primary-key and unique columns stay unique. The same
// seed gives the same rows. Pure.
import { typeInfo } from './coltypes.js';

/** A small, fast generator of numbers in [0, 1) from a seed: the same seed, the same numbers. */
export function random(seed = 1) {
  let a = typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : hash(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

const FIRST = ['Ana', 'Rui', 'Marta', 'João', 'Inês', 'Pedro', 'Sofia', 'Tiago', 'Clara', 'Hugo', 'Emma', 'Liam', 'Olivia', 'Noah', 'Mia', 'Lucas', 'Chloé', 'Mateo', 'Lena', 'Omar', 'Aisha', 'Kenji', 'Yara', 'Felix'];
const LAST = ['Silva', 'Santos', 'Costa', 'Pereira', 'Ferreira', 'Martins', 'García', 'López', 'Moreau', 'Dubois', 'Smith', 'Johnson', 'Brown', 'Müller', 'Schmidt', 'Rossi', 'Bianchi', "O'Brien", 'Nakamura', 'Kowalski', 'Novak', 'Jensen', 'Haddad', 'Okafor'];
const ORG_WORDS = ['Northwind', 'Atlas', 'Harbor', 'Summit', 'Lumen', 'Granite', 'Cedar', 'Riverside', 'Orion', 'Bluefin', 'Meridian', 'Kestrel'];
const ORG_ENDS = ['Traders', 'Group', 'Labs', 'United', 'Partners', 'Works', 'FC', 'Co.', 'Systems', 'Logistics'];
const PRODUCTS = ['Chair', 'Lamp', 'Notebook', 'Kettle', 'Backpack', 'Headphones', 'Mug', 'Desk', 'Jacket', 'Bottle', 'Keyboard', 'Umbrella'];
const ADJECTIVES = ['Classic', 'Compact', 'Deluxe', 'Eco', 'Pro', 'Mini', 'Smart', 'Vintage', 'Ultra', 'Basic'];
const CITIES = ['Lisbon', 'Porto', 'Madrid', 'Paris', 'Lyon', 'Berlin', 'Munich', 'Rome', 'Milan', 'London', 'Dublin', 'Amsterdam', 'Oslo', 'Tokyo', 'Toronto', 'Austin'];
const COUNTRIES = [
  ['PT', 'PRT', 'Portugal'],
  ['ES', 'ESP', 'Spain'],
  ['FR', 'FRA', 'France'],
  ['DE', 'DEU', 'Germany'],
  ['IT', 'ITA', 'Italy'],
  ['GB', 'GBR', 'United Kingdom'],
  ['IE', 'IRL', 'Ireland'],
  ['NL', 'NLD', 'Netherlands'],
  ['NO', 'NOR', 'Norway'],
  ['JP', 'JPN', 'Japan'],
  ['CA', 'CAN', 'Canada'],
  ['US', 'USA', 'United States'],
];
const STREETS = ['Main St', 'Oak Avenue', 'Rua Augusta', 'High Street', 'Calle Mayor', 'Rue de la Paix', 'Park Lane', 'Elm Road'];
const LOREM = 'the quick review shows steady progress across every team while new orders arrive early and late deliveries fall as planning improves with better data'.split(' ');
const STATUSES = ['Active', 'Pending', 'Closed', 'On hold'];
const CATEGORIES = ['General', 'Sales', 'Support', 'Finance', 'Operations', 'Marketing'];
const COLOURS = ['Red', 'Blue', 'Green', 'Black', 'White', 'Yellow', 'Grey'];
const CURRENCIES = ['EUR', 'USD', 'GBP', 'JPY', 'CHF'];
const CULTURES = ['en', 'en-GB', 'pt-PT', 'fr-FR', 'es-ES', 'de-DE'];

const DAY = 86_400_000;
const at = (s) => Date.parse(`${s}T00:00:00Z`);
const ascii = (s) => s.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/'/g, '');

// Which kind of value a column's name asks for, when its type allows text or numbers of that sort.
function guessFor(column, table) {
  const n = column.toLowerCase().replace(/[\s_-]+/g, '');
  const has = (re) => re.test(n);
  if (has(/e?mail/)) return 'email';
  if (has(/firstname|givenname|forename/)) return 'first';
  if (has(/lastname|surname|familyname/)) return 'last';
  if (has(/username|login|handle|nickname/)) return 'username';
  if (has(/phone|mobile|tel|fax/)) return 'phone';
  if (has(/url|website|homepage|link/)) return 'url';
  if (has(/city|town/)) return 'city';
  if (has(/country|nation/)) return 'country';
  if (has(/street|address|addr/)) return 'street';
  if (has(/zip|postal|postcode/)) return 'zip';
  if (has(/currency/)) return 'currency';
  if (has(/culture|locale|language|lang$/)) return 'culture';
  if (has(/colou?r/)) return 'colour';
  if (has(/status|state$/)) return 'status';
  if (has(/categor|type$|kind$|group$/)) return 'category';
  if (has(/description|notes?$|comment|remark|summary|body|text$|message|bio/)) return 'sentence';
  if (has(/title|subject|headline/)) return 'title';
  if (has(/sku|code$|ref$|reference/)) return 'code';
  if (has(/guid|uuid/)) return 'guid';
  if (has(/latitude|^lat$/)) return 'latitude';
  if (has(/longitude|^lng$|^lon$/)) return 'longitude';
  if (has(/price|amount|cost|total|salary|balance|fee|revenue|wage|payment/)) return 'money';
  if (has(/qty|quantity|stock|units/)) return 'quantity';
  if (has(/^age$/)) return 'age';
  if (has(/year/)) return 'year';
  if (has(/rating|stars/)) return 'rating';
  if (has(/percent|pct|rate$|ratio/)) return 'percent';
  if (has(/goals|score|points|wins|losses|count$/)) return 'small';
  if (has(/birth|dob/)) return 'birth';
  if (has(/gender|sex$/)) return 'gender';
  if (has(/password|hash|salt|token|secret/)) return 'hex';
  if (has(/fullname|^name$|displayname|contactname|personname/)) {
    const t = String(table).toLowerCase();
    if (/club|team|compan|organi|supplier|vendor|brand|store|shop|department|partner|stadium|venue|school|bank/.test(t)) return 'org';
    if (/product|item|article|good|book|course|project/.test(t)) return 'product';
    return 'person';
  }
  if (has(/name$/)) return 'title';
  return null;
}

/**
 * Makes `count` rows for `table` (a schema object). `refs`: for each foreign key from it,
 * { columns: [[column, referenced column]], to, rows: the referenced values, one array per row, in
 * the key's column order }. `unique`: names of columns besides the key that must not repeat.
 * Returns { columns, rows (JS values: numbers, strings, booleans, Dates, Buffers, null), notes }.
 */
export function generateRows(table, count, { seed = 1, kind = 'sqlserver', refs = [], unique = [] } = {}) {
  const rnd = random(seed);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const notes = [];
  const left = [];
  const used = [];
  for (const c of table.columns) {
    const t = typeInfo(c.type, kind);
    if (c.identity) left.push(`${c.name} (identity)`);
    else if (c.computed) left.push(`${c.name} (computed)`);
    else if (t.family === 'rowversion') left.push(`${c.name} (${t.base}, the server's)`);
    else if (t.family === 'other' || t.family === 'interval') left.push(`${c.name} (${c.type}: Trawl makes no values for it${c.nullable ? '' : ', so it needs a default'})`);
    else used.push({ col: c, t });
  }
  if (left.length) notes.push(`Left out: ${left.join(', ')}.`);
  const uniqueSet = new Set([...table.columns.filter((c) => c.pk).map((c) => c.name.toLowerCase()), ...unique.map((u) => u.toLowerCase())]);
  const uniques = used.filter((u) => uniqueSet.has(u.col.name.toLowerCase()) && !u.col.identity).map((u) => u.col.name);
  if (uniques.length) notes.push(`${uniques.join(', ')}: unique within these rows, but not checked against the rows the table has.`);
  // Unique whole numbers count up from a start of their own, away from the 1, 2, 3 a table has already.
  const starts = used.map(({ t }) => (t.family === 'int' ? (t.max >= 1_000_000 ? int(10_000, 900_000) : t.max >= 30_000 ? int(1_000, 20_000) : 1) : 0));
  // Each foreign key fills its columns together, from one referenced row.
  const fkOf = new Map();
  for (const fk of refs) {
    const cols = fk.columns.map(([from]) => used.findIndex((u) => u.col.name.toLowerCase() === from.toLowerCase()));
    if (cols.some((i) => i < 0)) continue;
    for (const i of cols) fkOf.set(i, fk);
    if (!fk.rows.length) {
      const nullable = cols.every((i) => used[i].col.nullable);
      notes.push(nullable ? `${fk.to} has no rows, so ${fk.columns.map((x) => x[0]).join(', ')} ${cols.length === 1 ? 'is' : 'are'} NULL.` : `${fk.to} has no rows to refer to: ${fk.columns.map((x) => x[0]).join(', ')} get made-up values, and the inserts fail until it has some.`);
    } else notes.push(`${fk.columns.map((x) => x[0]).join(', ')}: ${fk.columns.length === 1 ? 'a value' : 'values'} from ${fk.to} (${fk.rows.length}${fk.capped ? ', the first read' : ''} row${fk.rows.length === 1 ? '' : 's'}).`);
  }
  const seen = used.map(() => new Set());
  const rows = [];
  for (let r = 0; r < count; r++) {
    const row = new Array(used.length);
    const person = { first: pick(FIRST), last: pick(LAST) };
    const chosen = new Map();
    used.forEach(({ col, t }, i) => {
      const fk = fkOf.get(i);
      const isUnique = uniqueSet.has(col.name.toLowerCase());
      if (fk) {
        if (!fk.rows.length) {
          if (col.nullable) return void (row[i] = null);
        } else {
          if (!chosen.has(fk)) chosen.set(fk, isUnique ? fk.rows[r % fk.rows.length] : pick(fk.rows));
          const k = fk.columns.findIndex(([from]) => from.toLowerCase() === col.name.toLowerCase());
          return void (row[i] = chosen.get(fk)[k]);
        }
      }
      if (col.nullable && !isUnique && !col.pk && rnd() < 0.1) return void (row[i] = null);
      let v = valueFor(col, t, { table: table.name, person, r, int, pick, rnd, unique: isUnique, start: starts[i] });
      if (isUnique) {
        for (let tries = 0; seen[i].has(key(v)) && tries < 20; tries++) v = valueFor(col, t, { table: table.name, person: { first: pick(FIRST), last: pick(LAST) }, r, int, pick, rnd, unique: true, start: starts[i] });
        if (seen[i].has(key(v))) v = suffixed(v, t, r);
        seen[i].add(key(v));
      }
      row[i] = v;
    });
    rows.push(row);
  }
  for (const [i, { col, t }] of used.entries()) {
    if (uniqueSet.has(col.name.toLowerCase()) && !fkOf.has(i) && seen[i].size < count) notes.push(`${col.name} must be unique, and a ${t.base} has room for only ${seen[i].size} different values: some rows repeat one.`);
  }
  return { columns: used.map((u) => u.col), rows, notes };
}

const key = (v) => (v instanceof Date ? `d${v.getTime()}` : Buffer.isBuffer(v) ? `b${v.toString('hex')}` : `${typeof v}:${v}`);

// A value made unique by the row's number, still fitting its column.
function suffixed(v, t, r) {
  if (typeof v === 'number' && t.family === 'int') return Math.min(t.max, Math.max(t.min, r + 1));
  if (typeof v === 'string') {
    const tail = `-${r + 1}`;
    return t.length && v.length + tail.length > t.length ? `${v.slice(0, Math.max(0, t.length - tail.length))}${tail}`.slice(-t.length) : `${v}${tail}`;
  }
  if (v instanceof Date) return new Date(at('2020-01-01') + r * DAY);
  return v;
}

const fit = (s, t) => (t.length ? s.slice(0, t.length) : s);

function textFor(guess, t, { person, r, int, pick, rnd, table, unique }) {
  const { first, last } = person;
  const len = t.length ?? 4000;
  // Too short for words: letters (a country's code fits char(2) as itself).
  if (len < 4 && guess !== 'country' && guess !== 'gender' && guess !== 'currency' && guess !== 'culture') return Array.from({ length: len }, () => String.fromCharCode(65 + int(0, 25))).join('');
  const country = pick(COUNTRIES);
  switch (guess) {
    case 'email':
      return fit(`${ascii(first).toLowerCase()}.${ascii(last).toLowerCase()}${unique ? r + 1 : int(1, 99)}@example.com`, t);
    case 'first':
      return fit(first, t);
    case 'last':
      return fit(last, t);
    case 'username':
      return fit(`${ascii(first).toLowerCase()}${ascii(last).toLowerCase().slice(0, 3)}${int(1, 999)}`, t);
    case 'person':
      return fit(`${first} ${last}`, t);
    case 'org':
      return fit(`${pick(ORG_WORDS)} ${pick(ORG_ENDS)}`, t);
    case 'product':
      return fit(`${pick(ADJECTIVES)} ${pick(PRODUCTS)}`, t);
    case 'phone':
      return fit(`+1 555-${String(int(100, 999))}-${String(int(1000, 9999))}`, t);
    case 'url':
      return fit(`https://example.com/${ascii(first).toLowerCase()}-${int(1, 9999)}`, t);
    case 'city':
      return fit(pick(CITIES), t);
    case 'country':
      return len <= 2 ? country[0].slice(0, len) : len === 3 ? country[1] : fit(country[2], t);
    case 'street':
      return fit(`${int(1, 250)} ${pick(STREETS)}`, t);
    case 'zip':
      return fit(String(int(10000, 99999)), t);
    case 'currency':
      return fit(pick(CURRENCIES), t);
    case 'culture':
      return fit(pick(CULTURES.filter((c) => c.length <= len)) ?? 'en', t);
    case 'colour':
      return fit(pick(COLOURS), t);
    case 'status':
      return fit(pick(STATUSES), t);
    case 'category':
      return fit(pick(CATEGORIES), t);
    case 'gender':
      return fit(pick(['F', 'M']), t);
    case 'code':
      return fit(`${String.fromCharCode(65 + int(0, 25), 65 + int(0, 25), 65 + int(0, 25))}-${String(int(0, 9999)).padStart(4, '0')}`, t);
    case 'hex':
      return fit(Array.from({ length: Math.min(len, 32) }, () => '0123456789abcdef'[int(0, 15)]).join(''), t);
    case 'guid':
      return fit(guid(rnd), t);
    case 'title':
    case 'sentence': {
      const n = guess === 'title' ? int(2, 4) : int(6, 14);
      const ws = Array.from({ length: n }, () => pick(LOREM));
      const s = ws.join(' ');
      return fit(`${s[0].toUpperCase()}${s.slice(1)}${guess === 'sentence' ? '.' : ''}`, t);
    }
    case 'money':
      return fit(`${int(1, 999)}.${String(int(0, 99)).padStart(2, '0')}`, t);
    case 'birth':
      return fit(new Date(at('1950-01-01') + int(0, 55 * 365) * DAY).toISOString().slice(0, 10), t);
    default: {
      const ws = Array.from({ length: int(1, 3) }, () => pick(LOREM)).join(' ');
      return fit(`${ws[0].toUpperCase()}${ws.slice(1)}${unique ? ` ${r + 1}` : ''}`, t);
    }
  }
}

function guid(rnd) {
  const hex = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]);
  hex[12] = '4';
  hex[16] = '89ab'[Math.floor(rnd() * 4)];
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// A number of `t` (an int or decimal) that fits it, guided by the column's name.
function numberFor(guess, t, { int, rnd, r, unique, start = 1 }) {
  const lo = t.family === 'int' ? t.min : -(10 ** (t.precision - t.scale)) + 1;
  const hi = t.family === 'int' ? t.max : 10 ** (t.precision - t.scale) - 10 ** -t.scale;
  const clamp = (v) => Math.min(hi, Math.max(lo, v));
  const ranges = { money: [1, 1000], quantity: [1, 100], age: [18, 80], year: [1990, 2026], rating: [1, 5], percent: [0, 100], small: [0, 12], latitude: [-90, 90], longitude: [-180, 180] };
  if (unique && t.family === 'int') return clamp(start + r);
  const [a, b] = ranges[guess] ?? (t.family === 'int' ? [Math.max(lo, 0), Math.min(hi, t.bits === 8 ? 255 : 1000)] : [0, 1000]);
  if (t.family === 'int') return clamp(int(Math.ceil(clamp(a)), Math.floor(clamp(b))));
  const scale = t.family === 'decimal' ? t.scale : 2;
  const v = clamp(a + rnd() * (b - a));
  return Number(v.toFixed(Math.min(scale, guess === 'money' ? 2 : scale)));
}

function valueFor(col, t, ctx) {
  const guess = guessFor(col.name, ctx.table);
  const { int, pick, rnd, r } = ctx;
  switch (t.family) {
    case 'int':
    case 'decimal':
      return numberFor(guess, t, ctx);
    case 'float':
      return Number((numberFor(guess, { family: 'decimal', precision: 7, scale: 2 }, ctx)).toFixed(2));
    case 'bool':
      return rnd() < 0.5;
    case 'date': {
      const from = guess === 'birth' ? at('1950-01-01') : at('2020-01-01');
      const days = guess === 'birth' ? 55 * 365 : 6 * 365;
      return new Date(ctx.unique ? from + r * DAY : from + int(0, days) * DAY);
    }
    case 'datetime': {
      const base = at('2020-01-01') + (ctx.unique ? r * DAY : int(0, 6 * 365) * DAY);
      return new Date(base + int(0, 86_399) * 1000);
    }
    case 'time': {
      const s = int(0, 86_399);
      return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }
    case 'guid':
      return guid(rnd);
    case 'binary':
      return Buffer.from(Array.from({ length: Math.min(t.length ?? 16, 16) }, () => int(0, 255)));
    case 'json':
      return JSON.stringify({ id: r + 1, note: pick(LOREM) });
    case 'xml':
      return `<item id="${r + 1}">${pick(LOREM)}</item>`;
    case 'enum':
      return t.values?.length ? pick(t.values) : '';
    default:
      return textFor(guess, t, ctx);
  }
}

const pad = (n) => String(n).padStart(2, '0');
const dateText = (d, withTime) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}${withTime ? ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : ''}`;

/**
 * A value as a literal of `kind`'s SQL for a column of type `t` (typeInfo): N'…' for SQL Server's
 * Unicode text, TRUE/FALSE for Postgres's booleans, MySQL's backslashes escaped, binary as hex.
 */
export function literalFor(v, t, kind = 'sqlserver') {
  if (v == null) return 'NULL';
  const str = (s) => {
    let q = String(s).replace(/'/g, "''");
    if (kind === 'mysql') q = q.replace(/\\/g, '\\\\');
    return `${kind === 'sqlserver' && t.unicode ? 'N' : ''}'${q}'`;
  };
  if (typeof v === 'boolean') return kind === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return str(dateText(v, t.family === 'datetime' || t.family === 'other' || t.family === 'text'));
  if (Buffer.isBuffer(v)) return kind === 'postgres' ? `'\\x${v.toString('hex')}'::bytea` : `0x${v.toString('hex').toUpperCase()}`;
  return str(v);
}

/** The query that reads the values a foreign key can take from the table it refers to, at most `cap` rows, in a stable order. */
export function refValuesSql(dialect, fk, cap = 1000) {
  const [schema, ...rest] = fk.to.split('.');
  const table = `${dialect.quote(schema)}.${dialect.quote(rest.join('.'))}`;
  const cols = fk.columns.map((c) => dialect.quote(c[1])).join(', ');
  return dialect.kind === 'sqlserver' ? `SELECT TOP (${cap}) ${cols} FROM ${table} ORDER BY ${cols};` : `SELECT ${cols} FROM ${table} ORDER BY ${cols} LIMIT ${cap};`;
}

/**
 * The INSERT script for `count` generated rows of `table`, with comments saying what was guessed and
 * what was left out. `quote` names columns the dialect's way. A thousand rows to a statement (SQL
 * Server's most). Returns { script, rows, columns, notes }.
 */
export function generateScript(table, count, { seed = 1, kind = 'sqlserver', quote = (n) => `[${String(n).replace(/]/g, ']]')}]`, refs = [], unique = [] } = {}) {
  const { columns, rows, notes } = generateRows(table, count, { seed, kind, refs, unique });
  const name = `${quote(table.schema)}.${quote(table.name)}`;
  const head = [`-- ${count} row${count === 1 ? '' : 's'} of made-up data for ${table.schema}.${table.name} (seed ${seed}). Nothing has run: read it, then R runs it.`, ...notes.map((n) => `-- ${n}`)];
  if (!columns.length) return { script: [...head, ...rows.map(() => `INSERT INTO ${name} DEFAULT VALUES;`)].join('\n') + '\n', rows: count, columns: [], notes };
  const types = columns.map((c) => typeInfo(c.type, kind));
  const values = rows.map((row) => `(${row.map((v, i) => literalFor(v, types[i], kind)).join(', ')})`);
  const out = [];
  for (let i = 0; i < values.length; i += 1000) out.push(`INSERT INTO ${name} (${columns.map((c) => quote(c.name)).join(', ')}) VALUES\n  ${values.slice(i, i + 1000).join(',\n  ')};`);
  return { script: [...head, ...out].join('\n') + '\n', rows: count, columns: columns.map((c) => c.name), notes };
}
