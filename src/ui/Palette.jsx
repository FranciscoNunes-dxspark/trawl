import React, { useMemo, useRef, useState } from 'react';
import { useInput } from 'ink';
import { filterItems } from '../palette.js';
import { fit, fitSegments, stringWidth } from '../text.js';
import { theme } from '../theme.js';
import { useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

/**
 * The command palette (ctrl+p), an overlay over the view: `items` from palette.js's paletteItems,
 * filtered as you type (fuzzy, best first). ↑↓ (or ctrl+p, ctrl+n) pick, ↵ hands the item picked to
 * `onPick`, esc calls `onClose`; every other key is text, j, k and q included. `query` is the text it
 * starts with. Shared by Trawl and Splice.
 */
export function Palette({ items, query: initial = '', ctx, width, height, active, onPick, onClose }) {
  // The latest text and cursor, in a ref: fast typing outruns re-rendering.
  const [state, setState] = useState({ query: initial, index: 0 });
  const ref = useRef(state);
  const update = (patch) => {
    ref.current = { ...ref.current, ...patch };
    setState(ref.current);
  };
  const shown = useMemo(() => filterItems(items, state.query), [items, state.query]);
  const listH = Math.max(1, height - 3);
  const index = Math.min(state.index, Math.max(0, shown.length - 1));
  const offset = useRef(0);
  if (index < offset.current) offset.current = index;
  if (index >= offset.current + listH) offset.current = index - listH + 1;
  offset.current = Math.max(0, Math.min(offset.current, Math.max(0, shown.length - listH)));

  const listFor = (q) => filterItems(items, q);
  const move = (n) => {
    const count = listFor(ref.current.query).length;
    if (count) update({ index: Math.max(0, Math.min(count - 1, Math.min(ref.current.index, count - 1) + n)) });
  };
  const pick = () => {
    const list = listFor(ref.current.query);
    const it = list[Math.min(ref.current.index, list.length - 1)];
    if (it) onPick(it);
  };
  const keys = (input, key) => {
    if (key.escape) return onClose();
    if (key.return) return pick();
    if (key.upArrow || (key.ctrl && input === 'p')) return move(-1);
    if (key.downArrow || (key.ctrl && input === 'n') || key.tab) return move(1);
    if (key.pageUp) return move(-listH);
    if (key.pageDown) return move(listH);
    const q = ref.current.query;
    if (key.backspace || key.delete) return update({ query: q.slice(0, -1), index: 0 });
    if (key.ctrl && input === 'u') return update({ query: '', index: 0 });
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/[\x00-\x1f\x7f]/g, '');
    if (text) update({ query: q + text, index: 0 });
  };
  useInput(keys, { isActive: active });
  // Rows start two lines down: under the panel's border and the search field.
  useMouse(ctx, (e) => {
    if (e.wheel) return move(e.wheel * 3);
    const i = offset.current + e.y - 2;
    if (e.y < 2 || i >= shown.length) return;
    update({ index: i });
    if (e.double) pick();
  });

  const innerW = width - 2;
  const labelW = Math.min(26, Math.max(6, ...shown.slice(offset.current, offset.current + listH).map((it) => stringWidth(it.label))));
  const groupW = Math.min(22, Math.max(0, ...items.map((it) => stringWidth(it.group ?? ''))));
  const descW = Math.max(10, innerW - 2 - labelW - 2 - groupW - 2);
  const count = state.query.trim() ? `${shown.length} of ${items.length}` : `${items.length}`;
  return (
    <Panel title="Command palette" hint={`${count} · ↑↓ pick · ↵ run · esc close`} width={width} height={height} focused={active}>
      <Row
        pointer={false}
        width={innerW}
        segments={[{ text: ' > ', color: theme.accent, bold: true }, { text: state.query }, { text: ' ', bg: theme.accent }, ...(state.query ? [] : [{ text: ' type to filter: a command, a key, what it does', color: theme.dim }])]}
      />
      {shown.length ? (
        shown.slice(offset.current, offset.current + listH).map((it, i) => {
          const on = offset.current + i === index;
          const desc = it.hint ? [{ text: `${it.hint}  `, color: theme.dim }, { text: it.desc ?? '' }] : [{ text: it.desc ?? '' }];
          return (
            <Row
              key={`${offset.current + i}:${it.group}:${it.label}`}
              width={innerW}
              selected={on}
              focused={active}
              segments={[
                { text: fit(it.label, labelW), color: theme.accent, bold: true },
                { text: '  ' },
                ...fitSegments(desc, descW),
                { text: '  ' },
                { text: fit(it.group ?? '', groupW), color: theme.dim },
              ]}
            />
          );
        })
      ) : (
        <Row pointer={false} width={innerW} segments={[{ text: '  Nothing matches. Backspace, or esc to close.', color: theme.dim }]} />
      )}
    </Panel>
  );
}
