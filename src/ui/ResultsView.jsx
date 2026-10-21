import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { canEdit, changesText, editText, emptyIsDefault, hasChanges, nextNewRow, noChanges, tsvText } from '../edit.js';
import { formatValue, isNumericType, viewOrder } from '../sql.js';
import { theme } from '../theme.js';
import { clean, fit, stringWidth } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

const SEP = ' │ ';
const MAX_COL = 40;

/** Column widths from the header and the first rows, so wide text doesn't push everything off screen. */
export function columnWidths(set, sample = 200) {
  return set.columns.map((c, i) => {
    let w = stringWidth(c.name);
    for (const row of set.rows.slice(0, sample)) w = Math.max(w, stringWidth(formatValue(row[i])));
    return Math.max(4, Math.min(MAX_COL, w));
  });
}

/** One row as "column  value" lines, for the record view. */
export function recordText(set, row) {
  const nameW = Math.max(...set.columns.map((c) => stringWidth(c.name))) + 2;
  return set.columns.map((c, i) => `${c.name.padEnd(nameW)}${formatValue(row[i])}`).join('\n');
}

/** The text being typed into a cell, `w` wide, scrolled so the cursor shows. */
function editingSegments({ text, cursor }, w) {
  const start = Math.max(0, cursor - w + 1);
  const shown = text.slice(start, start + w);
  const at = cursor - start;
  const after = clean(shown.slice(at + 1));
  return [
    { text: clean(shown.slice(0, at)), color: theme.warn },
    { text: shown[at] ?? ' ', inverse: true },
    { text: after + ' '.repeat(Math.max(0, w - at - 1 - stringWidth(after))) },
  ];
}

/**
 * The grid of the result set on screen. When it is the rows of one table with its key (see
 * edit.js), cells can be edited, rows deleted and new ones added (at the end, numbered after the
 * rows read): changes are staged (`changes`, kept by App) and `s` saves them all at once.
 */
export function ResultsView({ results, changes, setIndex, view, ctx, width, height, top = 0, active }) {
  const sets = results?.sets ?? [];
  const set = sets[setIndex];
  // o sorts and /filter narrows the rows on screen; they stay where they are in `set.rows`, so
  // staged edits (keyed by those indexes) still find theirs.
  const sort = view?.sort ?? null;
  const filter = view?.filter ?? '';
  const order = useMemo(() => (set ? viewOrder(set, { sort, filter }) : []), [set, sort, filter]);
  // The sorted column keeps room for its ▲ or ▼, and with new rows every column has room for DEFAULT.
  const adding = Boolean(changes?.inserts?.length && results?.edit?.table) && setIndex === 0;
  const widths = useMemo(
    () => (set ? columnWidths(set).map((w, i) => Math.max(sort?.col === i ? Math.max(w, Math.min(MAX_COL, stringWidth(set.columns[i].name) + 2)) : w, adding ? 7 : 0)) : []),
    [set, sort, adding],
  );
  const [colOffset, setColOffset] = useState(0);
  const [col, setColState] = useState(0);
  // Keys can come faster than renders (l then e), so the handler reads the column from a ref.
  const colRef = useRef(0);
  // The cell being typed into: { row, col, text, cursor }. A ref as well, since ↵ can arrive
  // before the render after the last key.
  const [editing, setEditingState] = useState(null);
  const editingRef = useRef(null);
  const setEditing = (next) => {
    editingRef.current = next;
    setEditingState(next);
  };
  const innerW = width - 2;
  const innerH = height - 2;
  const edit = results?.edit;
  const editable = Boolean(edit?.table) && setIndex === 0;
  // A cell cursor where a cell means something: rows that can be edited, or whose foreign keys F follows.
  const hasCursor = editable || (Boolean(results?.source?.table) && setIndex === 0);
  const pending = changes ?? noChanges();
  // New rows come after the rows read, whatever the sort or filter.
  const inserts = editable ? (pending.inserts ?? []) : [];
  const shownRows = inserts.length ? [...order, ...inserts] : order;
  const isNew = (row) => Boolean(set) && row >= set.rows.length;
  // Under the grid: unsaved changes first, then the error and the server's messages.
  const notes = (results?.messages ?? []).map((text) => ({ text, color: theme.dim }));
  if (results?.error) notes.unshift({ text: results.error, color: theme.del });
  if (editable && hasChanges(pending)) notes.unshift({ text: `${changesText(pending)} not saved · s saves · u undoes the row · U all`, color: theme.warn });
  const noteLines = Math.min(3, notes.length);
  const gridH = Math.max(1, innerH - 2 - noteLines);
  const nav = useListNav(shownRows.length, gridH, { resetKey: `${results?.id}:${setIndex}:${sort?.col}:${sort?.dir}:${filter}` });
  // Editable rows have a cell cursor; other results just scroll, the first column shown standing in for it.
  const cur = Math.min(hasCursor ? col : colOffset, Math.max(0, widths.length - 1));

  // The columns that fit, from the first one scrolled to; moving the cursor off screen scrolls.
  const layout = (from) => {
    const shown = [];
    let used = 2;
    for (let i = from; i < widths.length; i++) {
      const w = Math.min(widths[i], innerW - used);
      if (w < 4 && shown.length) break;
      shown.push({ i, w });
      used += w + SEP.length;
      if (used >= innerW) break;
    }
    return shown;
  };
  // shift+wheel scrolls the columns and leaves the cell cursor where it was, out of sight if need be,
  // until it moves again.
  const colFree = useRef(false);
  let firstCol = Math.min(colOffset, Math.max(0, widths.length - 1), colFree.current ? Infinity : cur);
  let shown = layout(firstCol);
  while (!colFree.current && shown.length && cur > shown.at(-1).i && firstCol < cur) shown = layout(++firstCol);
  if (firstCol !== colOffset) queueMicrotask(() => setColOffset(firstCol));

  const setCol = (c) => {
    const next = Math.max(0, Math.min(widths.length - 1, c));
    colFree.current = false;
    colRef.current = next;
    setColState(next);
    if (!hasCursor) setColOffset(next);
  };
  const key = (row, c) => `${row}:${c}`;

  // Why a cell can't be changed, or null when it can.
  const cellRefusal = (c) => {
    if (!edit?.table) return `These rows can't be edited: ${edit?.reason ?? 'nothing to edit'}.`;
    const tc = edit.columns.get(c);
    if (!tc) return `${set.columns[c].name} isn't a column of ${edit.table.name} as it is (an expression, or renamed), so it can't be edited.`;
    if (!canEdit(tc)) return `${tc.name} is ${tc.identity ? 'an identity column' : tc.type}; the server sets it.`;
    return null;
  };
  const stage = (row, c, value) =>
    ctx.setChanges((ch) => {
      const cells = new Map(ch.cells);
      // Typing back what was there undoes the change; in a new row, nothing typed (where a value
      // can't be empty text) leaves it to the default.
      if (isNew(row) ? value === '' && emptyIsDefault(edit.columns.get(c).type) : value === (set.rows[row][c] == null ? null : editText(set.rows[row][c]))) cells.delete(key(row, c));
      else cells.set(key(row, c), value);
      return { ...ch, cells };
    });
  const dropNewRow = (row) =>
    ctx.setChanges((ch) => ({ ...ch, cells: new Map([...ch.cells].filter(([at]) => !at.startsWith(`${row}:`))), inserts: (ch.inserts ?? []).filter((r) => r !== row) }));
  // a: a blank row at the end, every cell DEFAULT until it's given a value, the cursor on it.
  const addRow = () => {
    if (!edit?.table) return ctx.note(`Rows can't be added here: ${edit?.reason ?? 'nothing to edit'}.`, 'error');
    ctx.setChanges((ch) => ({ ...ch, inserts: [...(ch.inserts ?? []), nextNewRow(set, ch)] }));
    nav.setIndex(order.length + ctx.changes.inserts.length - 1);
    const first = set.columns.findIndex((_, i) => !cellRefusal(i));
    if (first >= 0) setCol(first);
  };
  // The cell as the viewer (v, /cell) shows it: what's staged there, if anything, else what was read.
  const cellAt = (row, c) => {
    if (!set || row == null || !set.columns[c]) return null;
    const staged = editable && ctx.changes.cells.has(key(row, c));
    const added = isNew(row);
    return {
      set,
      row,
      col: c,
      width,
      label: added ? `new row ${(ctx.changes.inserts ?? []).indexOf(row) + 1}` : `row ${row + 1} of ${set.rows.length}`,
      value: staged ? ctx.changes.cells.get(key(row, c)) : set.rows[row]?.[c],
      edited: staged,
      isDefault: added && !staged,
    };
  };
  const startEditing = (row, c) => {
    const refusal = cellRefusal(c);
    if (refusal) return ctx.note(refusal, 'error');
    if (pending.deletes.has(row)) return ctx.note('This row is marked for deletion; u keeps it.', 'error');
    const staged = pending.cells.get(key(row, c));
    const text = staged !== undefined ? (staged ?? '') : isNew(row) ? '' : editText(set.rows[row][c]);
    setEditing({ row, col: c, text, cursor: text.length });
    ctx.setCellEditing(true);
  };
  // The next column along that can take a value, for tab.
  const nextEditable = (c) => {
    for (let i = c + 1; i < set.columns.length; i++) if (!cellRefusal(i)) return i;
    return null;
  };

  const cellKeys = (input, k) => {
    const e = editingRef.current;
    if (!e) return;
    const put = (text, cursor) => setEditing({ ...e, text, cursor });
    if (k.escape) {
      setEditing(null);
      return ctx.setCellEditing(false);
    }
    if (k.return || k.tab) {
      stage(e.row, e.col, e.text);
      setEditing(null);
      ctx.setCellEditing(false);
      const next = k.tab ? nextEditable(e.col) : null;
      if (next != null) {
        setCol(next);
        queueMicrotask(() => startEditing(e.row, next));
      }
      return;
    }
    if (k.leftArrow) return put(e.text, Math.max(0, e.cursor - 1));
    if (k.rightArrow) return put(e.text, Math.min(e.text.length, e.cursor + 1));
    if (k.home || (k.ctrl && input === 'a')) return put(e.text, 0);
    if (k.end || (k.ctrl && input === 'e')) return put(e.text, e.text.length);
    if (k.ctrl && input === 'u') return put('', 0);
    if (k.backspace || k.delete) return e.cursor > 0 ? put(e.text.slice(0, e.cursor - 1) + e.text.slice(e.cursor), e.cursor - 1) : undefined;
    if (k.ctrl || k.meta || !input) return;
    const text = input.replace(/\r?\n/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    if (text) put(e.text.slice(0, e.cursor) + text + e.text.slice(e.cursor), e.cursor + text.length);
  };

  const keys = (input, k) => {
    if (ctx.cellHasKeys()) return cellKeys(input, k);
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, k)) return;
    const row = shownRows[nav.current()];
    const cur = Math.min(hasCursor ? colRef.current : colOffset, Math.max(0, widths.length - 1));
    if (k.leftArrow || input === 'h') setCol(cur - 1);
    else if (k.rightArrow || input === 'l') setCol(cur + 1);
    else if (input === '[' && setIndex > 0) (ctx.setResultIndex(setIndex - 1), setColOffset(0), setCol(0));
    else if (input === ']' && setIndex < sets.length - 1) (ctx.setResultIndex(setIndex + 1), setColOffset(0), setCol(0));
    else if (input === 'x') ctx.prefill('/export ');
    else if (input === 'o' && set) ctx.sortResults(cur);
    else if (input === 'p') a.pinResult(ctx);
    else if (input === 'c') a.compareResults(ctx);
    else if (input === 'f' && set) ctx.prefill('/filter ');
    else if (input === 'y' && set?.rows[row]) ctx.copy(editText(set.rows[row][cur]), `${set.columns[cur].name}'s value`);
    else if (input === 'Y' && set?.rows[row]) ctx.copy(tsvText(set, { header: false, rows: [set.rows[row]] }), `row ${row + 1}, tab-separated`);
    else if (k.return && set?.rows[row]) ctx.showText(`Row ${row + 1} of ${set.rows.length}`, recordText(set, set.rows[row]));
    else if (input === 'a' && set) addRow();
    else if (row == null || !set) return;
    else if (input === 'v') {
      ctx.cellOnScreen = cellAt(row, cur);
      a.showCell(ctx);
    } else if (input === 'F') isNew(row) ? ctx.note('This row is new: it refers to nothing until it is saved.', 'error') : a.followKey(ctx, { row, col: cur });
    else if (input === 'e' || input === 'i') startEditing(row, cur);
    else if (input === 'n') {
      const refusal = cellRefusal(cur);
      if (refusal) return ctx.note(refusal, 'error');
      const tc = edit.columns.get(cur);
      if (!tc.nullable) return ctx.note(`${tc.name} can't be NULL.`, 'error');
      stage(row, cur, null);
    } else if (input === 'd') {
      if (!edit?.table) return ctx.note(`These rows can't be deleted from here: ${edit?.reason ?? 'nothing to edit'}.`, 'error');
      if (isNew(row)) return dropNewRow(row);
      ctx.setChanges((ch) => {
        const deletes = new Set(ch.deletes);
        deletes.has(row) ? deletes.delete(row) : deletes.add(row);
        return { ...ch, deletes };
      });
    } else if (input === 'u') {
      if (isNew(row)) return dropNewRow(row);
      ctx.setChanges((ch) => ({ ...ch, cells: new Map([...ch.cells].filter(([at]) => !at.startsWith(`${row}:`))), deletes: new Set([...ch.deletes].filter((r) => r !== row)) }));
    } else if (input === 'U') ctx.setChanges(noChanges());
    else if (input === 's') a.saveEdits(ctx);
  };
  useInput(keys, { isActive: active });

  // Clicking away from the cell being typed into (the prompt, another tab) keeps what was typed, as ↵ does.
  const leaveCell = useRef(null);
  leaveCell.current = () => editingRef.current && cellKeys('', { return: true });
  useEffect(() => {
    if (!active) leaveCell.current();
  }, [active]);
  // The cell under the cursor, for /cell; forgotten when the grid goes, unless another grid has taken over.
  const shownCell = useRef(null);
  shownCell.current = ctx.cellOnScreen = cellAt(shownRows[nav.index], cur);
  useEffect(
    () => () => {
      leaveCell.current();
      if (ctx.cellOnScreen === shownCell.current) ctx.cellOnScreen = null;
    },
    [],
  );

  const scrollCols = (n) => {
    colFree.current = hasCursor;
    setColOffset((o) => Math.max(0, Math.min(widths.length - 1, o + n)));
  };
  // The grid's rows start under the border, the column names and the line under them; its cells
  // after the border and the ❯, each followed by a separator (a click on one goes to the cell before).
  useMouse(
    ctx,
    (e) => {
      if (!set) return;
      if (e.wheel) return e.shift ? scrollCols(e.wheel) : nav.scrollBy(e.wheel * 3);
      leaveCell.current();
      // Under the console: a click there is about the results, so typing stops.
      if (top) ctx.setEditing(false);
      if (!nav.pick(e.y - 3)) return;
      if (hasCursor) {
        let x = 3;
        const starts = shown.map(({ w }) => {
          const from = x;
          x += w + SEP.length;
          return from;
        });
        const hit = shown.findLast((_, k) => k === 0 || e.x >= starts[k]);
        if (hit) setCol(hit.i);
      }
      // A double-click shows the record, as ↵ does.
      if (e.double) keys('', { return: true });
    },
    { top },
  );

  // Where /follow starts from: the cell under the cursor.
  ctx.resultCell = set && order[nav.index] != null && setIndex === 0 ? { row: order[nav.index], col: cur } : null;

  if (!results) {
    return (
      <Panel title="Results" width={width} height={height} focused={active}>
        <Row pointer={false} width={innerW} segments={[{ text: '  Nothing has run yet. ↵ on a table in the Explorer, or ! and some SQL at the prompt.', color: theme.dim }]} />
      </Panel>
    );
  }

  const numeric = set ? set.columns.map((c) => isNumericType(c.type)) : [];
  const cells = (values, style) =>
    shown.flatMap(({ i, w }, k) => {
      const s = style(i, values[i]);
      return [...(k ? [{ text: SEP, color: theme.border }] : []), ...(s.segments ?? [{ ...s, text: fit(s.text, w, numeric[i] ? 'right' : 'left') }])];
    });
  const rowCells = (row, r) => (i, v) => {
    if (editing && editing.row === r && editing.col === i) return { segments: editingSegments(editing, shown.find((x) => x.i === i).w) };
    const deleted = pending.deletes.has(r);
    const at = `${r}:${i}`;
    const staged = pending.cells.has(at);
    const value = staged ? pending.cells.get(at) : v;
    const here = hasCursor && active && r === shownRows[nav.index] && i === cur;
    // A new row's cells are DEFAULT until given a value.
    if (isNew(r)) return staged ? { text: value === null ? 'NULL' : value, color: theme.ok, bold: true, italic: value === null, underline: here } : { text: 'DEFAULT', color: theme.dim, italic: true, underline: here };
    if (deleted) return { text: formatValue(v), color: theme.del, strike: true, underline: here };
    if (staged) return { text: value === null ? 'NULL' : value, color: theme.warn, bold: true, italic: value === null, underline: here };
    return { text: formatValue(v), color: v == null ? theme.nul : numeric[i] ? theme.number : undefined, italic: v == null, underline: here };
  };

  const parts = [];
  if (sets.length > 1) parts.push(`set ${setIndex + 1}/${sets.length}`);
  if (set && filter) parts.push(`"${filter}": ${order.length} of ${set.rows.length}${set.truncated ? '+' : ''} rows`);
  else if (set) parts.push(`${set.rows.length}${set.truncated ? '+' : ''} row${set.rows.length === 1 ? '' : 's'}`);
  if (set && sort) parts.push(`by ${set.columns[sort.col]?.name} ${sort.dir > 0 ? '▲' : '▼'}`);
  if (set && widths.length > shown.length) parts.push(`cols ${firstCol + 1}–${firstCol + shown.length}/${widths.length}`);
  if (results.ms != null) parts.push(`${results.ms} ms`);

  return (
    <Panel title={results.title} hint={parts.join(' · ')} width={width} height={height} focused={active}>
      {set ? (
        <Box flexDirection="column">
          <Row
            pointer={false}
            width={innerW}
            segments={[{ text: '  ' }, ...cells(set.columns.map((c, i) => (sort?.col === i ? `${c.name} ${sort.dir > 0 ? '▲' : '▼'}` : c.name)), (i, v) => ({ text: v, bold: true, color: theme.accent, underline: hasCursor && i === cur }))]}
          />
          <Row pointer={false} width={innerW} segments={[{ text: '  ' }, ...shown.flatMap(({ w }, k) => [...(k ? [{ text: '─┼─', color: theme.border }] : []), { text: '─'.repeat(w), color: theme.border }])]} />
          {shownRows.slice(nav.offset, nav.offset + gridH).map((r, k) => (
            <Row key={r} width={innerW} selected={nav.offset + k === nav.index} focused={active} segments={cells(set.rows[r] ?? [], rowCells(set.rows[r], r))} />
          ))}
          {shownRows.length === 0 ? <Row pointer={false} width={innerW} segments={[{ text: set.rows.length ? `  (no rows contain "${filter}": /filter with nothing shows them all)` : '  (no rows)', color: theme.dim }]} /> : null}
          {Array.from({ length: Math.max(0, gridH - Math.max(1, shownRows.length - nav.offset)) }, (_, k) => (
            <Row key={`pad${k}`} pointer={false} width={innerW} segments={[]} />
          ))}
        </Box>
      ) : (
        <Lines width={innerW} height={gridH + 2} lines={[[{ text: '  No result set: the statement returned no rows to show.', color: theme.dim }]]} />
      )}
      <Lines
        width={innerW}
        height={noteLines}
        lines={notes.slice(0, noteLines).map((m) => [{ text: `  ${m.text}`, color: m.color }])}
      />
    </Panel>
  );
}
