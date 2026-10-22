// /scaffold: a table's or view's columns as code, from the schema Trawl read: a C# class, an EF Core
// entity (with [Key], [Column], [MaxLength] and nullable reference types), a TypeScript interface
// or a Python dataclass. Each column's type is mapped from what the server calls it (coltypes.js),
// and the TypeScript one from what that server's Node driver hands back. Pure.
import { typeInfo } from './coltypes.js';

export const LANGUAGES = ['csharp', 'ef', 'ts', 'python'];
const ALIASES = { csharp: 'csharp', 'c#': 'csharp', cs: 'csharp', class: 'csharp', ef: 'ef', efcore: 'ef', entity: 'ef', ts: 'ts', typescript: 'ts', python: 'python', py: 'python', dataclass: 'python' };
export const LANGUAGE_NAMES = { csharp: 'C# class', ef: 'EF Core entity', ts: 'TypeScript interface', python: 'Python dataclass' };

/** The language a name means ("c#", "typescript", "py"…), or null. */
export const languageOf = (name) => ALIASES[String(name ?? '').trim().toLowerCase()] ?? null;

const words = (name) =>
  String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

/** ClubId, club_id and "club id" all → ClubId. A leading digit gets an underscore. */
export function pascal(name) {
  const s = words(name)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
  return !s ? '_' : /^\d/.test(s) ? `_${s}` : s;
}

/** ClubId → club_id. */
export function snake(name) {
  const s = words(name)
    .map((w) => w.toLowerCase())
    .join('_');
  return !s ? '_' : /^\d/.test(s) ? `_${s}` : s;
}

/** Players → Player, Matches → Match, Categories → Category; a name that isn't plural stays. */
export function singular(name) {
  if (/ies$/i.test(name) && name.length > 4) return name.replace(/ies$/i, (m) => (m === 'IES' ? 'Y' : 'y'));
  if (/(ch|sh|x|ss|z)es$/i.test(name)) return name.slice(0, -2);
  if (/(ss|us|is)$/i.test(name)) return name;
  if (/s$/i.test(name) && name.length > 2) return name.slice(0, -1);
  return name;
}

const PY_KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));

// The C# type for a column, before nullability; `value` says whether it is a value type (int?) or a
// reference type (string?).
function csharpType(t, kind) {
  switch (t.family) {
    case 'int':
      if (t.bits === 8) return t.unsigned || kind === 'sqlserver' ? 'byte' : 'sbyte';
      if (t.bits === 16) return t.unsigned ? 'ushort' : 'short';
      if (t.bits === 64) return t.unsigned ? 'ulong' : 'long';
      return t.unsigned ? 'uint' : 'int';
    case 'decimal':
      return 'decimal';
    case 'float':
      return t.bits === 32 ? 'float' : 'double';
    case 'bool':
      return 'bool';
    case 'date':
      return 'DateOnly';
    case 'datetime':
      // Npgsql reads timestamptz as a UTC DateTime; SQL Server's datetimeoffset keeps its offset.
      return t.tz && kind === 'sqlserver' ? 'DateTimeOffset' : 'DateTime';
    case 'time':
      return 'TimeOnly';
    case 'interval':
      return 'TimeSpan';
    case 'guid':
      return 'Guid';
    case 'binary':
    case 'rowversion':
      return 'byte[]';
    case 'text':
    case 'json':
    case 'xml':
    case 'enum':
      return 'string';
    default:
      return 'object';
  }
}

const REFERENCE = new Set(['string', 'byte[]', 'object']);

// What each Node driver hands back for a type: tedious (SQL Server) gives bigint as a string, pg
// gives int8 and numeric as strings, and mysql2 gives decimal as a string and tinyint(1) as a number.
function tsType(t, kind) {
  switch (t.family) {
    case 'int':
      return t.bits === 64 && kind !== 'mysql' ? 'string' : 'number';
    case 'decimal':
      return kind === 'sqlserver' ? 'number' : 'string';
    case 'float':
      return 'number';
    case 'bool':
      return kind === 'mysql' ? (t.base === 'bit' ? 'Buffer' : 'number') : 'boolean';
    case 'date':
    case 'datetime':
      return 'Date';
    case 'time':
    case 'text':
    case 'xml':
    case 'guid':
      return 'string';
    case 'enum':
      return t.values?.length ? t.values.map((v) => JSON.stringify(v)).join(' | ') : 'string';
    case 'binary':
    case 'rowversion':
      return 'Buffer';
    default:
      return 'unknown';
  }
}

function pythonType(t) {
  switch (t.family) {
    case 'int':
      return ['int'];
    case 'decimal':
      return ['Decimal', 'from decimal import Decimal'];
    case 'float':
      return ['float'];
    case 'bool':
      return ['bool'];
    case 'date':
      return ['date', 'from datetime import date'];
    case 'datetime':
      return ['datetime', 'from datetime import datetime'];
    case 'time':
      return ['time', 'from datetime import time'];
    case 'interval':
      return ['timedelta', 'from datetime import timedelta'];
    case 'guid':
      return ['UUID', 'from uuid import UUID'];
    case 'binary':
    case 'rowversion':
      return ['bytes'];
    case 'text':
    case 'xml':
    case 'enum':
      return ['str'];
    default:
      return ['Any', 'from typing import Any'];
  }
}

// Names for the members, kept apart from each other and from the class's own name.
function memberNames(columns, make, { avoid = '', keywords = new Set(), escape = (n) => `${n}_` } = {}) {
  const seen = new Set([avoid.toLowerCase()]);
  return columns.map((c) => {
    let n = make(c.name);
    if (n.toLowerCase() === avoid.toLowerCase()) n = `${n}Value`;
    let k = 2;
    const stem = n;
    while (seen.has(n.toLowerCase())) n = `${stem}${k++}`;
    seen.add(n.toLowerCase());
    return keywords.has(n) ? escape(n) : n;
  });
}

const csString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function csharp(o, { kind, ef }) {
  const cls = pascal(singular(o.name));
  // PascalCase names can't be C#'s keywords, which are all lower case.
  const names = memberNames(o.columns, pascal, { avoid: cls });
  const keys = o.columns.filter((c) => c.pk);
  const usings = new Set();
  const lines = [];
  const body = o.columns.map((c, i) => {
    const t = typeInfo(c.type, kind);
    const base = csharpType(t, kind);
    const ref = REFERENCE.has(base);
    const type = c.nullable ? `${base}?` : base;
    const init = ref && !c.nullable ? ' = null!;' : '';
    const attrs = [];
    if (ef) {
      if (keys.length === 1 && c.pk) attrs.push('[Key]');
      attrs.push(`[Column(${csString(c.name)}, TypeName = ${csString(c.type)})]`);
      if ((t.family === 'text' || t.family === 'binary') && t.length) attrs.push(`[MaxLength(${t.length})]`);
      if (t.family === 'rowversion') attrs.push('[Timestamp]');
      else if (c.identity) attrs.push('[DatabaseGenerated(DatabaseGeneratedOption.Identity)]');
      else if (c.computed) attrs.push('[DatabaseGenerated(DatabaseGeneratedOption.Computed)]');
      if (attrs.some((a) => /^\[(Key|MaxLength|Timestamp)\b/.test(a))) usings.add('System.ComponentModel.DataAnnotations');
      usings.add('System.ComponentModel.DataAnnotations.Schema');
    }
    const name = names[i];
    return [...attrs.map((a) => `    ${a}`), `    public ${type} ${name} { get; set; }${init}`];
  });
  const classAttrs = [];
  if (ef) {
    classAttrs.push(`[Table(${csString(o.name)}, Schema = ${csString(o.schema)})]`);
    if (o.kind === 'view' || !keys.length) {
      classAttrs.push('[Keyless]');
      usings.add('Microsoft.EntityFrameworkCore');
    } else if (keys.length > 1) {
      classAttrs.push(`[PrimaryKey(${keys.map((c) => `nameof(${names[o.columns.indexOf(c)]})`).join(', ')})]`);
      usings.add('Microsoft.EntityFrameworkCore');
    }
    usings.add('System.ComponentModel.DataAnnotations.Schema');
  }
  if (usings.size) lines.push(...[...usings].sort().map((u) => `using ${u};`), '');
  lines.push(`// ${o.kind} ${o.schema}.${o.name}${ef && keys.length > 1 ? ' (a composite key: [PrimaryKey] needs EF Core 7 or later)' : ''}`);
  lines.push(...classAttrs, `public class ${cls}`, '{');
  body.forEach((b, i) => lines.push(...(ef && i ? [''] : []), ...b));
  lines.push('}');
  return lines.join('\n');
}

const tsKey = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

function typescript(o, { kind }) {
  const lines = [`// ${o.kind} ${o.schema}.${o.name}, as the ${kind === 'postgres' ? 'pg' : kind === 'mysql' ? 'mysql2' : 'tedious (mssql)'} driver returns its rows`, `export interface ${pascal(singular(o.name))} {`];
  for (const c of o.columns) lines.push(`  ${tsKey(c.name)}: ${tsType(typeInfo(c.type, kind), kind)}${c.nullable ? ' | null' : ''};`);
  lines.push('}');
  return lines.join('\n');
}

function python(o, { kind }) {
  const cls = pascal(singular(o.name));
  const names = memberNames(o.columns, snake, { keywords: PY_KEYWORDS });
  const imports = new Set(['from dataclasses import dataclass']);
  const fields = o.columns.map((c, i) => {
    const [type, imp] = pythonType(typeInfo(c.type, kind));
    if (imp) imports.add(imp);
    if (c.nullable) imports.add('from typing import Optional');
    const note = names[i].toLowerCase() !== c.name.toLowerCase() ? `  # ${c.name}` : '';
    return `    ${names[i]}: ${c.nullable ? `Optional[${type}]` : type}${note}`;
  });
  // One line per module, in order, as isort would: from datetime import date, datetime.
  const modules = new Map();
  for (const imp of imports) {
    const [, mod, name] = imp.match(/^from (\S+) import (\S+)$/);
    modules.set(mod, [...(modules.get(mod) ?? []), name]);
  }
  const sorted = [...modules].sort((x, y) => x[0].localeCompare(y[0])).map(([mod, list]) => `from ${mod} import ${list.sort().join(', ')}`);
  return [...sorted, '', '', `@dataclass`, `class ${cls}:`, `    """${o.kind} ${o.schema}.${o.name}"""`, ...(fields.length ? fields : ['    pass'])].join('\n');
}

/**
 * The code for table or view `o` (a schema object, with its columns) in `language` ('csharp', 'ef',
 * 'ts', 'python'), for a server of `kind`. A trailing newline, so it pastes as a file.
 */
export function scaffold(o, language = 'csharp', { kind = 'sqlserver' } = {}) {
  const lang = languageOf(language) ?? 'csharp';
  const text = lang === 'ts' ? typescript(o, { kind }) : lang === 'python' ? python(o, { kind }) : csharp(o, { kind, ef: lang === 'ef' });
  return `${text}\n`;
}
