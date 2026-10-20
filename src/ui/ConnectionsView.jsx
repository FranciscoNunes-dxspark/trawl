import React from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { AI_LABELS, aiLevel } from '../ai.js';
import { commitMode, connectionRows, describeConn, isReadOnly } from '../connections.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

const AUTH = { 'azure-cli': 'az login', sql: 'SQL login', ntlm: 'Windows (NTLM)' };

export function ConnectionsView({ connections, current, ctx, width, height, active }) {
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.6) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  // Folders as DataGrip shows them: a heading, then its connections indented under it.
  const rows = connectionRows(connections);
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.conn) });
  const c = rows[nav.index]?.conn;
  const nameW = Math.min(24, Math.max(6, ...connections.map((x) => x.name.length)));
  const store = ctx.credentials.name;

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key)) return;
      if (input === 'n') return ctx.prefill('/add ');
      if (!c) return;
      if (key.return) a.connect(ctx, c.name);
      else if (input === 'x') a.forgetConnection(ctx, c.name);
      else if (input === 'p') a.setPassword(ctx, c.name);
      else if (input === 'f') ctx.prefill(`/folder ${c.name} ${c.folder ?? ''}`);
    },
    { isActive: active },
  );

  const details = c
    ? [
        ...(c.folder ? [[{ text: 'Folder    ', color: theme.dim }, { text: `${c.folder}/` }]] : []),
        [{ text: 'Server    ', color: theme.dim }, { text: c.server }],
        [{ text: 'Database  ', color: theme.dim }, { text: c.database ?? '(the login’s default)' }],
        [{ text: 'Sign-in   ', color: theme.dim }, { text: c.demo ? 'none (demo)' : AUTH[c.auth] ?? c.auth }],
        ...(c.user ? [[{ text: 'Login     ', color: theme.dim }, { text: `${c.domain ? `${c.domain}\\` : ''}${c.user}` }]] : []),
        ...(c.user && !c.demo ? [[{ text: 'Password  ', color: theme.dim }, { text: c.passwordEnv ? `$${c.passwordEnv}, else ${store}` : `${store} (asked when you connect; p changes it)` }]] : []),
        [{ text: 'Writes    ', color: theme.dim }, isReadOnly(c) ? { text: 'read-only until /writes', color: theme.warn } : { text: 'allowed' }],
        [{ text: 'Commit    ', color: theme.dim }, commitMode(c) === 'manual' ? { text: 'manual: a write waits for /commit' } : { text: 'auto: each statement as it runs' }, { text: '  (/tx to change)', color: theme.dim }],
        [{ text: 'Claude    ', color: theme.dim }, { text: `may see ${AI_LABELS[aiLevel(c)]}`, color: aiLevel(c) === 'results' ? theme.warn : undefined }, { text: '  (/ai to change)', color: theme.dim }],
        ...(c.prod ? [[{ text: `Production${commitMode(c) === 'manual' ? ': writes run in a transaction you /commit or /rollback' : ', committing each write as it runs'}`, color: theme.del }]] : []),
      ]
    : [];

  return (
    <Box width={width} height={height}>
      <Panel title="Connections" hint={`${connections.length}`} width={listW} height={height} focused={active}>
        {connections.length === 0 ? (
          <Lines
            width={innerW}
            height={innerH}
            lines={[
              [{ text: '  No connections yet. Press n, or:', color: theme.dim }],
              '',
              [{ text: '  /add club-a myserver.database.windows.net ClubA', color: theme.accent }],
              [{ text: '      Azure SQL, signing in with your az login', color: theme.dim }],
              [{ text: '  /add local localhost,1433 Dev --user sa --trust-cert', color: theme.accent }],
              [{ text: `      a SQL login; Trawl asks for the password when you connect and keeps it in ${store}`, color: theme.dim }],
              [{ text: '  Add --prod to make a connection read-only and transactional, --folder <name> to file it.', color: theme.dim }],
              [{ text: '  Or bring in DataGrip’s: /import datagrip', color: theme.dim }],
              [{ text: '  Or try it out first: trawl --demo', color: theme.dim }],
            ]}
          />
        ) : null}
        {rows.slice(nav.offset, nav.offset + innerH).map((row, i) => {
          if (row.folder) {
            return (
              <Row
                key={`folder:${row.folder}`}
                width={innerW}
                segments={[
                  { text: `▾ ${row.folder}/`, color: theme.accent, bold: true },
                  { text: `  ${row.count}`, color: theme.dim },
                ]}
              />
            );
          }
          const x = row.conn;
          const on = current && current.name === x.name;
          return (
            <Row
              key={x.name}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: row.inFolder ? '  ' : '' },
                { text: on ? '● ' : '  ', color: theme.accent, bold: true },
                { text: fit(x.name, nameW), bold: on, strong: true, color: on ? theme.accent : undefined },
                { text: x.prod ? ' PROD ' : '      ', color: theme.del, bold: true },
                { text: ` ${describeConn(x)}`, color: theme.dim },
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={c ? c.name : 'Details'} hint={c ? '↵ connect · p password · f folder · x forget' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={details} />
        </Panel>
      ) : null}
    </Box>
  );
}
