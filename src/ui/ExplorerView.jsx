import React, { useMemo } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { qualified } from '../sql.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

// Colours as getters, so they're the theme's as it is now (light or dark).
const KIND = {
  table: { mark: 'T', get color() { return theme.table; } },
  view: { mark: 'V', get color() { return theme.view; } },
  procedure: { mark: 'P', get color() { return theme.routine; } },
  function: { mark: 'F', get color() { return theme.routine; } },
  other: { mark: '?', get color() { return theme.dim; } },
};

const count = (n) => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));

// The server's own databases go after the others, dimmed, as SSMS keeps them in a folder of their own.
const SYSTEM = new Set(['master', 'model', 'msdb', 'tempdb']);
const isSystem = (db) => SYSTEM.has(String(db).toLowerCase());

/**
 * The server as a tree, as SSMS's Object Explorer shows it: its databases, the one this session is
 * in opened up to its schemas and objects. ↵ on another database switches to it (as /use does).
 */
export function ExplorerView({ schema, ctx, width, height, active, filter }) {
  const rows = useMemo(() => {
    const q = filter.toLowerCase();
    const shown = schema.objects.filter((o) => !q || `${o.schema}.${o.name}`.toLowerCase().includes(q));
    const objects = [];
    let last = null;
    for (const o of shown) {
      if (o.schema !== last) objects.push({ header: o.schema, count: shown.filter((x) => x.schema === o.schema).length });
      last = o.schema;
      objects.push({ obj: o });
    }
    if (!objects.length) objects.push({ empty: filter ? `Nothing matches "${filter}". /find with no text clears it.` : 'No tables, views or routines here.' });
    const all = schema.databases?.includes(schema.database) ? schema.databases : [schema.database, ...(schema.databases ?? [])];
    const out = [];
    for (const db of [...all.filter((d) => !isSystem(d)), ...all.filter(isSystem)]) {
      out.push({ database: db, current: db === schema.database });
      if (db === schema.database) out.push(...objects);
    }
    return out;
  }, [schema, filter]);

  const split = width >= 90;
  const listW = split ? Math.floor(width * 0.5) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, {
    selectable: (i) => Boolean(rows[i]?.obj || (rows[i]?.database && !rows[i].current)),
    resetKey: `${schema.database}|${filter}`,
    // On the first object, not on a database above it.
    start: Math.max(0, rows.findIndex((r) => r.obj)),
  });
  const obj = rows[nav.index]?.obj;
  const db = rows[nav.index]?.database;
  const nameW = Math.max(8, innerW - 14);
  const databases = rows.filter((r) => r.database).length;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    // The row as of now, which a click may have just moved to.
    const { obj, database: db } = rows[nav.current()] ?? {};
    if (db && key.return) return a.use(ctx, db);
    if (!obj) return;
    if (key.return) a.browse(ctx, obj);
    else if (input === 'd') a.describe(ctx, obj);
    else if (input === 's') ctx.startQuery(obj);
    else if (input === 'c') a.scriptObject(ctx, obj);
    else if (input === 'u') a.showUses(ctx, obj);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    // Rows start under the panel's top border; a schema's heading takes no cursor. A double-click
    // shows the first rows, or switches database, as ↵ does.
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const total = schema.objects.length;
  const server = ctx.session?.conn.server;
  const side = db
    ? [
        [{ text: `A database on ${server ?? 'this server'}${isSystem(db) ? ', one of its own' : ''}.`, color: theme.dim }],
        '',
        [{ text: `↵ switches to it, reconnecting as /use ${db} does (asking first if a transaction is open).`, color: theme.dim }],
      ]
    : obj
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
      <Panel
        title={server ?? schema.database ?? 'Explorer'}
        hint={`${filter ? `${rows.filter((r) => r.obj).length} of ${total} · "${filter}"` : `${total} objects`} · ${databases} database${databases === 1 ? '' : 's'}`}
        width={listW}
        height={height}
        focused={active}
      >
        {rows.slice(nav.offset, nav.offset + innerH).map((row, i) => {
          const idx = nav.offset + i;
          if (row.database) {
            const on = idx === nav.index;
            const tag = row.current ? 'current' : '';
            return (
              <Row
                key={`db:${row.database}`}
                width={innerW}
                pointer={false}
                selected={on}
                focused={active}
                segments={[
                  { text: on ? '❯ ' : row.current ? '▾ ' : '▸ ', color: theme.accent, bold: true },
                  { text: fit(row.database, Math.max(4, innerW - 2 - tag.length)), bold: row.current, strong: true, color: isSystem(row.database) && !row.current ? theme.dim : undefined },
                  { text: tag, color: theme.dim },
                ]}
              />
            );
          }
          if (row.empty) return <Row key="empty" width={innerW} pointer={false} segments={[{ text: `    ${row.empty}`, color: theme.dim }]} />;
          if (row.header) {
            return <Row key={`h${row.header}`} width={innerW} pointer={false} segments={[{ text: `  ${row.header}`, color: theme.schema, bold: true }, { text: ` (${row.count})`, color: theme.dim }]} />;
          }
          const k = KIND[row.obj.kind];
          return (
            <Row
              key={`${row.obj.kind}:${row.obj.schema}.${row.obj.name}`}
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
        <Panel title={db ?? (obj ? `${obj.schema}.${obj.name}` : 'Columns')} hint={db ? '↵ switch to it' : obj ? '↵ rows · d describe · s query' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={side} />
        </Panel>
      ) : null}
    </Box>
  );
}
