import React from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { AI_LABELS, aiLevel } from '../ai.js';
import { describeConn, isReadOnly } from '../connections.js';
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
  const nav = useListNav(connections.length, innerH);
  const c = connections[nav.index];
  const nameW = Math.min(24, Math.max(6, ...connections.map((x) => x.name.length)));

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key)) return;
      if (input === 'n') return ctx.prefill('/add ');
      if (!c) return;
      if (key.return) a.connect(ctx, c.name);
      else if (input === 'x') a.forgetConnection(ctx, c.name);
    },
    { isActive: active },
  );

  const details = c
    ? [
        [{ text: 'Server    ', color: theme.dim }, { text: c.server }],
        [{ text: 'Database  ', color: theme.dim }, { text: c.database ?? '(the login’s default)' }],
        [{ text: 'Sign-in   ', color: theme.dim }, { text: c.demo ? 'none (demo)' : AUTH[c.auth] ?? c.auth }],
        ...(c.user ? [[{ text: 'Login     ', color: theme.dim }, { text: `${c.domain ? `${c.domain}\\` : ''}${c.user}` }]] : []),
        ...(c.passwordEnv ? [[{ text: 'Password  ', color: theme.dim }, { text: `from $${c.passwordEnv}` }]] : []),
        [{ text: 'Writes    ', color: theme.dim }, isReadOnly(c) ? { text: 'read-only until /writes', color: theme.warn } : { text: 'allowed' }],
        [{ text: 'Claude    ', color: theme.dim }, { text: `may see ${AI_LABELS[aiLevel(c)]}`, color: aiLevel(c) === 'results' ? theme.warn : undefined }, { text: '  (/ai to change)', color: theme.dim }],
        ...(c.prod ? [[{ text: 'Production: writes run in a transaction you /commit or /rollback', color: theme.del }]] : []),
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
              [{ text: '  /add local localhost,1433 Dev --user sa --password-env SA_PASSWORD --trust-cert', color: theme.accent }],
              [{ text: '      a SQL login; Trawl reads the password from that variable and never stores it', color: theme.dim }],
              [{ text: '  Add --prod to make a connection read-only and transactional.', color: theme.dim }],
              [{ text: '  Or try it out first: trawl --demo', color: theme.dim }],
            ]}
          />
        ) : null}
        {connections.slice(nav.offset, nav.offset + innerH).map((x, i) => {
          const on = current && current.name === x.name;
          return (
            <Row
              key={x.name}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
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
        <Panel title={c ? c.name : 'Details'} hint={c ? '↵ connect · x forget · n new' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={details} />
        </Panel>
      ) : null}
    </Box>
  );
}
