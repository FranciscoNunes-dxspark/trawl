import React, { useEffect, useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { TOP_SORTS, TOP_SOURCES, activityRows, count, duration, shortDuration, jobDetails, nextSort, queryDetails, serverTime, sessionDetails } from '../activity.js';
import { oneLine } from '../sql.js';
import { theme } from '../theme.js';
import { fit, relTime, wrap } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

const STATUS_COLORS = () => ({ running: theme.ok, runnable: theme.ok, suspended: theme.warn, sleeping: theme.dim, background: theme.dim });

// The details with their labels dimmed, down to the first blank line (before the SQL).
function labelled(lines) {
  const sqlAt = lines.includes('') ? lines.indexOf('') : lines.length;
  return lines.map((l, i) => (i < sqlAt ? [{ text: l.slice(0, 10), color: theme.dim }, { text: l.slice(10) }] : l));
}

const NOT_CONNECTED = [[{ text: '  Not connected. Press 5 for Connections, or /connect <name>.', color: theme.dim }]];

// A message across the list, wrapped to it.
const para = (text, width, color) => wrap(text, width - 2).map((l) => [{ text: `  ${l}`, color }]);

/**
 * The Activity tab: the server's sessions, or (J) its SQL Agent jobs, or (Q) the queries that cost
 * the most. The same key again, or esc, goes back to the sessions.
 */
export function ActivityView({ lists, ...props }) {
  const show = lists?.show ?? 'sessions';
  if (show === 'jobs') return <JobsList read={lists.jobs} {...props} />;
  if (show === 'queries') return <TopQueriesList read={lists.queries} {...props} />;
  return <SessionsList {...props} />;
}

// J and Q switch lists, and the list's own key (or esc, unless it cancels a read) goes back.
function switchKeys(ctx, show, input, key) {
  const to = input === 'J' ? 'jobs' : input === 'Q' ? 'queries' : key.escape && show !== 'sessions' && !ctx.busy ? 'sessions' : null;
  if (!to) return false;
  a.showActivityList(ctx, to === show ? 'sessions' : to);
  return true;
}

/**
 * The server's sessions, as SSMS's Activity Monitor lists them: blocking chains first, drawn as a
 * tree under the session at their head, then what else is running. R reads them again, x kills one,
 * a shows the idle ones too, ↵ shows a session's SQL in full.
 */
function SessionsList({ activity, session, ctx, width, height, active }) {
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
    if (nav.handle(input, key) || switchKeys(ctx, 'sessions', input, key)) return;
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
  if (!session) body = NOT_CONNECTED;
  else if (activity?.error) body = [[{ text: `  ${activity.error}`, color: theme.del }], '', [{ text: '  Reading sessions needs VIEW SERVER STATE (VIEW DATABASE STATE on Azure SQL Database).', color: theme.dim }]];
  else if (activity && !rows.length) body = [[{ text: all ? '  No sessions.' : '  Nothing running, and nothing blocked. a shows the idle sessions too.', color: theme.dim }]];

  return (
    <Box width={width} height={height}>
      <Panel title="Activity · sessions" hint={hint} width={listW} height={height} focused={active}>
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
          <Lines width={sideW - 2} height={innerH} lines={row ? labelled(sessionDetails(row.session, activity)) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}

const JOB_COLORS = () => ({ failed: theme.del, succeeded: theme.ok, retry: theme.warn, cancelled: theme.warn, running: theme.ok });
const JOB_MARKS = { failed: '✗', succeeded: '✓', retry: '↻', cancelled: '–', running: '▶' };

// Lists other than the sessions read themselves when they open (or the connection changes), and say
// when they were read, or what they're doing.
function useRead(read, session, load, { database = false } = {}) {
  const stale = !read || read.conn !== session?.conn.name || (database && read.database !== session?.database);
  useEffect(() => {
    if (session && stale) load();
  }, [session, stale]);
}

// The cursor stays on the same job or query when they're read again, and when the list comes back
// after the viewer (which takes its place on screen) closes.
function useKeptNav(ctx, list, items, height, at) {
  const kept = (ctx.activityCursor ??= {});
  const start = Math.max(0, items.findIndex((x) => x.id === kept[list]));
  const nav = useListNav(items.length, height, { resetKey: at, start });
  kept[list] = items[nav.index]?.id;
  return nav;
}

/**
 * SQL Agent's jobs, from msdb: whether each runs now, how its last run went (failures in red) and
 * when it runs next. ↵ shows its recent runs, s starts it (after asking), R reads them again.
 */
function JobsList({ read, session, ctx, width, height, active }) {
  const jobs = read?.jobs ?? [];
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.6) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useKeptNav(ctx, 'jobs', jobs, innerH, read?.at);
  const job = jobs[nav.index];
  useRead(read, session, () => a.loadJobs(ctx));

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key) || switchKeys(ctx, 'jobs', input, key)) return;
    if (input === 'R') return a.loadJobs(ctx);
    const j = jobs[nav.current()];
    if (!j) return;
    if (input === 's') a.startJob(ctx, j);
    else if (key.return) a.showJobHistory(ctx, j);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const colors = JOB_COLORS();
  const failed = jobs.filter((j) => j.last?.status === 'failed' && !j.running).length;
  const running = jobs.filter((j) => j.running).length;
  const hint = !session
    ? ''
    : read?.error
      ? 'R try again'
      : read && !read.unavailable
        ? `${jobs.length}${failed ? ` · ${failed} failed` : ''}${running ? ` · ${running} running` : ''}`
        : read
          ? ''
          : 'reading…';
  let body;
  if (!session) body = NOT_CONNECTED;
  else if (read?.error) body = [...para(read.error, innerW, theme.del), '', ...para("Reading the jobs needs one of msdb's SQL Agent roles (SQLAgentReaderRole, say) or sysadmin.", innerW, theme.dim)];
  else if (read?.unavailable) body = para(read.unavailable, innerW, theme.dim);
  else if (read && !jobs.length) body = [[{ text: '  No SQL Agent jobs on this server.', color: theme.dim }]];
  const stateW = 10;
  const durW = 11;
  const nextW = 16;
  // The pointer and the mark, then the name, and each column after a space (two before the next run).
  const nameW = Math.max(10, innerW - 4 - (1 + stateW) - (1 + durW) - (2 + nextW));

  return (
    <Box width={width} height={height}>
      <Panel title="Activity · SQL Agent jobs" hint={hint} width={listW} height={height} focused={active}>
        {body ? (
          <Lines width={innerW} height={innerH} lines={body} />
        ) : (
          jobs.slice(nav.offset, nav.offset + innerH).map((j, i) => {
            const status = j.running ? 'running' : (j.last?.status ?? null);
            const failedLast = status === 'failed';
            return (
              <Row
                key={j.id || j.name}
                width={innerW}
                selected={nav.offset + i === nav.index}
                focused={active}
                segments={[
                  { text: `${JOB_MARKS[status] ?? ' '} `, color: colors[status] ?? theme.dim, bold: failedLast },
                  { text: fit(j.name, nameW), bold: true, strong: true, color: failedLast ? theme.del : j.enabled ? undefined : theme.dim },
                  { text: ` ${fit(status ?? 'never run', stateW)}`, color: colors[status] ?? theme.dim, bold: failedLast },
                  { text: ` ${fit(duration(j.running ? j.runningMs : j.last?.durationMs), durW, 'right')}`, color: theme.dim },
                  { text: `  ${fit(!j.enabled ? 'disabled' : j.nextRun ? `next ${serverTime(j.nextRun).slice(5)}` : 'no schedule', nextW)}`, color: j.enabled && j.nextRun ? theme.info : theme.dim },
                ]}
              />
            );
          })
        )}
      </Panel>
      {split ? (
        <Panel title={job ? `Job ${job.name}` : 'Job'} hint={job ? '↵ recent runs · s start' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={job ? labelled(jobDetails(job)) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}

/**
 * The queries that cost the most in this database: Query Store's last 24 hours (or SQL Server's plan
 * cache, pg_stat_statements, performance_schema), sorted by total duration, o for CPU, reads or
 * executions. ↵ shows one in full, e puts it in the console, R reads them again.
 */
function TopQueriesList({ read, session, ctx, width, height, active }) {
  const queries = read?.queries ?? [];
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.6) : width;
  const sideW = width - listW;
  const innerW = listW - 2;
  // A note (Query Store is off, so this is the plan cache) and the column names, above the rows.
  // Where they come from and how they're sorted, a note (Query Store is off, so this is the plan
  // cache), and the column names, above the rows.
  const note = read?.note && read.queries?.length ? wrap(read.note, innerW - 2) : [];
  const top = 2 + note.length;
  const innerH = height - 2 - top;
  const nav = useKeptNav(ctx, 'queries', queries, innerH, read?.at);
  const q = queries[nav.index];
  useRead(read, session, () => a.loadTopQueries(ctx), { database: true });
  const source = TOP_SOURCES[read?.source];
  const sort = read?.sort ?? 'duration';

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key) || switchKeys(ctx, 'queries', input, key)) return;
    if (input === 'R') return a.loadTopQueries(ctx);
    // Sorted another way, the list starts from its top again.
    if (input === 'o' && read?.source) return (ctx.activityCursor.queries = null), a.loadTopQueries(ctx, { sort: nextSort(sort, read.source) });
    const it = queries[nav.current()];
    if (!it) return;
    if (input === 'e') ctx.editInConsole(it.sql);
    else if (key.return) ctx.showText(`Query ${it.id}`, queryDetails(it, read).join('\n'));
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1 - top) && e.double) keys('', { return: true });
  });

  const sortLabel = TOP_SORTS.find((x) => x.id === sort)?.label;
  const hint = !session
    ? ''
    : read?.error
      ? 'R try again'
      : read && source
        ? `${queries.length}`
        : read
          ? ''
          : 'reading…';
  let body;
  if (!session) body = NOT_CONNECTED;
  else if (read?.error) body = [...para(read.error, innerW, theme.del), '', ...para('Reading them needs VIEW DATABASE STATE (VIEW SERVER STATE for the plan cache).', innerW, theme.dim)];
  else if (read?.unavailable) body = para(read.unavailable, innerW, theme.dim);
  else if (read && !queries.length) body = [...(read.note ? para(read.note, innerW, theme.warn) : []), ...para(`No queries in ${source?.label ?? 'the statistics'} yet.`, innerW, theme.dim)];
  // Each number column, and whether it's the one the list is sorted by.
  const cols = [
    ['total', 6, (x) => shortDuration(x.totalMs), 'duration'],
    ['avg', 6, (x) => shortDuration(x.avgMs), null],
    ...(source?.sorts.includes('cpu') ? [['cpu', 6, (x) => shortDuration(x.cpuMs), 'cpu']] : []),
    ['reads', 6, (x) => count(x.reads), 'reads'],
    ['runs', 6, (x) => count(x.executions), 'executions'],
  ];
  const header = [{ text: '  ' }, ...cols.map(([name, w, , id]) => ({ text: `${fit(name, w, 'right')} `, color: id === sort ? theme.accent : theme.dim, bold: id === sort })), { text: ' query', color: theme.dim }];

  return (
    <Box width={width} height={height}>
      <Panel title="Activity · top queries" hint={hint} width={listW} height={height} focused={active}>
        {body ? (
          <Lines width={innerW} height={height - 2} lines={body} />
        ) : (
          <>
            <Row pointer={false} width={innerW} segments={[{ text: `  ${source?.label ?? ''}`, color: theme.info }, { text: ` · by ${sortLabel}`, color: theme.dim }]} />
            {note.map((l, i) => (
              <Row key={`note${i}`} pointer={false} width={innerW} segments={[{ text: `  ${l}`, color: theme.warn }]} />
            ))}
            <Row pointer={false} width={innerW} segments={header} />
            {queries.slice(nav.offset, nav.offset + innerH).map((x, i) => (
              <Row
                key={`${x.id}:${i}`}
                width={innerW}
                selected={nav.offset + i === nav.index}
                focused={active}
                segments={[...cols.map(([, w, value, id]) => ({ text: `${fit(value(x), w, 'right')} `, color: id === sort ? undefined : theme.dim, bold: id === sort })), { text: ` ${oneLine(x.sql)}` }]}
              />
            ))}
          </>
        )}
      </Panel>
      {split ? (
        <Panel title={q ? `Query ${q.id}` : 'Query'} hint={q ? '↵ full text · e edit' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={height - 2} lines={q ? labelled(queryDetails(q, read)) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}
