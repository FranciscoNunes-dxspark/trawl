import React, { useMemo } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { qualified } from '../sql.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

const KIND = {
  table: { mark: 'T', color: theme.table },
  view: { mark: 'V', color: theme.view },
  procedure: { mark: 'P', color: theme.routine },
  function: { mark: 'F', color: theme.routine },
  other: { mark: '?', color: theme.dim },
};

const count = (n) => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));

export function ExplorerView({ schema, ctx, width, height, active, filter }) {
  const rows = useMemo(() => {
    const q = filter.toLowerCase();
    const shown = schema.objects.filter((o) => !q || `${o.schema}.${o.name}`.toLowerCase().includes(q));
    const out = [];
    let last = null;
    for (const o of shown) {
      if (o.schema !== last) out.push({ header: o.schema, count: shown.filter((x) => x.schema === o.schema).length });
      last = o.schema;
      out.push({ obj: o });
    }
    return out;
  }, [schema, filter]);

  const split = width >= 90;
  const listW = split ? Math.floor(width * 0.5) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.obj), resetKey: `${schema.database}|${filter}` });
  const obj = rows[nav.index]?.obj;
  const nameW = Math.max(8, innerW - 14);

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key) || !obj) return;
      if (key.return) a.browse(ctx, obj);
      else if (input === 'd') a.describe(ctx, obj);
      else if (input === 's') ctx.startQuery(obj);
    },
    { isActive: active },
  );

  const total = schema.objects.length;
  const side = obj
    ? obj.columns.length
      ? obj.columns.map((c) => [
          { text: c.pk ? 'PK ' : '   ', color: theme.warn, bold: true },
          { text: fit(c.name, Math.min(28, Math.max(...obj.columns.map((x) => x.name.length)) + 1)) },
          { text: ` ${c.type}`, color: theme.info },
          { text: c.nullable ? ' null' : '', color: theme.dim },
          { text: c.identity ? ' identity' : '', color: theme.dim },
        ])
      : [[{ text: `A ${obj.kind}. Run it at the prompt: !EXEC ${qualified(obj.schema, obj.name)}`, color: theme.dim }]]
    : [];

  return (
    <Box width={width} height={height}>
      <Panel title={schema.database ?? 'Explorer'} hint={filter ? `${rows.filter((r) => r.obj).length} of ${total} · "${filter}"` : `${total} objects`} width={listW} height={height} focused={active}>
        {rows.length === 0 ? (
          <Row pointer={false} width={innerW} segments={[{ text: filter ? `  Nothing matches "${filter}". /find with no text clears it.` : '  No tables, views or routines here.', color: theme.dim }]} />
        ) : null}
        {rows.slice(nav.offset, nav.offset + innerH).map((row, i) => {
          const idx = nav.offset + i;
          if (row.header) {
            return <Row key={`h${row.header}`} width={innerW} pointer={false} segments={[{ text: row.header, color: theme.schema, bold: true }, { text: ` (${row.count})`, color: theme.dim }]} />;
          }
          const k = KIND[row.obj.kind];
          return (
            <Row
              key={`${row.obj.schema}.${row.obj.name}`}
              width={innerW}
              selected={idx === nav.index}
              focused={active}
              segments={[
                { text: `${k.mark} `, color: k.color, bold: true },
                { text: fit(row.obj.name, nameW), strong: true },
                { text: fit(count(row.obj.rows), 8, 'right'), color: theme.dim },
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={obj ? `${obj.schema}.${obj.name}` : 'Columns'} hint={obj ? '↵ rows · d describe · s query' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={side} />
        </Panel>
      ) : null}
    </Box>
  );
}
