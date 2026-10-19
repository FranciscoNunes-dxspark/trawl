import React, { useMemo, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { Panel, Row } from './parts.jsx';

/** Full-height scrollable text: /describe, a record, the last output, help. */
export function TextViewer({ title, text, loading, width, height, active, onClose }) {
  const lines = useMemo(() => (text ?? '').replace(/\n$/, '').split('\n'), [text]);
  const [offset, setOffset] = useState(0);
  const innerH = height - 2;
  const max = Math.max(0, lines.length - innerH);
  const to = (n) => setOffset(Math.max(0, Math.min(max, n)));

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') return onClose();
      if (key.downArrow || input === 'j') to(offset + 1);
      else if (key.upArrow || input === 'k') to(offset - 1);
      else if (key.pageDown || input === ' ' || (key.ctrl && input === 'd')) to(offset + innerH - 1);
      else if (key.pageUp || (key.ctrl && input === 'u')) to(offset - innerH + 1);
      else if (input === 'g') to(0);
      else if (input === 'G') to(max);
    },
    { isActive: active },
  );

  const pos = lines.length > innerH ? `${Math.min(lines.length, offset + innerH)}/${lines.length}` : '';
  return (
    <Panel title={title} hint={`${pos}${pos ? ' · ' : ''}esc close`} width={width} height={height} focused={active}>
      {loading ? (
        <Row pointer={false} width={width - 2} segments={[{ text: 'Loading…', color: theme.dim }]} />
      ) : (
        lines.slice(offset, offset + innerH).map((l, i) => <Row key={offset + i} pointer={false} width={width - 2} segments={[{ text: l }]} />)
      )}
    </Panel>
  );
}
