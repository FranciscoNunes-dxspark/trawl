import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import * as a from '../actions.js';
import { accept, completeAt } from '../complete.js';
import * as ed from '../editor.js';
import { highlight, oneLine, splitStatements, statementAt, withoutLeadingComments } from '../sql.js';
import { fit } from '../text.js';
import { theme } from '../theme.js';
import { Panel, Row } from './parts.jsx';

const COLORS = () => ({ keyword: theme.accent, string: theme.warn, comment: theme.dim, number: theme.number, variable: theme.routine });
const KIND_COLORS = () => ({ join: theme.ok, keyword: theme.accent, function: theme.routine, procedure: theme.routine, table: theme.table, view: theme.view, schema: theme.schema, database: theme.schema });
const MENU_ROWS = 8;
// Typing one of these keeps the suggestions coming; anything else (a comma, a bracket) closes them.
// A space asks too, though only "ON " has anything to offer before a word is typed.
const WORD_CHAR = /^[\w@#$.[ ]$/;

/** Lays `add` over a row of segments from column `x`, padding the row when it's shorter. */
function overlay(segs, x, add) {
  const cells = segs.flatMap((s) => [...s.text].map((ch) => ({ ...s, text: ch })));
  while (cells.length < x) cells.push({ text: ' ' });
  const top = add.flatMap((s) => [...s.text].map((ch) => ({ ...s, text: ch })));
  cells.splice(x, top.length, ...top);
  const out = [];
  for (const c of cells) {
    const last = out.at(-1);
    if (last && last.color === c.color && last.bg === c.bg && last.bold === c.bold && !last.cursor && !c.cursor) last.text += c.text;
    else out.push({ ...c });
  }
  return out;
}

/** The statement ctrl+r would run: the one the cursor is on, or the nearest above it. */
export function currentStatement(editor) {
  return statementAt(splitStatements(ed.toText(editor)), editor.row + 1);
}

/** Runs the statement under the cursor, or the whole console. */
export function runConsole(ctx, editor, { all = false } = {}) {
  const text = ed.toText(editor);
  if (all) return text.trim() ? a.runSql(ctx, text, { title: 'console (everything)', stay: true }) : ctx.note('The console is empty.', 'error');
  const st = currentStatement(editor);
  if (!st) return ctx.note('The console is empty: press i (or ↵) and type some SQL.', 'error');
  return a.runSql(ctx, st.text, { title: oneLine(withoutLeadingComments(st.text)), lineBase: st.line, stay: true });
}

/**
 * The Query tab without a file: a SQL editor. ↵ or i starts typing and esc stops, so the
 * number keys and q mean text while typing and views or quit otherwise.
 */
export function ConsoleView({ editor, editing, ctx, width, height, active }) {
  const top = useRef(0);
  const left = useRef(0);
  const text = ed.toText(editor);
  const lines = useMemo(() => highlight(text), [text]);
  const st = useMemo(() => statementAt(splitStatements(text), editor.row + 1), [text, editor.row]);
  const innerH = height - 2;
  const gutterW = String(editor.lines.length).length + 2;
  const textW = Math.max(10, width - 2 - gutterW);
  const colors = COLORS();

  // Keep the cursor in view.
  if (editor.row < top.current) top.current = editor.row;
  if (editor.row >= top.current + innerH) top.current = editor.row - innerH + 1;
  if (editor.col < left.current) left.current = editor.col;
  if (editor.col >= left.current + textW) left.current = editor.col - textW + 1;

  const set = (next) => ctx.setConsole(next);

  // The suggestions under the cursor while typing: { index, force, moved } or null when closed.
  // The list itself is worked out from the text each time, so it can't fall behind the typing.
  const [menu, setMenuState] = useState(null);
  const menuRef = useRef(null);
  const setMenu = (next) => {
    menuRef.current = next;
    setMenuState(next);
  };

  // Keys while not typing: start typing, run, and move between statements.
  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      const editor = ctx.console;
      if (key.return || input === 'i') return ctx.setEditing(true);
      if (key.ctrl && input === 'r') return runConsole(ctx, editor);
      if (input === 'R') return runConsole(ctx, editor, { all: true });
      if (key.downArrow || input === 'j') return set(ed.move(editor, { rows: 1 }));
      if (key.upArrow || input === 'k') return set(ed.move(editor, { rows: -1 }));
      if (input === 'g') return set({ ...editor, row: 0, col: 0 });
      if (input === 'G') return set({ ...editor, row: editor.lines.length - 1, col: 0 });
    },
    { isActive: active && !editing },
  );

  // Keys while typing. Ink gives a paste as one input; insert() splits its lines.
  useInput(
    (input, key) => {
      if (!ctx.editorHasKeys()) return;
      // Edit the latest text, not this render's: fast typing outruns re-rendering.
      const editor = ctx.console;
      const open = menuRef.current;
      const completion = open && completeAt(editor, ctx.schema, { force: open.force });
      const items = completion?.items ?? [];
      if (items.length) {
        // tab takes the suggestion; ↵ only once one was picked with ↑↓ (or asked for with ctrl+space),
        // so ↵ after a word still starts a new line.
        const pick = items[Math.min(open.index, items.length - 1)];
        if (key.escape) return setMenu(null);
        if (key.upArrow || key.downArrow) return setMenu({ ...open, index: (open.index + (key.upArrow ? items.length - 1 : 1)) % items.length, moved: true });
        if (key.tab || (key.return && (open.moved || open.force))) {
          set(accept(editor, completion, pick));
          // Taking "dbo." goes straight on to that schema's tables.
          return setMenu(pick.insert.endsWith('.') ? { index: 0 } : null);
        }
      }
      // ctrl+space arrives as NUL, which Ink reports as ctrl+`.
      if (key.ctrl && (input === '`' || input === ' ' || input === '@')) return setMenu({ index: 0, force: true });
      // Any other key closes the list; typing a name (or backspacing over one) opens it again below.
      if (open) setMenu(null);
      if (key.escape || (key.ctrl && input === 'c')) return ctx.setEditing(false);
      if (key.ctrl && input === 'r') return runConsole(ctx, editor);
      if (key.return) return set(ed.newline(editor));
      if (key.backspace || key.delete) {
        set(ed.backspace(editor));
        return open ? setMenu({ index: 0, force: open.force }) : undefined;
      }
      if (key.leftArrow) return set(ed.move(editor, { cols: -1 }));
      if (key.rightArrow) return set(ed.move(editor, { cols: 1 }));
      if (key.upArrow) return set(ed.move(editor, { rows: -1 }));
      if (key.downArrow) return set(ed.move(editor, { rows: 1 }));
      if (key.pageUp) return set(ed.move(editor, { rows: -(innerH - 1) }));
      if (key.pageDown) return set(ed.move(editor, { rows: innerH - 1 }));
      if (key.home || (key.ctrl && input === 'a')) return set(ed.lineStart(editor));
      if (key.end || (key.ctrl && input === 'e')) return set(ed.lineEnd(editor));
      if (key.ctrl && input === 'u') return set(ed.killLine(editor));
      if (key.ctrl && input === 'k') return set(ed.killLine(editor, { toEnd: true }));
      if (key.tab) return set(ed.insert(editor, '  '));
      if (key.ctrl || key.meta || !input) return;
      const typed = input.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');
      if (!typed) return;
      set(ed.insert(editor, typed));
      if (WORD_CHAR.test(typed)) setMenu({ index: 0 });
    },
    { isActive: active && editing },
  );

  // The suggestions, drawn over the text under the word being typed (above it near the bottom).
  const completion = editing && menu ? completeAt(editor, ctx.schema, { force: menu.force }) : null;
  const items = completion?.items ?? [];
  let popup = null;
  if (items.length) {
    const y = editor.row - top.current;
    const room = Math.max(innerH - y - 1, y);
    const shown = Math.min(MENU_ROWS, items.length, room);
    const sel = Math.min(menu.index, items.length - 1);
    const first = Math.max(0, Math.min(sel - shown + 1, items.length - shown));
    const visible = items.slice(first, first + shown);
    const labelW = Math.min(36, Math.max(...visible.map((i) => i.label.length)));
    const detailW = Math.min(28, Math.max(...visible.map((i) => i.detail.length)));
    const w = Math.min(textW, labelW + detailW + 4);
    const kinds = KIND_COLORS();
    popup = {
      y: innerH - y - 1 >= shown ? y + 1 : y - shown,
      x: gutterW + Math.max(0, Math.min(completion.from - left.current, textW - w)),
      lines: visible.map((item, k) => {
        const on = first + k === sel;
        const bg = on ? theme.accent : theme.selBg;
        const label = fit(item.label, Math.max(1, Math.min(labelW, w - 2)));
        const detail = fit(item.detail, Math.max(0, w - 3 - label.length));
        return [
          { text: ` ${label} `, color: on ? theme.ink : kinds[item.kind], bg, bold: on },
          { text: `${detail} `, color: on ? theme.ink : theme.dim, bg },
        ];
      }),
    };
  }

  const empty = editor.lines.length === 1 && !editor.lines[0];
  const rows = [];
  for (let i = top.current; i < Math.min(editor.lines.length, top.current + innerH); i++) {
    const inStatement = st && i + 1 >= st.line && i + 1 <= st.endLine;
    const gutter = [
      { text: inStatement ? '▌' : ' ', color: theme.accent },
      { text: `${String(i + 1).padStart(gutterW - 2)} `, color: i === editor.row ? theme.accent : theme.dim },
    ];
    // The visible slice of the line, coloured, with the cursor drawn in reverse while typing.
    const segs = [];
    let x = 0;
    for (const run of lines[i] ?? []) {
      for (const ch of run.text) {
        if (x >= left.current && x < left.current + textW) {
          const cursor = editing && i === editor.row && x === editor.col;
          const last = segs.at(-1);
          const color = colors[run.kind];
          if (!cursor && last && !last.cursor && last.color === color) last.text += ch;
          else segs.push({ text: ch, color, cursor });
        }
        x++;
      }
    }
    if (editing && i === editor.row && editor.col >= x) segs.push({ text: ' ', cursor: true });
    let all = [...gutter, ...segs];
    const over = popup?.lines[i - top.current - popup.y];
    if (over) all = overlay(all, popup.x, over);
    rows.push(
      <Text key={i} wrap="truncate">
        {all.map((s, k) => (
          <Text key={k} color={s.color} backgroundColor={s.bg} bold={s.bold} inverse={s.cursor}>
            {s.text}
          </Text>
        ))}
      </Text>,
    );
  }
  // A list under the last line runs on into the empty space below it.
  if (popup) {
    for (let k = rows.length; k < Math.min(innerH, popup.y + popup.lines.length); k++) {
      const over = popup.lines[k - popup.y];
      const all = over ? overlay([], popup.x, over) : [{ text: '' }];
      rows.push(
        <Text key={`m${k}`} wrap="truncate">
          {all.map((s, j) => (
            <Text key={j} color={s.color} backgroundColor={s.bg} bold={s.bold}>
              {s.text}
            </Text>
          ))}
        </Text>,
      );
    }
  }

  const hint = items.length
    ? 'tab take it · ↑↓ pick · esc close'
    : editing
      ? 'typing · ctrl+space suggest · ctrl+r run statement · esc stop'
      : `${editor.lines.length} lines · ↵ type · ctrl+r run · R run all`;
  return (
    <Panel title="Console" hint={hint} width={width} height={height} focused={active}>
      {empty && !editing ? (
        <Box flexDirection="column">
          <Row pointer={false} width={width - 2} segments={[{ text: '  An empty console. Press i (or ↵) and type some SQL; ctrl+r runs the statement under the cursor.', color: theme.dim }]} />
          <Row pointer={false} width={width - 2} segments={[{ text: '  It is kept between sessions. /save <file.sql> writes it to a file; /open <file.sql> works on a file instead.', color: theme.dim }]} />
        </Box>
      ) : (
        rows
      )}
    </Panel>
  );
}
