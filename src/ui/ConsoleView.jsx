import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import * as a from '../actions.js';
import { accept, completeAt, signatureAt } from '../complete.js';
import * as ed from '../editor.js';
import { highlight, mask, oneLine, splitStatements, statementAt, withoutLeadingComments } from '../sql.js';
import { fit, fitSegments, stringWidth } from '../text.js';
import { theme } from '../theme.js';
import { atLeast } from '../mouse.js';
import { useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

const COLORS = () => ({ keyword: theme.accent, function: theme.func, string: theme.warn, comment: theme.dim, number: theme.number, variable: theme.routine });
const KIND_COLORS = () => ({ join: theme.ok, expand: theme.ok, parameter: theme.routine, keyword: theme.accent, function: theme.func, procedure: theme.routine, table: theme.table, view: theme.view, schema: theme.schema, database: theme.schema });
const MENU_ROWS = 8;
// Typing one of these keeps the suggestions coming; anything else (a comma, a bracket) closes them.
// A space asks too, though only "ON " has anything to offer before a word is typed.
const WORD_CHAR = /^[\w@#$.[ *]$/;
// ctrl+backspace arrives as \b where backspace is \x7f: everywhere but Windows's console without VT
// input (Node before 22.17), which sends \b for backspace itself. alt+backspace works everywhere.
const CTRL_BACKSPACE = process.platform !== 'win32' || typeof Bun !== 'undefined' || atLeast(process.version, 22, 17);

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

/**
 * The panel's title, "Console" or with the tabs after it ("Console 1 console [2 query]"), and the
 * columns each tab's label covers ({ from, to }, counted from the panel's left edge, after "╭─ ").
 */
export function consoleTitle(tabs, tab) {
  if (tabs.length < 2) return { title: 'Console', spans: [] };
  let x = 3 + 'Console '.length;
  const spans = [];
  const labels = tabs.map((t, i) => {
    const label = i === tab ? `[${i + 1} ${t}]` : `${i + 1} ${t}`;
    spans.push({ from: x, to: x + stringWidth(label) });
    x += stringWidth(label) + 1;
    return label;
  });
  return { title: `Console ${labels.join(' ')}`, spans };
}

// Whether the cursor is inside a string, comment or quoted name, where a pasted path is text to keep.
function inQuotes(editor) {
  const before = [...editor.lines.slice(0, editor.row), editor.lines[editor.row].slice(0, editor.col)].join('\n');
  return mask(`${before}x`).endsWith('\u0001');
}

/** The statement ctrl+r would run: the one the cursor is on, or the nearest above it. */
export function currentStatement(editor) {
  return statementAt(splitStatements(ed.toText(editor)), editor.row + 1);
}

/** Runs the selection, the statement under the cursor, or the whole console. */
export function runConsole(ctx, editor, { all = false } = {}) {
  const text = ed.toText(editor);
  if (all) return text.trim() ? a.runSql(ctx, text, { title: 'console (everything)', stay: true }) : ctx.note('The console is empty.', 'error');
  const sel = ed.selectedText(editor);
  if (sel?.text.trim()) return a.runSql(ctx, sel.text, { title: oneLine(withoutLeadingComments(sel.text)), lineBase: sel.row + 1, stay: true });
  const st = currentStatement(editor);
  if (!st) return ctx.note('The console is empty: press i (or ↵) and type some SQL.', 'error');
  return a.runSql(ctx, st.text, { title: oneLine(withoutLeadingComments(st.text)), lineBase: st.line, stay: true });
}

/**
 * The Query tab without a file: a SQL editor. ↵ or i starts typing and esc stops, so the
 * number keys and q mean text while typing and views or quit otherwise.
 */
export function ConsoleView({ editor, tabs = ['console'], tab = 0, editing, ctx, width, height, active }) {
  const top = useRef(0);
  const left = useRef(0);
  const text = ed.toText(editor);
  const lines = useMemo(() => highlight(text), [text]);
  const st = useMemo(() => statementAt(splitStatements(text), editor.row + 1), [text, editor.row]);
  const innerH = height - 2;
  const gutterW = String(editor.lines.length).length + 2;
  const textW = Math.max(10, width - 2 - gutterW);
  const colors = COLORS();
  const { title, spans } = consoleTitle(tabs, tab);

  // Scrolled with the wheel, the text stays where it was put, the cursor out of sight if need be,
  // until a key changes the text, moves the cursor or starts or stops typing.
  const free = useRef(null);
  const [, setScrolled] = useState(0);
  if (free.current && (free.current.editor !== editor || free.current.editing !== editing)) free.current = null;
  // Keep the cursor in view.
  if (!free.current) {
    if (editor.row < top.current) top.current = editor.row;
    if (editor.row >= top.current + innerH) top.current = editor.row - innerH + 1;
    if (editor.col < left.current) left.current = editor.col;
    if (editor.col >= left.current + textW) left.current = editor.col - textW + 1;
  }

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
  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    const editor = ctx.console;
    if (key.return || input === 'i') return ctx.setEditing(true);
    if (key.ctrl && input === 'r') return runConsole(ctx, editor);
    if (key.ctrl && input === 'z') return ctx.undoConsole();
    if (key.ctrl && input === 'y') return ctx.redoConsole();
    if (input === 'R') return runConsole(ctx, editor, { all: true });
    if (key.ctrl && input === 'f') return ctx.prefill('/search ');
    if (input === 'f') return a.formatConsole(ctx);
    if (input === 'p') return a.showPlan(ctx);
    if (input === 'P') return a.showActualPlan(ctx);
    // The tabs: the one before, the one after, a new one.
    if ((input === '[' || input === ']') && tabs.length > 1) return ctx.showConsoleTab((ctx.consoleTabs.index + (input === '[' ? tabs.length - 1 : 1)) % tabs.length);
    if (input === '+') return a.consoleTab(ctx, 'new');
    // After every handler has had the S, or the prompt would take it as its first letter.
    if (input === 'S') return queueMicrotask(() => ctx.prefill('/snippet save '));
    if (input === 't') return a.share(ctx, 'query');
    if (input === 'n' || input === 'N') return a.searchConsole(ctx, '', { back: input === 'N' });
    if (key.downArrow || input === 'j') return set(ed.move(editor, { rows: 1 }));
    if (key.upArrow || input === 'k') return set(ed.move(editor, { rows: -1 }));
    if (input === 'g') return set({ lines: editor.lines, row: 0, col: 0 });
    if (input === 'G') return set({ lines: editor.lines, row: editor.lines.length - 1, col: 0 });
  };
  useInput(keys, { isActive: active && !editing });

  // The mouse, typing or not. The text starts under the top border, after the border and the gutter.
  // A click puts the cursor on the character under it, a double-click selects the word and a triple
  // the line; a click in the gutter selects the statement, and one on a suggestion takes it. A drag
  // selects the SQL it covers (and copies it), running on past the top or bottom as it scrolls.
  // Clicks and drags in the text start typing. A click on a tab's name in the title brings that tab up.
  const popupRef = useRef(null);
  const dragFrom = useRef(null);
  const cellAt = (editor, x, y) => ed.clickAt(editor, top.current + y - 1, x - 1 - gutterW, { left: left.current });
  useMouse(
    ctx,
    (e) => {
      const editor = ctx.console;
      if (e.wheel) {
        top.current = Math.max(0, Math.min(top.current + e.wheel * 3, editor.lines.length - innerH));
        free.current = { editor, editing };
        return setScrolled((n) => n + 1);
      }
      if (e.drag) {
        setMenu(null);
        ctx.setEditing(true);
        dragFrom.current ??= cellAt(editor, e.from.x, e.from.y);
        const next = { ...cellAt(editor, e.x, e.y), anchor: { row: dragFrom.current.row, col: dragFrom.current.col } };
        set(next);
        if (!e.release) return;
        dragFrom.current = null;
        const sel = ed.selectedText(next);
        if (sel?.text) ctx.copySelection(sel.text);
        return;
      }
      if (e.y === 0) {
        const i = spans.findIndex((s) => e.x >= s.from && e.x < s.to);
        if (i >= 0 && i !== ctx.consoleTabs.index) ctx.showConsoleTab(i);
        return;
      }
      if (e.y > innerH) return;
      const pop = popupRef.current;
      const k = e.y - 1 - (pop?.y ?? 0);
      if (pop?.items && k >= 0 && k < pop.items.length && e.x - 1 >= pop.x && e.x - 1 < pop.x + pop.w) {
        const pick = pop.items[k];
        set(accept(editor, pop.completion, pick));
        // Taking "dbo." goes straight on to that schema's tables, as tab does.
        return setMenu(pick.insert.endsWith('.') ? { index: 0 } : null);
      }
      setMenu(null);
      // A click in the text (or the gutter) starts typing there, as in any editor.
      ctx.setEditing(true);
      const at = cellAt(editor, e.x, e.y);
      if (e.x - 1 < gutterW && top.current + e.y - 1 < editor.lines.length) {
        const st = statementAt(splitStatements(ed.toText(editor)), at.row + 1);
        if (st && at.row + 1 <= st.endLine) return set({ lines: editor.lines, row: st.endLine - 1, col: editor.lines[st.endLine - 1].length, anchor: { row: st.line - 1, col: 0 } });
      }
      set(e.triple ? ed.selectLine(at) : e.double ? ed.selectWord(at) : at);
    },
    { drags: (e) => e.y >= 1 && e.y <= innerH },
  );

  // Ink reports backspace (\x7f in most terminals) and the delete key (ESC [3~) both as key.delete, so
  // the key's own bytes, which Ink hands its input listeners one key at a time, tell them apart. This
  // listener comes before the one below, so it has the key first.
  const { internal_eventEmitter: inputs } = useStdin();
  const rawKey = useRef('');
  useEffect(() => {
    if (!inputs) return;
    const note = (data) => {
      rawKey.current = data;
    };
    inputs.on('input', note);
    return () => inputs.off('input', note);
  }, [inputs]);

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
        // tab takes the suggestion; ↵ only once one was picked with ↑↓ (or asked for with ctrl+n),
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
      // ctrl+n asks for suggestions anywhere. So does ctrl+space where the terminal sends it as NUL (Ink
      // reports ctrl+`), but the Windows console sends a plain space for it, so ctrl+n is the one to tell.
      if (key.ctrl && (input === 'n' || input === '`' || input === '@')) return setMenu({ index: 0, force: true });
      // Any other key closes the list; typing a name (or backspacing over one) opens it again below.
      if (open) setMenu(null);
      // esc lets go of a selection first, then stops typing.
      if (key.escape && ed.selection(editor)) return set({ lines: editor.lines, row: editor.row, col: editor.col });
      // ctrl+c copies the selection; with nothing selected it stops typing, as esc does.
      if (key.ctrl && input === 'c' && ed.selection(editor)) return ctx.copySelection(ed.selectedText(editor).text);
      if (key.escape || (key.ctrl && input === 'c')) return ctx.setEditing(false);
      if (key.ctrl && input === 'r') return runConsole(ctx, editor);
      if (key.ctrl && input === 'z') return ctx.undoConsole();
      if (key.ctrl && input === 'y') return ctx.redoConsole();
      // Formatting while typing: alt+shift+f as in VS Code, or ctrl+alt+l as in DataGrip (f does it otherwise).
      // Ink hands ctrl+alt+l over as a bare form feed, with neither ctrl nor meta; ctrl+l alone is ctrl and l.
      if ((key.meta && input === 'F') || input === '\x0c') return a.formatConsole(ctx);
      if (key.return) return set(ed.newline(editor));
      if (key.backspace || key.delete) {
        const forward = key.delete && rawKey.current.startsWith('\x1b[3');
        // A word at a time: ctrl+delete forward; ctrl+backspace or alt+backspace back.
        const word = forward ? key.ctrl : key.meta || (CTRL_BACKSPACE && rawKey.current === '\b');
        const next = forward ? (word ? ed.deleteWordForward : ed.deleteForward) : word ? ed.deleteWordBack : ed.backspace;
        ctx.setConsole(next(editor), { merge: !word });
        return open ? setMenu({ index: 0, force: open.force }) : undefined;
      }
      // ctrl+/ (which terminals send as \x1f) comments the line, or the selected lines, out or back in.
      if (input === '\x1f' || (key.ctrl && input === '/')) return set(ed.toggleComment(editor));
      if (key.ctrl && input === 'd') return set(ed.duplicate(editor));
      // alt+↑/↓ moves the line (or the selected lines) up or down.
      if (key.meta && !key.shift && (key.upArrow || key.downArrow)) {
        const moved = ed.moveLines(editor, key.upArrow ? -1 : 1);
        return moved ? set(moved) : undefined;
      }
      // shift with a movement selects; ctrl moves (or with shift, selects) a word at a time, and with
      // home or end to the start or end of the text.
      const step =
        key.ctrl && (key.leftArrow || key.rightArrow)
          ? (e) => ed.wordMove(e, key.leftArrow ? -1 : 1)
          : key.leftArrow || key.rightArrow
            ? (e) => ed.move(e, { cols: key.leftArrow ? -1 : 1 })
            : key.upArrow || key.downArrow
              ? (e) => ed.move(e, { rows: key.upArrow ? -1 : 1 })
              : key.home
                ? key.ctrl ? ed.textStart : ed.lineStart
                : key.end
                  ? key.ctrl ? ed.textEnd : ed.lineEnd
                  : null;
      if (step && key.shift) return set(ed.extend(editor, step));
      if (step && key.ctrl) return set(step(editor));
      if (key.ctrl && input === 'w') return set(ed.deleteWordBack(editor));
      if (key.ctrl && input === 'x') {
        const cut = ed.cut(editor);
        if (!cut) return;
        set(cut.editor);
        return ctx.copySelection(cut.text, 'Cut');
      }
      if (key.ctrl && input === 'f') return ctx.prefill('/search ');
      if (key.leftArrow) return set(ed.move(editor, { cols: -1 }));
      if (key.rightArrow) return set(ed.move(editor, { cols: 1 }));
      if (key.upArrow) return set(ed.move(editor, { rows: -1 }));
      if (key.downArrow) return set(ed.move(editor, { rows: 1 }));
      if (key.pageUp) return set(ed.move(editor, { rows: -(innerH - 1) }));
      if (key.pageDown) return set(ed.move(editor, { rows: innerH - 1 }));
      if (key.ctrl && input === 'a') return set(ed.selectAll(editor));
      if (key.home) return set(ed.lineStart(editor));
      if (key.end || (key.ctrl && input === 'e')) return set(ed.lineEnd(editor));
      if (key.ctrl && input === 'u') return set(ed.killLine(editor));
      if (key.ctrl && input === 'k') return set(ed.killLine(editor, { toEnd: true }));
      if (key.tab) {
        // tab and shift+tab indent the selected lines; shift+tab alone takes the cursor's line back.
        const sel = ed.selection(editor);
        if (key.shift || (sel && sel.start.row !== sel.end.row)) return set(ed.indentLines(editor, key.shift ? -1 : 1));
        // Right after SELECT *, tab writes out the columns (once the FROM is there to say which).
        const c = completeAt(editor, ctx.schema, { force: true });
        if (c?.items[0]?.kind === 'expand') return set(accept(editor, c, c.items[0]));
        return set(ed.insert(editor, '  '));
      }
      if (key.ctrl || key.meta || !input) return;
      const typed = input.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');
      if (!typed) return;
      // A file dropped on the terminal arrives as its path: it opens in a tab, unless it went into a string.
      if (typed.length > 1 && !inQuotes(editor) && a.openDropped(ctx, typed)) return;
      // One character of a word joins the undo step before it; a space, or a paste, starts one.
      ctx.setConsole(ed.insert(editor, typed), { merge: typed.length === 1 && typed !== ' ' });
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
      // For clicks: what each line is, and how wide they all are.
      items: visible,
      completion,
      w,
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
  } else if (editing && !ed.selection(editor)) {
    // Inside a call's parentheses (or an EXEC's arguments): its syntax, with the argument the cursor
    // is on picked out, on the line above (below on the first line).
    const sig = signatureAt(editor, ctx.schema);
    if (sig) {
      const bg = theme.selBg;
      const segs = [{ text: ` ${sig.name}${sig.exec ? ' ' : '('}`, color: sig.exec ? theme.routine : theme.func, bg }];
      const last = sig.params.length - 1;
      sig.params.forEach((p, k) => {
        const on = k === sig.index || (p.repeats && k === last && sig.index > k);
        const sep = k ? ', ' : '';
        segs.push({ text: p.optional ? `[${sep}${p.text}]` : `${sep}${p.text}`, color: on ? theme.accent : undefined, bold: on, bg });
      });
      if (sig.params[last]?.repeats) segs.push({ text: ', …', bg });
      segs.push({ text: sig.exec ? ' ' : ') ', color: sig.exec ? theme.routine : theme.func, bg });
      const w = Math.min(textW, segs.reduce((n, s) => n + s.text.length, 0));
      const y = editor.row - top.current;
      popup = { y: y > 0 ? y - 1 : y + 1, x: gutterW + Math.max(0, Math.min(editor.col - left.current - 1, textW - w)), lines: [fitSegments(segs, w)] };
    }
  }

  popupRef.current = popup;

  const empty = editor.lines.length === 1 && !editor.lines[0];
  // ctrl+r runs the selection when there is one, so the gutter marks that instead of the statement.
  const sel = ed.selection(editor);
  const rows = [];
  for (let i = top.current; i < Math.min(editor.lines.length, top.current + innerH); i++) {
    const inStatement = sel ? i >= sel.start.row && i <= sel.end.row : st && i + 1 >= st.line && i + 1 <= st.endLine;
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
          const bg = ed.isSelected(sel, i, x) ? theme.selBg : undefined;
          if (!cursor && last && !last.cursor && last.color === color && last.bg === bg) last.text += ch;
          else segs.push({ text: ch, color, cursor, bg });
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
    : sel
      ? 'selected · ctrl+r runs just this · ctrl+c/x copy/cut · esc let go'
      : editing
      ? 'typing · ctrl+n suggest · ctrl+r run · alt+shift+f format · ctrl+z undo · esc stop'
      : `${editor.lines.length} lines · ↵ type · ctrl+r run · R run all · f format · p plan · ctrl+f find`;
  return (
    <Panel title={title} hint={hint} width={width} height={height} focused={active}>
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
