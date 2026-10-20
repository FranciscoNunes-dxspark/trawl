import React from 'react';
import { Box, useInput } from 'ink';
import { configDir } from '../config.js';
import { ACCENTS, setAccent, theme } from '../theme.js';
import { relTime, wrap } from '../text.js';
import { checksDisabled } from '../update.js';
import { VERSION } from '../version.js';
import { useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

const LABEL_W = 20;

/**
 * Trawl's own settings (a connection's are on Connections), an overlay opened with , or /settings:
 * changed in place with ↵ or space and kept in config.json; esc or q closes it. `updates` says what this copy can do: { check, install } (only the downloaded
 * Trawl has either), and `update` is what the last check found, as the header shows it.
 */
export function SettingsView({ config, ctx, updates, update, width, height, active, onClose }) {
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.5) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;

  const accent = config.accent ?? ACCENTS[0].color;
  const preset = ACCENTS.findIndex((x) => x.color.toLowerCase() === accent.toLowerCase());
  const checksOff = checksDisabled(config);
  const envOff = checksOff && config.checkUpdates !== false;
  const onOff = (on, note = '') => [{ text: on ? 'on' : 'off', color: on ? theme.ok : theme.dim, bold: true }, ...(note ? [{ text: `  ${note}`, color: theme.dim }] : [])];
  const toggle = (key) => ctx.setConfig((c) => ({ ...c, [key]: c[key] === false }));
  const lastCheck = config.updateCheck?.at ? `${relTime(config.updateCheck.at)} ago${config.updateCheck.latest ? `, found ${config.updateCheck.latest.version}` : ''}` : 'never';
  const fromCheckout = 'This copy runs from a checkout, which never checks: git pull && npm install updates it.';

  const rows = [
    {
      label: 'Row limit',
      value: [{ text: `${config.limit} rows`, bold: true }],
      hint: '↵ change',
      about: ['Each result set stops at this many rows; Trawl cancels the rest of the query on purpose. Exports and the first rows of a table use it too.', '↵ puts /limit in the prompt: type a number from 1 to 1000000.'],
      // After every handler has had this ↵, or App's would take it as the prompt's and submit it.
      change: () => queueMicrotask(() => ctx.prefill('/limit ')),
    },
    {
      label: 'Accent colour',
      value: [
        { text: '██ ', color: accent },
        { text: preset >= 0 ? ACCENTS[preset].name : accent, bold: true },
        { text: preset === 0 ? '  (Glim’s)' : '', color: theme.dim },
      ],
      hint: '↵ next colour',
      about: [`The colour of the selection, the tabs and Glim's welcome box. ↵ goes through ${ACCENTS.map((x) => x.name).join(', ')}.`, 'Any colour works as "accent": "#rrggbb" in config.json.'],
      change: () => {
        const next = ACCENTS[(preset + 1) % ACCENTS.length].color;
        setAccent(next);
        ctx.setConfig((c) => ({ ...c, accent: next }));
      },
    },
    {
      label: 'Check for updates',
      value: onOff(!checksOff, envOff ? '($TRAWL_NO_UPDATE_CHECK is set)' : updates.check ? '' : '(not in a checkout)'),
      hint: '↵ turn on or off',
      about: [
        'Once a day, Trawl asks GitHub for the latest release. Only "trawl/<version>" is sent, never your connections or queries. A change counts from the next start.',
        ...(envOff ? ['The environment variable TRAWL_NO_UPDATE_CHECK turns it off whatever this says.'] : []),
        ...(updates.check ? [] : [fromCheckout]),
      ],
      change: () => toggle('checkUpdates'),
    },
    {
      label: 'Install updates',
      value: onOff(config.autoUpdate !== false, checksOff ? '(checks are off)' : config.autoUpdate === false ? '(only says one is out)' : ''),
      hint: '↵ turn on or off',
      about: [
        'A newer release downloads in the background and replaces this executable; it starts the next time you open Trawl. It must match the release’s checksums, or nothing changes.',
        'Off, Trawl only says one is out. /update still installs when you ask.',
        ...(updates.install ? [] : [fromCheckout]),
      ],
      change: () => toggle('autoUpdate'),
    },
    {
      label: 'Check now',
      value: [{ text: update ? `${update.version} ${{ installing: 'downloading…', installed: 'installed, at next start' }[update.state] ?? 'is out'}` : `last ${lastCheck}`, color: update ? theme.warn : theme.dim }],
      hint: '↵ check',
      about: ['Asks GitHub now, the same as /update, and installs a newer release in the downloaded Trawl.', `The last check: ${lastCheck}.`],
      change: () => ctx.checkUpdates(),
    },
  ];
  const nav = useListNav(rows.length, innerH);
  const row = rows[nav.index];

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') return onClose();
      if (nav.handle(input, key)) return;
      if (key.return || input === ' ') row.change();
    },
    { isActive: active },
  );

  const textW = sideW - 4;
  const about = [
    ...row.about.flatMap((p, i) => [...(i ? [''] : []), ...wrap(p, textW).map((l) => `  ${l}`)]),
    '',
    [{ text: '  About', bold: true }],
    [{ text: '  Version     ', color: theme.dim }, { text: VERSION }],
    [{ text: '  Settings    ', color: theme.dim }, { text: configDir() }],
    [{ text: '  Passwords   ', color: theme.dim }, { text: ctx.credentials.name }],
  ];

  return (
    <Box width={width} height={height}>
      <Panel title="Settings" hint={`${row.hint} · esc close`} width={listW} height={height} focused={active}>
        {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => (
          <Row
            key={r.label}
            width={innerW}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[{ text: r.label.padEnd(LABEL_W), strong: true }, ...r.value]}
          />
        ))}
      </Panel>
      {split ? (
        <Panel title={row.label} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={about} />
        </Panel>
      ) : null}
    </Box>
  );
}
