import React from 'react';
import { Box, useInput } from 'ink';
import { configDir } from '../config.js';
import { ACCENTS, THEMES, applyTheme, setAccent, theme } from '../theme.js';
import { relTime, wrap } from '../text.js';
import { checksDisabled } from '../update.js';
import { NOTIFY_AFTER } from '../notify.js';
import { minutesText, nextWarnMinutes, warnMinutes } from '../transactions.js';
import { VERSION } from '../version.js';
import { useListNav, useMouse } from './hooks.js';
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
  const themeSetting = THEMES.includes(config.theme) ? config.theme : 'auto';
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
        { text: '██ ', color: theme.accent },
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
      label: 'Theme',
      value: [{ text: themeSetting, bold: true }, { text: themeSetting === 'auto' ? `  ${theme.mode} here${process.env.COLORFGBG ? '' : ' (the terminal doesn’t say)'}` : '', color: theme.dim }],
      hint: '↵ next',
      about: [
        'Dark or light colours, for a dark or a light terminal background; the accent colour stays yours either way (a preset takes its darker shade on light).',
        'auto, the default, goes by COLORFGBG, which some terminals set (Konsole, rxvt, iTerm2 with its option on), and is dark where it isn’t set. ↵ goes through dark, light and auto; it is "theme" in config.json.',
      ],
      change: () => {
        const next = THEMES[(THEMES.indexOf(themeSetting) + 1) % THEMES.length];
        ctx.setConfig((c) => ({ ...c, theme: next }));
        applyTheme(ctx.config);
      },
    },
    {
      label: 'Mouse',
      value: onOff(config.mouse !== false, ctx.mouseAvailable ? '' : "(this terminal can't report it)"),
      hint: '↵ turn on or off',
      about: [
        'Click a tab, a row or the prompt, double-click for what ↵ does (but never to run a statement), and scroll with the wheel; shift+wheel scrolls the columns in Results. In the console a click puts the cursor there, and a double or triple click selects the word or the line.',
        'Drag to select text: it is copied when you let go (in the console, the SQL itself is selected). Off, Trawl leaves clicks and selecting to the terminal.',
        ...(ctx.mouseAvailable ? [] : ['This terminal can’t report the mouse to Trawl: on Windows, run the downloaded Trawl, or Node 22.17 or later.']),
      ],
      change: () => toggle('mouse'),
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
    {
      label: 'Notify when done',
      value: onOff(config.notify !== false, `after ${Number(config.notifyAfter) >= 0 ? Number(config.notifyAfter) : NOTIFY_AFTER} s`),
      hint: '↵ turn on or off',
      about: [
        `When a query (or anything with the spinner) takes longer than ${Number(config.notifyAfter) >= 0 ? Number(config.notifyAfter) : NOTIFY_AFTER} seconds, Trawl rings the terminal's bell and asks it for a desktop notification saying how it went, for when you've looked away.`,
        'Windows Terminal, iTerm2, WezTerm, kitty and GNOME Terminal show one; others just ring. "notifyAfter" in config.json changes the seconds.',
      ],
      change: () => toggle('notify'),
    },
    {
      label: 'Warn about open transactions',
      value: warnMinutes(config) ? [{ text: `after ${minutesText(warnMinutes(config))} idle`, bold: true }] : onOff(false),
      hint: '↵ next',
      about: [
        `When a transaction has been open and nothing has run for ${warnMinutes(config) ? minutesText(warnMinutes(config)) : 'a while'}, Trawl rings the bell and asks the terminal for a notification, once, and the log says what the transaction holds (its locks, which block other sessions) with a reminder of /commit and /rollback. The header says how long it has been open.`,
        '↵ goes through 1, 2, 5, 10, 15, 30 and 60 minutes, then off. "openTransactionWarning" in config.json takes any number of minutes (0 is off).',
      ],
      change: () => ctx.setConfig((c) => ({ ...c, openTransactionWarning: nextWarnMinutes(warnMinutes(c)) })),
    },
  ];
  const nav = useListNav(rows.length, innerH);
  const row = rows[nav.index];

  const keys = (input, key) => {
    if (key.escape || input === 'q') return onClose();
    if (nav.handle(input, key)) return;
    if (key.return || input === ' ') row.change();
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

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
            segments={[{ text: r.label.padEnd(Math.max(LABEL_W, r.label.length + 2)), strong: true }, ...r.value]}
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
