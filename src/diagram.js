// /diagram: a table's foreign keys, out to some depth in both directions, as boxes joined by lines
// for the terminal, or as a Mermaid erDiagram. Pure, over the loaded schema (schema.js buildSchema's
// objects and foreignKeys), so it is the same for SQL Server, Postgres and MySQL.
import { findObject, objectName } from './schema.js';
import { fit, stringWidth } from './text.js';

/**
 * The tables and keys to draw: { root, nodes: [{ name, layer, object }], edges: [foreign key], depth }
 * or { reason }. Layers are the distance from `table` along foreign keys either way (at most
 * `depth`). Without a table, every table, layered from those that refer to nothing.
 */
export function diagramGraph(schema, table, { depth = 1 } = {}) {
  if (!schema) return { reason: 'Connect first: the diagram is drawn from the schema.' };
  const tables = schema.objects.filter((o) => o.kind === 'table');
  const byName = new Map(tables.map((o) => [objectName(o), o]));
  const fks = (schema.foreignKeys ?? []).filter((f) => byName.has(f.from) && byName.has(f.to));
  let roots;
  if (table) {
    const o = findObject(schema, table);
    if (!o) return { reason: `No table ${table} in ${schema.database}.` };
    if (o.kind !== 'table') return { reason: `${objectName(o)} is a ${o.kind}: only tables have foreign keys.` };
    roots = [objectName(o)];
  } else {
    if (!tables.length) return { reason: `${schema.database} has no tables.` };
    const refers = new Set(fks.filter((f) => f.from !== f.to).map((f) => f.from));
    roots = tables.map(objectName).filter((n) => !refers.has(n));
    // Every table refers to another, round in a circle: start anywhere.
    if (!roots.length) roots = [objectName(tables[0])];
  }
  const most = table ? depth : Infinity;
  const layer = new Map(roots.map((r) => [r, 0]));
  const next = (name) => fks.flatMap((f) => (f.from === name ? [f.to] : f.to === name ? [f.from] : []));
  let front = [...roots];
  for (let d = 1; front.length && d <= most; d++) {
    const found = [];
    for (const n of front) for (const m of next(n)) if (!layer.has(m)) (layer.set(m, d), found.push(m));
    front = found;
  }
  // Without a table: tables in no chain of keys are drawn too, at the start.
  if (!table) for (const n of byName.keys()) if (!layer.has(n)) layer.set(n, 0);
  const nodes = [...layer].map(([name, l]) => ({ name, layer: l, object: byName.get(name) }));
  const edges = fks.filter((f) => layer.has(f.from) && layer.has(f.to));
  return { root: table ? roots[0] : null, nodes, edges, depth: table ? depth : null };
}

/** The lines inside a table's box: its key and foreign key columns, in their order. */
export function boxColumns(object, edges) {
  const name = objectName(object);
  const fkCols = new Set(edges.filter((f) => f.from === name).flatMap((f) => f.columns.map((c) => c[0].toLowerCase())));
  const cols = object.columns.filter((c) => c.pk || fkCols.has(c.name.toLowerCase()));
  return cols.map((c) => ({ name: c.name, tag: [c.pk ? 'PK' : '', fkCols.has(c.name.toLowerCase()) ? 'FK' : ''].filter(Boolean).join(' ') }));
}

// Lines on the canvas are bits per cell; the glyph comes from the bits that meet there.
const U = 1;
const D = 2;
const L = 4;
const R = 8;
const GLYPH = { [U | D]: '│', [L | R]: '─', [D | R]: '╭', [D | L]: '╮', [U | R]: '╰', [U | L]: '╯', [U | D | R]: '├', [U | D | L]: '┤', [L | R | D]: '┬', [L | R | U]: '┴', [U | D | L | R]: '┼', [U]: '│', [D]: '│', [L]: '─', [R]: '─' };

/**
 * The diagram as lines of { text, color } segments, at most about `width` columns wide (boxes are
 * narrowed to fit; a very wide one is cut by the viewer). `colors`: { line, box, root, name, pk, fk, text }.
 */
export function drawDiagram(graph, { width = 100, colors = {} } = {}) {
  const { nodes, edges, root } = graph;
  const layers = Math.max(...nodes.map((n) => n.layer)) + 1;
  // Each layer's tables in order: the first by name (the table asked for first), the others by where
  // the tables they're joined to in the layer before sit, so the lines cross less.
  const columns = Array.from({ length: layers }, () => []);
  const at = new Map();
  for (let l = 0; l < layers; l++) {
    const here = nodes.filter((n) => n.layer === l);
    const pos = (n) => {
      const near = edges.flatMap((f) => (f.from === n.name ? [f.to] : f.to === n.name ? [f.from] : [])).map((m) => at.get(m)).filter((p) => p && p.layer === l - 1);
      return near.length ? near.reduce((s, p) => s + p.index, 0) / near.length : Infinity;
    };
    here.sort((a, b) => (a.name === root ? -1 : b.name === root ? 1 : pos(a) - pos(b) || a.name.localeCompare(b.name)));
    here.forEach((n, index) => at.set(n.name, { layer: l, index }));
    columns[l] = here;
  }
  // The gap after each layer holds a track per key that crosses it (or joins two of its tables).
  const gapEdges = Array.from({ length: layers }, () => []);
  for (const f of edges) {
    if (f.from === f.to) continue;
    const [a, b] = [at.get(f.from).layer, at.get(f.to).layer];
    gapEdges[Math.min(a, b)].push(f);
  }
  const gapW = gapEdges.map((g, i) => (i === layers - 1 && !g.length ? 0 : Math.max(1, g.length) + 2));
  const boxes = new Map();
  const cap = Math.max(16, Math.min(40, Math.floor((width - gapW.reduce((s, g) => s + g, 0)) / layers)));
  let x = 0;
  for (let l = 0; l < layers; l++) {
    const content = columns[l].map((n) => {
      const cols = boxColumns(n.object, edges);
      const self = edges.filter((f) => f.from === n.name && f.to === n.name);
      const lines = cols.length ? cols.map((c) => ({ ...c })) : [{ name: '(no keys)', tag: '' }];
      for (const f of self) lines.push({ name: `${f.columns.map((c) => c[0]).join(', ')} → itself`, tag: 'FK' });
      return { n, lines };
    });
    const natural = Math.max(...content.map(({ n, lines }) => Math.max(stringWidth(n.name), ...lines.map((c) => stringWidth(`${c.tag ? `${c.tag} ` : ''}${c.name}`))) + 4));
    const w = Math.min(cap, natural);
    let y = 0;
    for (const { n, lines } of content) {
      boxes.set(n.name, { x, y, w, h: lines.length + 4, lines, name: n.name, layer: l });
      y += lines.length + 5;
    }
    x += w + gapW[l];
  }
  const H = Math.max(...[...boxes.values()].map((b) => b.y + b.h));
  const W = x;
  const cells = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: ' ', color: null })));
  const bits = Array.from({ length: H }, () => Array(W).fill(0));
  const put = (r, c, ch, color) => {
    if (r >= 0 && r < H && c >= 0 && c < W) cells[r][c] = { ch, color };
  };
  const text = (r, c, s, color) => [...s].forEach((ch, i) => put(r, c + i, ch, color));
  // Boxes.
  for (const b of boxes.values()) {
    const border = b.name === root ? colors.root : colors.box;
    const inner = b.w - 2;
    text(b.y, b.x, `┌${'─'.repeat(inner)}┐`, border);
    text(b.y + 1, b.x, '│', border);
    text(b.y + 1, b.x + 1, fit(` ${b.name}`, inner), colors.name);
    text(b.y + 1, b.x + b.w - 1, '│', border);
    text(b.y + 2, b.x, `├${'─'.repeat(inner)}┤`, border);
    b.lines.forEach((c, i) => {
      const r = b.y + 3 + i;
      text(r, b.x, '│', border);
      const tag = c.tag ? `${c.tag} ` : '';
      text(r, b.x + 1, fit(` ${tag}`, Math.min(inner, stringWidth(tag) + 1)), c.tag.startsWith('PK') ? colors.pk : colors.fk);
      text(r, b.x + 1 + stringWidth(tag) + 1, fit(c.name, Math.max(0, inner - stringWidth(tag) - 1)), colors.text);
      text(r, b.x + b.w - 1, '│', border);
    });
    text(b.y + b.h - 1, b.x, `└${'─'.repeat(inner)}┘`, border);
  }
  // The row a key leaves or reaches a box at: its column's line, else the name's.
  const rowOf = (b, column) => {
    const i = b.lines.findIndex((c) => c.name.toLowerCase() === String(column).toLowerCase());
    return b.y + (i >= 0 ? 3 + i : 1);
  };
  const hline = (r, x1, x2) => {
    const [a, b] = x1 < x2 ? [x1, x2] : [x2, x1];
    for (let c = a; c <= b; c++) bits[r][c] |= (c > a ? L : 0) | (c < b ? R : 0);
  };
  const vline = (c, r1, r2) => {
    const [a, b] = r1 < r2 ? [r1, r2] : [r2, r1];
    for (let r = a; r <= b; r++) bits[r][c] |= (r > a ? U : 0) | (r < b ? D : 0);
  };
  const arrows = [];
  const joins = [];
  gapEdges.forEach((list, l) => {
    const first = columns[l][0] && boxes.get(columns[l][0].name);
    const gapStart = first.x + first.w;
    // The key reaching furthest down on the right takes the leftmost track, so lines that leave the
    // same row don't cross each other.
    const far = (f) => Math.max(...[f.from, f.to].map((n, k) => (boxes.get(n).layer === l + 1 || boxes.get(f.from).layer === boxes.get(f.to).layer ? rowOf(boxes.get(n), f.columns[0][k]) : -1)));
    [...list].sort((a, b) => far(b) - far(a)).forEach((f, i) => {
      const track = gapStart + 1 + i;
      const child = boxes.get(f.from);
      const parent = boxes.get(f.to);
      const ends = [child, parent].map((b, k) => {
        const r = rowOf(b, f.columns[0][k]);
        // A box in this layer is reached on its right side; one in the next layer on its left.
        const right = b.layer === l;
        return { r, stub: right ? b.x + b.w : b.x - 1, border: right ? b.x + b.w - 1 : b.x, right };
      });
      for (const e of ends) {
        hline(e.r, e.stub, track);
        // The line leaves the box's side.
        bits[e.r][e.stub] |= e.right ? L : R;
        joins.push(e);
      }
      vline(track, ends[0].r, ends[1].r);
      arrows.push(ends[1]);
    });
  });
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (bits[r][c]) put(r, c, GLYPH[bits[r][c]] ?? '┼', colors.line);
  for (const e of joins) put(e.r, e.border, e.right ? '├' : '┤', cells[e.r][e.border].color);
  // The arrow points at the table referred to.
  for (const e of arrows) put(e.r, e.stub, e.right ? '◀' : '▶', colors.line);
  return cells.map((row) => {
    const segs = [];
    for (const { ch, color } of row) {
      const last = segs.at(-1);
      if (last && last.color === color) last.text += ch;
      else segs.push(color ? { text: ch, color } : { text: ch });
    }
    // Trailing spaces say nothing.
    const end = segs.at(-1);
    if (end && !end.color) end.text = end.text.trimEnd();
    return segs.filter((s) => s.text);
  });
}

// Mermaid wants words: names keep their letters, digits and _, anything else becomes _.
const word = (s) => {
  const w = String(s).replace(/[^\p{L}\p{N}_]/gu, '_');
  return /^[\p{L}_]/u.test(w) ? w : `_${w}`;
};
const typeWord = (t) => {
  const w = String(t).replace(/,/g, '_').replace(/[^A-Za-z0-9_()[\]-]/g, '_');
  return /^[A-Za-z]/.test(w) ? w : `t${w}`;
};

/** The graph as a Mermaid erDiagram: every column of each table, its keys, and a relationship per foreign key. */
export function mermaidDiagram(graph) {
  const out = ['erDiagram'];
  const sorted = [...graph.nodes].sort((a, b) => a.layer - b.layer || a.name.localeCompare(b.name));
  for (const n of sorted) {
    const fkCols = new Set(graph.edges.filter((f) => f.from === n.name).flatMap((f) => f.columns.map((c) => c[0].toLowerCase())));
    out.push(`    ${word(n.name)} {`);
    for (const c of n.object.columns) {
      const keys = [c.pk ? 'PK' : '', fkCols.has(c.name.toLowerCase()) ? 'FK' : ''].filter(Boolean).join(', ');
      out.push(`        ${typeWord(c.type)} ${word(c.name)}${keys ? ` ${keys}` : ''}`);
    }
    out.push('    }');
  }
  for (const f of graph.edges) {
    const child = graph.nodes.find((n) => n.name === f.from).object;
    // A foreign key that can be NULL may refer to nothing.
    const optional = f.columns.some(([c]) => child.columns.find((x) => x.name.toLowerCase() === c.toLowerCase())?.nullable);
    out.push(`    ${word(f.to)} ${optional ? '|o' : '||'}--o{ ${word(f.from)} : "${String(f.name).replace(/"/g, "'")}"`);
  }
  return `${out.join('\n')}\n`;
}

/** /diagram's arguments: { table, depth, mermaid } or { reason }. */
export function parseDiagramArgs(words) {
  const out = { table: null, depth: 1, mermaid: false };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--mermaid') out.mermaid = true;
    else if (w === '--depth') {
      const n = Number(words[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 10) return { reason: '--depth takes a whole number from 1 to 10.' };
      out.depth = n;
    } else if (w.startsWith('--')) return { reason: `/diagram doesn't know ${w}: /diagram [table] [--depth n] [--mermaid].` };
    else if (out.table) return { reason: `One table at a time: ${out.table}, then ${w}?` };
    else out.table = w;
  }
  return out;
}
