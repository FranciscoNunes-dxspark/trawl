// /chart: a result set drawn as a chart in the terminal, pure. `planChart` picks the chart and its
// columns (from what the user named, else from the columns themselves); `drawChart` lays it out at a
// size as lines of { text, color } segments, the colours handed in (read from the theme while drawing).
import { fit, stringWidth } from './text.js';

export const CHART_TYPES = ['bars', 'line', 'histogram', 'scatter'];
const ALIASES = { bar: 'bars', bars: 'bars', line: 'line', lines: 'line', time: 'line', timeseries: 'line', series: 'line', hist: 'histogram', histogram: 'histogram', scatter: 'scatter', xy: 'scatter' };
const MAX_SERIES = 6;

/** A value as a number, or null: numbers, bigints and numeric text (Postgres's decimals come as text). */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^\s*-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(v)) return Number(v);
  return null;
}

const ISO = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** A value as a time in ms, or null: dates, and text in ISO form (a time without a zone taken as UTC). */
export function toTime(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v !== 'string' || !ISO.test(v.trim())) return null;
  const s = v.trim().replace(' ', 'T');
  const t = Date.parse(/T/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? `${s}Z` : /T/.test(s) ? s : `${s}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/** Each column's kind: 'date', 'number', 'text', or 'empty' when every value is NULL. */
export function columnKinds(set) {
  return set.columns.map((_, i) => {
    const values = set.rows.map((r) => r[i]).filter((v) => v != null);
    if (!values.length) return 'empty';
    if (values.every((v) => toTime(v) != null)) return 'date';
    if (values.every((v) => toNumber(v) != null)) return 'number';
    return 'text';
  });
}

// A key's number (Id, ClubId, club_id) says nothing worth a chart when there's another number.
const keyLike = (name) => /^id$|id$/i.test(name);

/**
 * The chart to draw from `args` (/chart [type] [x] [y…]): { type, x, y: [indexes], picked } where
 * `picked` says Trawl chose (nothing was named), or { reason } when it can't be drawn.
 */
export function planChart(set, args = []) {
  if (!set || !set.columns.length) return { reason: 'Run a query first: there is nothing to chart.' };
  if (!set.rows.length) return { reason: 'The result set has no rows to chart.' };
  const words = [...args];
  let type = null;
  if (words.length && ALIASES[words[0].toLowerCase()] && !set.columns.some((c) => c.name.toLowerCase() === words[0].toLowerCase())) type = ALIASES[words.shift().toLowerCase()];
  const named = [];
  for (const w of words) {
    const i = set.columns.findIndex((c) => c.name.toLowerCase() === w.toLowerCase());
    if (i < 0) return { reason: `No column named ${w}: the columns are ${set.columns.map((c) => c.name).join(', ')}.` };
    named.push(i);
  }
  const kinds = columnKinds(set);
  const idx = (k) => kinds.map((x, i) => (x === k ? i : -1)).filter((i) => i >= 0);
  const numbers = idx('number');
  // Numbers that aren't keys, unless keys are all there are.
  const values = numbers.filter((i) => !keyLike(set.columns[i].name)).length ? numbers.filter((i) => !keyLike(set.columns[i].name)) : numbers;
  const name = (i) => set.columns[i].name;
  const notNumber = (i) => `${name(i)} isn't a number column`;
  if (named.length) {
    const [x, ...y] = named;
    if (!type) {
      if (named.length === 1) type = kinds[x] === 'number' ? 'histogram' : null;
      else if (kinds[x] === 'date') type = 'line';
      else if (kinds[x] === 'number' && named.length === 2) type = 'scatter';
      else type = 'bars';
      if (!type) return { reason: `${notNumber(x)}: name a number column to chart against it (/chart ${name(x)} <number column>).` };
    }
    if (type === 'histogram') {
      if (kinds[x] !== 'number') return { reason: `A histogram needs a number column: ${notNumber(x)}.` };
      return { type, x, y: [] };
    }
    const ys = y.length ? y : values.filter((i) => i !== x).slice(0, type === 'bars' || type === 'scatter' ? 1 : MAX_SERIES);
    if (!ys.length) return { reason: `There's no number column to chart against ${name(x)}.` };
    const bad = ys.find((i) => kinds[i] !== 'number');
    if (bad != null) return { reason: `${notNumber(bad)}: it can't be on the chart's value axis.` };
    if (type === 'line' && kinds[x] !== 'date' && kinds[x] !== 'number') return { reason: `A line needs dates or numbers along it: ${name(x)} is text (try /chart bars).` };
    if (type === 'scatter' && kinds[x] !== 'number') return { reason: `A scatter needs two number columns: ${notNumber(x)}.` };
    return { type, x, y: type === 'scatter' ? ys.slice(0, 1) : ys.slice(0, MAX_SERIES) };
  }
  const dates = idx('date');
  const texts = idx('text');
  const auto = (() => {
    if ((!type || type === 'line') && dates.length && values.length) return { type: 'line', x: dates[0], y: values.slice(0, MAX_SERIES) };
    if ((!type || type === 'bars') && (texts.length || dates.length) && values.length) return { type: 'bars', x: texts[0] ?? dates[0], y: values.slice(0, 1) };
    if ((!type && values.length === 1) || (type === 'histogram' && values.length)) return { type: 'histogram', x: values[0], y: [] };
    if ((!type || type === 'scatter') && values.length >= 2) return { type: 'scatter', x: values[0], y: [values[1]] };
    if (type === 'line' && values.length >= 2) return { type: 'line', x: values[0], y: values.slice(1, 1 + MAX_SERIES) };
    return null;
  })();
  if (!auto) {
    if (!numbers.length) return { reason: 'Nothing to chart: the result set has no number columns.' };
    return { reason: `A ${type} chart doesn't fit these columns: /chart <type> <x column> <y columns…> names them.` };
  }
  return { ...auto, picked: true };
}

// ---------------------------------------------------------------------------------------------------
// Values as labels.

/** A number for an axis or a bar's end: whole numbers grouped (1,234), others to 4 significant digits. */
export function formatNumber(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return v.toLocaleString('en');
  const a = Math.abs(v);
  if (a >= 1e15 || (a !== 0 && a < 1e-4)) return v.toExponential(2);
  return String(Number(v.toPrecision(4)));
}

/** Times as dates when every one is at midnight (UTC, as the grid shows them), else with the minute. */
export function timeFormatter(times) {
  const days = times.every((t) => t % 86_400_000 === 0);
  return (t) => {
    const iso = new Date(t).toISOString();
    return days ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  };
}

const EIGHTHS_H = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const EIGHTHS_V = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** A horizontal bar `frac` (0 to 1) of `width` columns, in eighths. */
export function hbar(frac, width) {
  const eighths = Math.round(Math.max(0, Math.min(1, frac)) * width * 8);
  const full = Math.floor(eighths / 8);
  return '█'.repeat(full) + EIGHTHS_H[eighths % 8];
}

// ---------------------------------------------------------------------------------------------------
// Drawing.

const seg = (text, color) => (color ? { text, color } : { text });

/** What the rows hold for the chart: `kept` points and how many rows were `skipped` (NULL or not a value). */
function pointsOf(set, plan) {
  const xs = (v) => (plan.type === 'line' ? (toTime(v) ?? toNumber(v)) : plan.type === 'bars' ? v : toNumber(v));
  const kept = [];
  let skipped = 0;
  for (const row of set.rows) {
    const x = xs(row[plan.x]);
    const y = plan.y.map((i) => toNumber(row[i]));
    if (x == null || (plan.y.length && y.every((v) => v == null))) skipped++;
    else kept.push({ x, y });
  }
  return { kept, skipped };
}

/** The line under the chart: what was drawn from how many rows. */
function aboutRows(set, kept, skipped, extra = '') {
  const n = set.rows.length;
  const rows = `${n.toLocaleString('en')} row${n === 1 ? '' : 's'}`;
  const of = set.truncated ? `the first ${rows}, where the row limit stopped the query (m in Results fetches more)` : `${n === 1 ? 'the one row' : `all ${rows}`} Trawl has`;
  return `From ${of}${skipped ? `; ${skipped.toLocaleString('en')} without a value left out` : ''}${extra}.`;
}

/** The chart's title: what against what. */
export function chartTitle(set, plan) {
  const name = (i) => set.columns[i].name;
  if (plan.type === 'histogram') return `${name(plan.x)}: how many of each size`;
  if (plan.type === 'scatter') return `${name(plan.y[0])} against ${name(plan.x)}`;
  return `${plan.y.map(name).join(', ')} by ${name(plan.x)}`;
}

/**
 * The chart at `width` × `height` columns and lines: { lines, about }. `colors` is { axis, label,
 * negative, series: [colour per series] }.
 */
export function drawChart(set, plan, { width, height, colors = {} }) {
  const { kept, skipped } = pointsOf(set, plan);
  const c = { axis: colors.axis, label: colors.label, negative: colors.negative, series: colors.series?.length ? colors.series : [undefined] };
  if (!kept.length) return { lines: [[seg('No row has a value to chart.', c.label)]], about: aboutRows(set, kept, skipped) };
  const w = Math.max(20, width);
  const h = Math.max(5, height);
  if (plan.type === 'bars') return bars(set, plan, kept, skipped, w, h, c);
  if (plan.type === 'histogram') return histogram(set, plan, kept, skipped, w, h, c);
  return grid(set, plan, kept, skipped, w, h, c);
}

function legend(set, plan, c) {
  if (plan.y.length < 2) return [];
  const out = [];
  plan.y.forEach((i, k) => out.push(seg(k ? '   ●' : '●', c.series[k % c.series.length]), seg(` ${set.columns[i].name}`, c.label)));
  return [out];
}

function bars(set, plan, kept, skipped, w, h, c) {
  // Rows with the same label are added up, then the biggest first (by the first series).
  const byLabel = new Map();
  const labelOf = (x) => (x instanceof Date ? timeFormatter([x.getTime()])(x.getTime()) : String(x));
  for (const p of kept) {
    const key = labelOf(p.x);
    const sums = byLabel.get(key) ?? plan.y.map(() => null);
    p.y.forEach((v, k) => v != null && (sums[k] = (sums[k] ?? 0) + v));
    byLabel.set(key, sums);
  }
  const summed = byLabel.size < kept.length;
  const items = [...byLabel].map(([label, ys]) => ({ label, ys })).sort((a, b) => (b.ys[0] ?? -Infinity) - (a.ys[0] ?? -Infinity));
  const head = legend(set, plan, c);
  const per = plan.y.length;
  const room = Math.max(1, Math.floor((h - head.length - 1) / per));
  const shown = items.length > room ? items.slice(0, room) : items;
  const all = shown.flatMap((it) => it.ys.filter((v) => v != null));
  const maxAbs = Math.max(...all.map(Math.abs), 0) || 1;
  const valueW = Math.max(...all.map((v) => stringWidth(formatNumber(v))), 1);
  const labelW = Math.min(30, Math.floor(w * 0.3), Math.max(...shown.map((it) => stringWidth(it.label)), 1));
  const barW = Math.max(1, w - labelW - 2 - 1 - valueW);
  const lines = [...head];
  for (const it of shown) {
    it.ys.forEach((v, k) => {
      const label = k === 0 ? fit(it.label, labelW) : ' '.repeat(labelW);
      const color = v != null && v < 0 ? c.negative : c.series[k % c.series.length];
      const bar = v == null ? '' : hbar(Math.abs(v) / maxAbs, barW);
      lines.push([seg(label, c.label), seg(' │', c.axis), seg(bar || (v == null ? '' : '▏'), color), seg(` ${v == null ? 'NULL' : formatNumber(v)}`, c.label)]);
    });
  }
  const more = items.length - shown.length;
  return { lines, about: aboutRows(set, kept, skipped, `${summed ? '; rows with the same label added up' : ''}${more ? `; the ${more.toLocaleString('en')} smallest not shown (no room)` : ''}`) };
}

/** Axis labels for a value axis: the widest of them sets the axis's width. */
function yLabels(min, max, rows, fmt) {
  const at = (r) => max - ((max - min) * r) / Math.max(1, rows - 1);
  const marks = new Map([[0, fmt(max)], [rows - 1, fmt(min)]]);
  if (rows >= 7) marks.set(Math.floor((rows - 1) / 2), fmt(at(Math.floor((rows - 1) / 2))));
  return marks;
}

/** A line of x labels: first at the left, last at the right, the middle between when there's room. */
function xLabelLine(lead, plotW, first, last, middle) {
  const line = Array(plotW).fill(' ');
  const put = (text, at) => {
    const chars = [...text];
    const from = Math.max(0, Math.min(plotW - chars.length, at));
    for (let i = 0; i < chars.length && from + i < plotW; i++) line[from + i] = chars[i];
  };
  put(first, 0);
  put(last, plotW - [...last].length);
  if (middle && [...first].length + [...middle].length + [...last].length + 4 <= plotW) put(middle, Math.floor(plotW / 2 - [...middle].length / 2));
  return `${' '.repeat(lead)}${line.join('')}`;
}

function histogram(set, plan, kept, skipped, w, h, c) {
  const values = kept.map((p) => p.x);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const distinct = new Set(values).size;
  // About 20 bins, fewer when the values are fewer or the screen is narrow.
  const most = Math.max(1, Math.min(20, Math.floor((w - 8) / 2)));
  // Whole numbers over a small range: a bar per whole number.
  const whole = values.every(Number.isInteger);
  const each = whole && max - min + 1 <= most;
  const bins = each ? max - min + 1 : Math.min(most, distinct);
  const size = each ? 1 : (max - min) / bins;
  const counts = Array(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - min) / size))]++;
  const top = Math.max(...counts);
  const plotH = Math.max(2, h - 3);
  const marks = yLabels(0, top, plotH, (v) => formatNumber(Math.round(v)));
  const yW = Math.max(...[...marks.values()].map(stringWidth));
  const colW = Math.max(1, Math.floor((w - yW - 2) / bins));
  const plotW = colW * bins;
  const lines = [];
  for (let r = 0; r < plotH; r++) {
    const label = marks.has(r) ? fit(marks.get(r), yW, 'right') : ' '.repeat(yW);
    const segs = [seg(label, c.label), seg(marks.has(r) ? ' ┤' : ' │', c.axis)];
    let row = '';
    for (const n of counts) {
      const eighths = Math.round((n / top) * plotH * 8) - (plotH - 1 - r) * 8;
      const ch = EIGHTHS_V[Math.max(0, Math.min(8, eighths))];
      row += ch.repeat(Math.max(1, colW - (colW > 2 ? 1 : 0))) + (colW > 2 ? ' ' : '');
    }
    segs.push(seg(row, c.series[0]));
    lines.push(segs);
  }
  lines.push([seg(' '.repeat(yW), c.label), seg(` └${'─'.repeat(plotW)}`, c.axis)]);
  lines.push([seg(xLabelLine(yW + 2, plotW, formatNumber(min), formatNumber(max), formatNumber(Number(((min + max) / 2).toPrecision(4)))), c.label)]);
  const binText = each ? 'a bar per value' : `${bins} bars, each ${formatNumber(Number(size.toPrecision(3)))} wide`;
  return { lines, about: aboutRows(set, kept, skipped, `; ${binText}, the tallest ${formatNumber(top)} row${top === 1 ? '' : 's'}`) };
}

// A time series or a scatter: points on a character grid, with value axes on the left and bottom.
function grid(set, plan, kept, skipped, w, h, c) {
  const scatter = plan.type === 'scatter';
  const points = [...kept].sort((a, b) => a.x - b.x);
  const xs = points.map((p) => p.x);
  const ys = points.flatMap((p) => p.y.filter((v) => v != null));
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (y0 === y1) (y0 -= 1), (y1 += 1);
  const head = scatter ? [] : legend(set, plan, c);
  const plotH = Math.max(2, h - 2 - head.length);
  const marks = yLabels(y0, y1, plotH, formatNumber);
  const yW = Math.max(...[...marks.values()].map(stringWidth));
  const plotW = Math.max(4, w - yW - 2);
  const isTime = !scatter && set.rows.some((r) => toTime(r[plan.x]) != null);
  const fx = isTime ? timeFormatter(xs) : formatNumber;
  const col = (x) => (x1 === x0 ? Math.floor((plotW - 1) / 2) : Math.round(((x - x0) / (x1 - x0)) * (plotW - 1)));
  const row = (y) => Math.round(((y1 - y) / (y1 - y0)) * (plotH - 1));
  // Each cell: [char, series].
  const cells = Array.from({ length: plotH }, () => Array(plotW).fill(null));
  if (scatter) {
    const counts = Array.from({ length: plotH }, () => Array(plotW).fill(0));
    for (const p of points) if (p.y[0] != null) counts[row(p.y[0])][col(p.x)]++;
    counts.forEach((r, ri) => r.forEach((n, ci) => n && (cells[ri][ci] = [n >= 4 ? '●' : n >= 2 ? '•' : '·', 0])));
  } else {
    plan.y.forEach((_, k) => {
      // The points of a column averaged, then joined by dots to the next.
      const byCol = new Map();
      for (const p of points) {
        const v = p.y[k];
        if (v == null) continue;
        const at = col(p.x);
        const b = byCol.get(at) ?? { sum: 0, n: 0 };
        b.sum += v;
        b.n++;
        byCol.set(at, b);
      }
      const marked = [...byCol].map(([cx, b]) => [cx, b.sum / b.n]).sort((a, b) => a[0] - b[0]);
      marked.forEach(([cx, v], i) => {
        const next = marked[i + 1];
        if (next) for (let x = cx + 1; x < next[0]; x++) cells[row(v + ((next[1] - v) * (x - cx)) / (next[0] - cx))][x] ??= ['·', k];
      });
      for (const [cx, v] of marked) cells[row(v)][cx] = ['●', k];
    });
  }
  const lines = [...head];
  for (let r = 0; r < plotH; r++) {
    const label = marks.has(r) ? fit(marks.get(r), yW, 'right') : ' '.repeat(yW);
    const segs = [seg(label, c.label), seg(marks.has(r) ? ' ┤' : ' │', c.axis)];
    // Runs of one series' cells become one segment.
    let text = '';
    let color = null;
    for (const cell of cells[r]) {
      const cc = cell ? c.series[cell[1] % c.series.length] : null;
      if (cc !== color && text) (segs.push(seg(text, color)), (text = ''));
      color = cc;
      text += cell ? cell[0] : ' ';
    }
    if (text) segs.push(seg(text, color));
    lines.push(segs);
  }
  lines.push([seg(' '.repeat(yW), c.label), seg(` └${'─'.repeat(plotW)}`, c.axis)]);
  const mid = x0 === x1 ? null : fx(isTime ? x0 + Math.round((x1 - x0) / 2 / 60_000) * 60_000 : Number(((x0 + x1) / 2).toPrecision(4)));
  lines.push([seg(xLabelLine(yW + 2, plotW, fx(x0), x0 === x1 ? '' : fx(x1), mid), c.label)]);
  const note = scatter ? '; · one row, • two or three, ● four or more' : points.length > plotW ? '; points that share a column averaged' : '';
  return { lines, about: aboutRows(set, kept, skipped, note) };
}
