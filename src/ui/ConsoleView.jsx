import React, { useMemo, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import * as a from '../actions.js';
import * as ed from '../editor.js';
import { highlight, oneLine, splitStatements, statementAt } from '../sql.js';
import { theme } from '../theme.js';
import { Panel, Row } from './parts.jsx';

const COLORS = () => ({ keyword: theme.accent, string: theme.warn, comment: theme.dim, number: theme.number, variable: theme.routine });

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
  return a.runSql(ctx, st.text, { title: oneLine(st.text), lineBase: st.line, stay: true });
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
      if (key.escape || (key.ctrl && input === 'c')) return ctx.setEditing(false);
      if (key.ctrl && input === 'r') return runConsole(ctx, editor);
      if (key.return) return set(ed.newline(editor));
      if (key.backspace || key.delete) return set(ed.backspace(editor));
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
      if (typed) set(ed.insert(editor, typed));
    },
    { isActive: active && editing },
  );

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
    rows.push(
      <Text key={i} wrap="truncate">
        {gutter.map((g, k) => (
          <Text key={`g${k}`} color={g.color}>
            {g.text}
          </Text>
        ))}
        {segs.map((s, k) => (
          <Text key={k} color={s.color} inverse={s.cursor}>
            {s.text}
          </Text>
        ))}
      </Text>,
    );
  }

  const hint = editing ? 'typing · ctrl+r run statement · esc stop' : `${editor.lines.length} lines · ↵ type · ctrl+r run · R run all`;
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
