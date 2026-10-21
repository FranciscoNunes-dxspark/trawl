import React from 'react';
import { Box, useInput } from 'ink';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

/**
 * Pick one from a list, an overlay over the view: `items` are { label, detail, text } (text shows on
 * the right), and `keys` maps a key ('return', or a letter) to what it does with the item picked.
 * The overlay closes before the key's action runs; esc or q closes it.
 */
export function Picker({ title, hint, items, keys, empty, ctx, width, height, active, onClose }) {
  const split = width >= 90;
  const listW = split ? Math.floor(width * 0.45) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(items.length, innerH);
  const item = items[nav.index];

  const handle = (input, key) => {
    if (key.escape || input === 'q') return onClose();
    if (nav.handle(input, key)) return;
    const action = key.return ? keys.return : keys[input];
    const picked = items[nav.current()];
    if (!action || !picked) return;
    onClose();
    // After every handler has had this key, so the view under the overlay doesn't take it too.
    queueMicrotask(() => action(picked));
  };
  useInput(handle, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) handle('', { return: true });
  });

  const labelW = Math.min(30, Math.max(8, ...items.map((i) => i.label.length)));
  return (
    <Box width={width} height={height}>
      <Panel title={title} hint={`${items.length}`} width={listW} height={height} focused={active}>
        {items.length ? (
          items.slice(nav.offset, nav.offset + innerH).map((it, i) => (
            <Row
              key={`${it.label}:${i}`}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[{ text: fit(it.label, labelW), strong: true }, { text: `  ${it.detail ?? ''}`, color: theme.dim }]}
            />
          ))
        ) : (
          <Lines width={innerW} height={innerH} lines={[[{ text: `  ${empty ?? 'Nothing here.'}`, color: theme.dim }]]} />
        )}
      </Panel>
      {split ? (
        <Panel title={item?.label ?? ''} hint={hint} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={(item?.text ?? '').split('\n')} />
        </Panel>
      ) : null}
    </Box>
  );
}
