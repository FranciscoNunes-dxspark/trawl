import React, { useState } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { oneLine } from '../sql.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

/** The lines of `file` from the first selected statement to the last, GO lines included. */
export function scriptFor(file, from, to) {
  return file.text.replace(/\r\n?/g, '\n').split('\n').slice(from.line - 1, to.endLine).join('\n');
}

export function QueryView({ file, ctx, width, height, active }) {
  const list = file?.statements ?? [];
  const split = width >= 90;
  const listW = split ? Math.floor(width * 0.45) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(list.length, innerH, { resetKey: file?.path });
  const [anchor, setAnchor] = useState(null);
  const st = list[nav.index];
  const range = anchor == null ? [nav.index, nav.index] : [Math.min(anchor, nav.index), Math.max(anchor, nav.index)];
  const lineW = String(list.at(-1)?.line ?? 1).length;

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key)) return;
      if (input === 'R' && file) return ctx.runFile();
      if (!st) return;
      if (input === 'v') return setAnchor((x) => (x == null ? nav.index : null));
      if (key.escape && anchor != null) return setAnchor(null);
      if (key.return) {
        const [from, to] = range;
        const sql = from === to ? list[from].text : scriptFor(file, list[from], list[to]);
        const title = from === to ? oneLine(list[from].text) : `statements on lines ${list[from].line}–${list[to].endLine}`;
        setAnchor(null);
        a.runSql(ctx, sql, { title, lineBase: list[from].line });
      } else if (input === 'e') ctx.prefill(`!${oneLine(st.text)}`);
    },
    { isActive: active },
  );

  if (!file) {
    return (
      <Panel title="Query" width={width} height={height} focused={active}>
        <Lines
          width={width - 2}
          height={innerH}
          lines={[
            [{ text: '  No script open.', bold: true }],
            '',
            [{ text: '  /open <file.sql> lists its statements here; ↵ runs the one under the cursor.', color: theme.dim }],
            [{ text: '  Edit the file in your editor: Trawl reloads it each time you save.', color: theme.dim }],
            [{ text: '  For a quick one, type ! and the SQL at the prompt.', color: theme.dim }],
          ]}
        />
      </Panel>
    );
  }

  const preview = st ? (range[0] === range[1] ? st.text : scriptFor(file, list[range[0]], list[range[1]])).split('\n') : [];
  return (
    <Box width={width} height={height}>
      <Panel title={file.name} hint={file.error ? 'unreadable' : `${list.length} statements${anchor != null ? ` · ${range[1] - range[0] + 1} selected` : ''}`} width={listW} height={height} focused={active}>
        {file.error ? <Row pointer={false} width={innerW} segments={[{ text: `  ${file.error}`, color: theme.del }]} /> : null}
        {!file.error && !list.length ? <Row pointer={false} width={innerW} segments={[{ text: '  The file has no statements yet.', color: theme.dim }]} /> : null}
        {list.slice(nav.offset, nav.offset + innerH).map((s, i) => {
          const idx = nav.offset + i;
          const inRange = anchor != null && idx >= range[0] && idx <= range[1];
          return (
            <Row
              key={`${s.line}`}
              width={innerW}
              selected={idx === nav.index}
              focused={active}
              segments={[
                { text: inRange ? '▌' : ' ', color: theme.accent },
                { text: `${fit(String(s.line), lineW, 'right')} `, color: theme.dim },
                { text: s.label, strong: true },
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={st ? `line ${st.line}` : 'Statement'} hint={st ? '↵ run · v select · R run file' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={preview} />
        </Panel>
      ) : null}
    </Box>
  );
}
