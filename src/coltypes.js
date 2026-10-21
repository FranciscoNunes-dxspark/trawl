// What a column's declared type is, whatever kind of server named it: SQL Server's nvarchar(100),
// Postgres's character varying(100) or timestamp with time zone, MySQL's int unsigned or
// tinyint(1). One shape for /generate's values and /scaffold's types to be picked from. Pure.

// family: int, decimal, float, bool, date, datetime, time, interval, text, guid, binary, json, xml,
// enum, rowversion (SQL Server's, which only the server writes) or other.
const SQLSERVER = {
  tinyint: { family: 'int', bits: 8, unsigned: true },
  smallint: { family: 'int', bits: 16 },
  int: { family: 'int', bits: 32 },
  bigint: { family: 'int', bits: 64 },
  bit: { family: 'bool' },
  decimal: { family: 'decimal' },
  numeric: { family: 'decimal' },
  money: { family: 'decimal', precision: 19, scale: 4 },
  smallmoney: { family: 'decimal', precision: 10, scale: 4 },
  float: { family: 'float', bits: 64 },
  real: { family: 'float', bits: 32 },
  date: { family: 'date' },
  datetime: { family: 'datetime' },
  datetime2: { family: 'datetime' },
  smalldatetime: { family: 'datetime' },
  datetimeoffset: { family: 'datetime', tz: true },
  time: { family: 'time' },
  char: { family: 'text' },
  varchar: { family: 'text' },
  text: { family: 'text' },
  nchar: { family: 'text', unicode: true },
  nvarchar: { family: 'text', unicode: true },
  ntext: { family: 'text', unicode: true },
  sysname: { family: 'text', unicode: true, length: 128 },
  uniqueidentifier: { family: 'guid' },
  binary: { family: 'binary' },
  varbinary: { family: 'binary' },
  image: { family: 'binary' },
  xml: { family: 'xml', unicode: true },
  timestamp: { family: 'rowversion' },
  rowversion: { family: 'rowversion' },
};

const POSTGRES = {
  smallint: { family: 'int', bits: 16 },
  int2: { family: 'int', bits: 16 },
  integer: { family: 'int', bits: 32 },
  int: { family: 'int', bits: 32 },
  int4: { family: 'int', bits: 32 },
  bigint: { family: 'int', bits: 64 },
  int8: { family: 'int', bits: 64 },
  smallserial: { family: 'int', bits: 16 },
  serial: { family: 'int', bits: 32 },
  bigserial: { family: 'int', bits: 64 },
  numeric: { family: 'decimal' },
  decimal: { family: 'decimal' },
  money: { family: 'decimal', precision: 19, scale: 2 },
  real: { family: 'float', bits: 32 },
  float4: { family: 'float', bits: 32 },
  'double precision': { family: 'float', bits: 64 },
  float8: { family: 'float', bits: 64 },
  boolean: { family: 'bool' },
  bool: { family: 'bool' },
  date: { family: 'date' },
  timestamp: { family: 'datetime' },
  'timestamp without time zone': { family: 'datetime' },
  'timestamp with time zone': { family: 'datetime', tz: true },
  timestamptz: { family: 'datetime', tz: true },
  time: { family: 'time' },
  'time without time zone': { family: 'time' },
  'time with time zone': { family: 'time', tz: true },
  timetz: { family: 'time', tz: true },
  interval: { family: 'interval' },
  'character varying': { family: 'text', unicode: true },
  varchar: { family: 'text', unicode: true },
  character: { family: 'text', unicode: true },
  char: { family: 'text', unicode: true },
  bpchar: { family: 'text', unicode: true },
  text: { family: 'text', unicode: true },
  citext: { family: 'text', unicode: true },
  name: { family: 'text', unicode: true, length: 63 },
  uuid: { family: 'guid' },
  bytea: { family: 'binary' },
  json: { family: 'json', unicode: true },
  jsonb: { family: 'json', unicode: true },
  xml: { family: 'xml', unicode: true },
};

const MYSQL = {
  tinyint: { family: 'int', bits: 8 },
  smallint: { family: 'int', bits: 16 },
  mediumint: { family: 'int', bits: 24 },
  int: { family: 'int', bits: 32 },
  integer: { family: 'int', bits: 32 },
  bigint: { family: 'int', bits: 64 },
  year: { family: 'int', bits: 16, min: 1901, max: 2155 },
  decimal: { family: 'decimal' },
  numeric: { family: 'decimal' },
  float: { family: 'float', bits: 32 },
  double: { family: 'float', bits: 64 },
  real: { family: 'float', bits: 64 },
  bit: { family: 'binary' },
  bool: { family: 'bool' },
  boolean: { family: 'bool' },
  date: { family: 'date' },
  datetime: { family: 'datetime' },
  timestamp: { family: 'datetime' },
  time: { family: 'time' },
  char: { family: 'text', unicode: true },
  varchar: { family: 'text', unicode: true },
  tinytext: { family: 'text', unicode: true, length: 255 },
  text: { family: 'text', unicode: true },
  mediumtext: { family: 'text', unicode: true },
  longtext: { family: 'text', unicode: true },
  binary: { family: 'binary' },
  varbinary: { family: 'binary' },
  tinyblob: { family: 'binary', length: 255 },
  blob: { family: 'binary' },
  mediumblob: { family: 'binary' },
  longblob: { family: 'binary' },
  json: { family: 'json', unicode: true },
  enum: { family: 'enum', unicode: true },
  set: { family: 'enum', unicode: true },
};

const TABLES = { sqlserver: SQLSERVER, postgres: POSTGRES, mysql: MYSQL };

// The largest value of a whole-number type.
const intMax = (bits, unsigned) => (unsigned ? 2 ** bits - 1 : 2 ** (bits - 1) - 1);

/**
 * A declared type as { type, base, family, bits, unsigned, tz, unicode, length, precision, scale,
 * values, min, max, array }. `length` is null when unbounded (nvarchar(max), text); `values` are an
 * enum's. `kind` is the server's ('sqlserver', 'postgres', 'mysql'): timestamp is a rowversion on
 * SQL Server and a date and time elsewhere, and MySQL's tinyint(1) and bit(1) are its booleans.
 */
export function typeInfo(type, kind = 'sqlserver') {
  const raw = String(type ?? '').trim();
  const lower = raw.toLowerCase();
  const array = /\[\]$/.test(lower);
  const args = lower.match(/\(([^)]*)\)/)?.[1] ?? null;
  const unsigned = /\bunsigned\b/.test(lower);
  const base = lower
    .replace(/\[\]$/, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(unsigned|signed|zerofill)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const table = TABLES[kind] ?? SQLSERVER;
  const known = table[base] ?? (kind === 'postgres' && /^timestamp\b/.test(base) ? table[/with time zone/.test(base) ? 'timestamptz' : 'timestamp'] : null);
  const info = { type: raw, base, family: 'other', bits: null, unsigned: false, tz: false, unicode: false, length: null, precision: null, scale: null, values: null, min: null, max: null, array, ...(known ?? {}) };
  if (unsigned) info.unsigned = true;
  if (array) return { ...info, family: 'other' };
  const nums = args && !/'/.test(args) ? args.split(',').map((s) => s.trim()) : [];
  if (info.family === 'text' || info.family === 'binary') {
    if (nums[0] && nums[0] !== 'max') info.length = Number(nums[0]);
  }
  if (info.family === 'decimal') {
    if (nums[0]) info.precision = Number(nums[0]);
    if (nums[1]) info.scale = Number(nums[1]);
    info.precision ??= 18;
    info.scale ??= 0;
  }
  if (info.family === 'enum') info.values = [...(args ?? '').matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  if (kind === 'mysql' && base === 'tinyint' && nums[0] === '1') Object.assign(info, { family: 'bool', bits: null });
  if (kind === 'mysql' && base === 'bit') Object.assign(info, nums[0] && nums[0] !== '1' ? { family: 'binary', length: Math.ceil(Number(nums[0]) / 8) } : { family: 'bool' });
  if (kind === 'sqlserver' && base === 'float' && nums[0] && Number(nums[0]) <= 24) info.bits = 32;
  if (info.family === 'int' && info.max == null) {
    info.min = info.unsigned ? 0 : -intMax(info.bits, false) - 1;
    info.max = intMax(info.bits, info.unsigned);
  }
  return info;
}
