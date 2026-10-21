import React, { useMemo, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import { searchHelp, sectionLines } from '../help-layout.js';
import { stringWidth } from '../text.js';
import { theme } from '../theme.js';
import { useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

// Narrower than this, the list of sections goes and the pane takes the whole width.
const SIDE_MIN = 72;
const TITLE = 'Keyboard shortcuts';

const COLORS = () => ({ keys: { color: theme.accent }, args: { color: theme.dim }, note: { color: theme.dim }, heading: { bold: true }, title: { color: theme.accent, bold: true } });

/**
 * The ? window: the sections down the left, the one picked on the right, opening on `start` (the
 * view on screen's). j k pick a section, space and J K scroll it, / searches every section (the
 * pane then shows each match under its section's name, and j k jump between them), esc clears the
 * search and then closes. Shared by Trawl, Splice and Keel; each passes its own help.js sections.
 */
export function HelpView({ sections, start = 0, ctx, width, height, active, onClose }) {
  // Which section, the search and whether it's being typed. Keys read and change the latest of
  // these (in a ref), not this render's: fast typing outruns re-rendering.
  const [state, setState] = useState({ index: start, query: '', typing: false });
  const ref = useRef(state);
  const update = (patch) => {
    ref.current = { ...ref.current, ...patch };
    setState(ref.current);
  };
  const { index, query, typing } = state;
  const [offset, setOffset] = useState(0);
  const searching = query.trim() !== '';
  const shown = useMemo(() => searchHelp(sections, query), [sections, query]);
  // The list is as wide as its longest section name (with room for a count), and never narrower than its own title.
  const listW = width >= SIDE_MIN ? Math.min(30, Math.max(stringWidth(TITLE) + 7,...sections.map((s) => stringWidth(s.title) + 9))) : 0;
  const paneW = width - listW;
  const innerH = height - 2;
  const i = Math.min(index, Math.max(0, shown.length - 1));
  const field = typing || searching;

  // What the pane shows: the section picked, or every match under its section's name, with where
  // each section starts (for j k to jump to). Narrow, the search field is its first line.
  const { lines, starts } = useMemo(() => {
    const out = [];
    const at = [];
    if (!searching) return { lines: shown[i] ? sectionLines(shown[i], paneW - 2) : [], starts: [] };
    for (const s of shown) {
      if (out.length) out.push([]);
      at.push(out.length);
      out.push([{ text: ` ${s.title}`, kind: 'title' }]);
      out.push(...sectionLines({ ...s, about: null }, paneW - 2, { query }));
    }
    return { lines: out, starts: at };
  }, [shown, i, searching, paneW, query]);
  const top = !listW && field ? 1 : 0;
  const paneH = innerH - top;
  const max = Math.max(0, lines.length - paneH);
  const scroll = (n) => setOffset((o) => Math.max(0, Math.min(max, o + n)));
  const pick = (n) => {
    const k = Math.max(0, Math.min(shown.length - 1, n));
    update({ index: k });
    setOffset(searching ? Math.min(max, starts[k] ?? 0) : 0);
  };
  const search = (text) => {
    update({ query: text, index: 0 });
    setOffset(0);
  };
  // Leaving a search keeps the section it was on.
  const clear = () => {
    const title = shown[i]?.title;
    update({ query: '', typing: false, index: Math.max(0, sections.findIndex((s) => s.title === title)) });
    setOffset(0);
  };

  useInput(
    (input, key) => {
      const { index, query: q, typing } = ref.current;
      if (typing) {
        if (key.escape) return clear();
        if (key.return) return update({ typing: false });
        if (key.upArrow || key.downArrow) return pick(index + (key.upArrow ? -1 : 1));
        if (key.backspace || key.delete) return q ? search(q.slice(0, -1)) : update({ typing: false });
        if (key.ctrl || key.meta || !input) return;
        return search(q + input.replace(/[\x00-\x1f\x7f]/g, ''));
      }
      if (key.escape) return q.trim() ? clear() : onClose();
      if (input === 'q' || input === '?') return onClose();
      if (input === '/') return update({ typing: true });
      if (key.downArrow || input === 'j') return pick(index + 1);
      if (key.upArrow || input === 'k') return pick(index - 1);
      if (input === 'g') return pick(0);
      if (input === 'G') return pick(shown.length - 1);
      if (key.pageDown || input === ' ' || (key.ctrl && input === 'd')) return scroll(paneH - 1);
      if (key.pageUp || (key.ctrl && input === 'u')) return scroll(-(paneH - 1));
      if (input === 'J') return scroll(1);
      if (input === 'K') return scroll(-1);
    },
    { isActive: active },
  );

  // The list scrolls to keep the section picked in view.
  const listRows = innerH - (field ? 1 : 0);
  const listTop = shown.length > listRows ? Math.max(0, Math.min(i - Math.floor(listRows / 2), shown.length - listRows)) : 0;

  // A click on a section picks it; the wheel scrolls the pane, or over the list moves through it.
  useMouse(ctx, (e) => {
    if (e.wheel) return listW && e.x < listW ? pick(i + Math.sign(e.wheel)) : scroll(e.wheel * 3);
    const k = listTop + e.y - 1 - (field ? 1 : 0);
    if (listW && e.x < listW && e.y >= 1 && e.y <= innerH && k >= 0 && k < shown.length) pick(k);
  });

  const colors = COLORS();
  const searchRow = (w) => (
    <Row
      pointer={false}
      width={w}
      segments={[
        { text: ' / ', color: theme.accent, bold: true },
        { text: query },
        ...(typing ? [{ text: ' ', bg: theme.accent }] : [{ text: '  ↵ kept · esc clears', color: theme.dim }]),
      ]}
    />
  );
  const count = (s) => (searching ? s.rows.length : 0);
  const pos = lines.length > paneH ? `${Math.min(lines.length, offset + paneH)}/${lines.length} · ` : '';
  const title = searching ? (shown.length ? `Matches for “${query.trim()}”` : `Nothing matches “${query.trim()}”`) : (shown[i]?.title ?? '');
  const hint = typing ? 'type to search · ↵ keep · esc clear' : `${pos}j/k section · / search · esc close`;

  const pane = (
    <Panel title={listW ? title : `${title}${!searching && shown.length > 1 ? ` (${i + 1}/${shown.length})` : ''}`} hint={hint} width={paneW} height={height} focused={active}>
      {!listW && field ? searchRow(paneW - 2) : null}
      {lines.slice(offset, offset + paneH).map((segs, k) => (
        <Row key={offset + k} pointer={false} width={paneW - 2} segments={segs.map((s) => ({ ...s, ...colors[s.kind], ...(s.match ? { bg: theme.selBg, bold: true } : {}) }))} />
      ))}
    </Panel>
  );
  if (!listW) return pane;
  return (
    <Box>
      <Panel title={TITLE} width={listW} height={height} focused={active}>
        {field ? searchRow(listW - 2) : null}
        {shown.slice(listTop, listTop + listRows).map((s, k) => (
          <Row key={s.title} width={listW - 2} selected={listTop + k === i} focused={active} segments={[{ text: s.title, strong: true }, ...(count(s) ? [{ text: ` ${count(s)}`, color: theme.dim }] : [])]} />
        ))}
      </Panel>
      {pane}
    </Box>
  );
}
