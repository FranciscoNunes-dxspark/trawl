import React, { useMemo, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

/**
 * Full-height scrollable text: /describe, a record, the last output, help. `pageOnly`: a question
 * below has the other keys, so only page up/down scroll this. `keys` maps a letter to an action of
 * this text's own, which `hint` names. `draw` ((width, height) => lines of segments, or strings) draws
 * coloured lines in place of the text, at the room there is, while drawing (a chart, a diagram).
 */
export function TextViewer({ title, text, draw, loading, keys, hint, ctx, width, height, active, pageOnly = false, onClose }) {
  const innerH = height - 2;
  const plain = useMemo(() => (text ?? '').replace(/\n$/, '').split('\n'), [text]);
  const lines = draw ? draw(width - 2, innerH) : plain;
  const [offset, setOffset] = useState(0);
  const max = Math.max(0, lines.length - innerH);
  const to = (n) => setOffset(Math.max(0, Math.min(max, n)));

  useInput(
    (input, key) => {
      if (pageOnly && !key.pageDown && !key.pageUp) return;
      if (key.escape || input === 'q') return onClose();
      // Keys of the viewer's own (a for Claude on a plan): it closes first, and the action runs once this key is handled.
      if (keys?.[input]) {
        onClose();
        return queueMicrotask(keys[input]);
      }
      if (key.downArrow || input === 'j') to(offset + 1);
      else if (key.upArrow || input === 'k') to(offset - 1);
      else if (key.pageDown || input === ' ' || (key.ctrl && input === 'd')) to(offset + innerH - 1);
      else if (key.pageUp || (key.ctrl && input === 'u')) to(offset - innerH + 1);
      else if (input === 'g') to(0);
      else if (input === 'G') to(max);
    },
    { isActive: active },
  );
  useMouse(ctx, (e) => e.wheel && setOffset((o) => Math.max(0, Math.min(max, o + e.wheel * 3))));

  const pos = lines.length > innerH ? `${Math.min(lines.length, offset + innerH)}/${lines.length}` : '';
  return (
    <Panel title={title} hint={`${pos}${pos ? ' · ' : ''}${hint ? `${hint} · ` : ''}esc close`} width={width} height={height} focused={active}>
      {loading ? (
        <Row pointer={false} width={width - 2} segments={[{ text: 'Loading…', color: theme.dim }]} />
      ) : (
        lines.slice(offset, offset + innerH).map((l, i) => <Row key={offset + i} pointer={false} width={width - 2} segments={typeof l === 'string' ? [{ text: l }] : l} />)
      )}
    </Panel>
  );
}
