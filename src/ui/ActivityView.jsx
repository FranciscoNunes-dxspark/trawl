import React, { useEffect, useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { activityRows, duration, sessionDetails } from '../activity.js';
import { oneLine } from '../sql.js';
import { theme } from '../theme.js';
import { fit, relTime } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

const STATUS_COLORS = () => ({ running: theme.ok, runnable: theme.ok, suspended: theme.warn, sleeping: theme.dim, background: theme.dim });

// The details with their labels dimmed, down to the blank line before the SQL.
function detailLines(s, activity) {
  const lines = sessionDetails(s, activity);
  const sqlAt = lines.indexOf('');
  return lines.map((l, i) => (i < sqlAt ? [{ text: l.slice(0, 10), color: theme.dim }, { text: l.slice(10) }] : l));
}

/**
 * The server's sessions, as SSMS's Activity Monitor lists them: blocking chains first, drawn as a
 * tree under the session at their head, then what else is running. R reads them again, x kills one,
 * a shows the idle ones too, ↵ shows a session's SQL in full.
 */
export function ActivityView({ activity, session, ctx, width, height, active }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => (activity ? activityRows(activity, { all }) : []), [activity, all]);
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.6) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { resetKey: `${activity?.at}:${all}` });
  const row = rows[nav.index];

  // Opening the tab (or connecting while it's open) reads the sessions.
  const stale = !activity || activity.conn !== session?.conn.name;
  useEffect(() => {
    if (session && stale) a.loadActivity(ctx);
  }, [session, stale]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'R') return a.loadActivity(ctx);
    if (input === 'a') return setAll((x) => !x);
    const r = rows[nav.current()];
    if (!r) return;
    if (input === 'x') a.killSession(ctx, r.session.id);
    else if (key.return) ctx.showText(`Session ${r.session.id}`, sessionDetails(r.session, activity).join('\n'));
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const colors = STATUS_COLORS();
  const chains = rows.filter((r) => r.depth === 0 && r.blocks).length;
  const hint = !session
    ? ''
    : activity?.error
      ? 'R try again'
      : activity
        ? `${rows.length} of ${activity.sessions.length}${chains ? ` · ${chains} blocking` : ''} · read ${relTime(activity.at)} ago`
        : 'reading…';
  let body;
  if (!session) body = [[{ text: '  Not connected. Press 5 for Connections, or /connect <name>.', color: theme.dim }]];
  else if (activity?.error) body = [[{ text: `  ${activity.error}`, color: theme.del }], '', [{ text: '  Reading sessions needs VIEW SERVER STATE (VIEW DATABASE STATE on Azure SQL Database).', color: theme.dim }]];
  else if (activity && !rows.length) body = [[{ text: all ? '  No sessions.' : '  Nothing running, and nothing blocked. a shows the idle sessions too.', color: theme.dim }]];

  return (
    <Box width={width} height={height}>
      <Panel title="Activity" hint={hint} width={listW} height={height} focused={active}>
        {body ? (
          <Lines width={innerW} height={innerH} lines={body} />
        ) : (
          rows.slice(nav.offset, nav.offset + innerH).map((r, i) => {
            const s = r.session;
            const state = s.blockedBy != null ? `blocked by ${s.blockedBy}` : s.status;
            return (
              <Row
                key={s.id}
                width={innerW}
                selected={nav.offset + i === nav.index}
                focused={active}
                segments={[
                  { text: r.depth ? `${'  '.repeat(r.depth - 1)}└ ` : '', color: theme.border },
                  { text: fit(String(s.id), 4, 'right'), bold: true, strong: true, color: s.id === activity.me ? theme.accent : undefined },
                  { text: ` ${fit(state, 14)}`, color: s.blockedBy != null ? theme.del : colors[s.status] },
                  { text: r.blocks ? ` ▲${fit(String(r.blocks), 2)}` : '    ', color: theme.del, bold: true },
                  { text: ` ${fit(s.wait ?? '', 10)}`, color: theme.warn },
                  { text: ` ${fit(duration(s.elapsedMs), 9, 'right')}`, color: theme.dim },
                  { text: ` ${fit(s.login, 12)}`, color: theme.info },
                  { text: ` ${oneLine(s.sql)}` },
                ]}
              />
            );
          })
        )}
      </Panel>
      {split ? (
        <Panel title={row ? `Session ${row.session.id}` : 'Session'} hint={row ? `↵ full SQL · x kill${row.blocks ? ` · blocks ${row.blocks}` : ''}` : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={row ? detailLines(row.session, activity) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}
