import React from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { oneLine } from '../sql.js';
import { theme } from '../theme.js';
import { fit, relTime } from '../text.js';
import { useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

export function HistoryView({ ran, ctx, width, height, active }) {
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.6) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(ran.length, innerH);
  const h = ran[nav.index];
  const whereW = Math.min(24, Math.max(4, ...ran.slice(0, 200).map((e) => `${e.conn}/${e.database}`.length)));

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key) || !h) return;
      if (key.return) a.runSql(ctx, h.sql);
      else if (input === 'e') ctx.prefill(`!${oneLine(h.sql)}`);
    },
    { isActive: active },
  );

  return (
    <Box width={width} height={height}>
      <Panel title="History" hint={`${ran.length}`} width={listW} height={height} focused={active}>
        {ran.length === 0 ? <Row pointer={false} width={innerW} segments={[{ text: '  Nothing has run yet.', color: theme.dim }]} /> : null}
        {ran.slice(nav.offset, nav.offset + innerH).map((e, i) => (
          <Row
            key={`${e.at}:${i}`}
            width={innerW}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: e.ok ? '✓ ' : '✗ ', color: e.ok ? theme.ok : theme.del },
              { text: fit(relTime(e.at), 4, 'right'), color: theme.dim },
              { text: ` ${fit(`${e.conn}/${e.database}`, whereW)} `, color: theme.info },
              { text: oneLine(e.sql), strong: true },
            ]}
          />
        ))}
      </Panel>
      {split ? (
        <Panel title={h ? new Date(h.at).toLocaleString() : 'Statement'} hint={h ? '↵ run again · e edit' : ''} width={sideW} height={height}>
          <Lines
            width={sideW - 2}
            height={innerH}
            lines={h ? [[{ text: h.summary ?? '', color: h.ok ? theme.dim : theme.del }], '', ...h.sql.split('\n')] : []}
          />
        </Panel>
      ) : null}
    </Box>
  );
}
