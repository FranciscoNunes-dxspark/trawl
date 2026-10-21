import React from 'react';
import { render } from 'ink';
import { COMPILED, VERSION } from './version.js';
import { fetchLatest, installUpdate, removeOldExecutables } from './update.js';
import { loadConfig } from './config.js';
import { DEMO_CONNECTIONS } from './connections.js';
import { applyTheme } from './theme.js';
import { App } from './ui/App.jsx';
import { terminalMouse } from './mouse.js';
import { notification } from './notify.js';

// A title is printed raw, so nothing in it may end or start an escape sequence.
const clean = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, '');

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`trawl ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`trawl [file.sql] [--connect <name>] [--demo]
trawl mcp [--demo]

A keyboard-driven SQL Server client. Opens [file.sql] in Query, and connects to
<name> (default: the connection you used last).

  --demo   adds two in-memory demo connections for this session (no server needed)
  mcp      runs Trawl as an MCP server for Claude Code, reading through your saved
           connections (register it with: claude mcp add trawl -- trawl mcp)

Inside: press ? for shortcuts, / for commands, ! to run SQL.`);
  process.exit(0);
}

// Claude Code starts this with pipes, not a terminal, so it comes before the TTY check.
if (args[0] === 'mcp') {
  const { serve } = await import('./mcp.js');
  serve({ demo: args.includes('--demo') });
} else {
  await runApp();
}

/** The full-screen app: needs a real terminal. */
async function runApp() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('trawl needs an interactive terminal.');
    process.exit(1);
  }

  const demo = args.includes('--demo');
  const at = args.indexOf('--connect');
  const connectTo = at >= 0 ? args[at + 1] : demo ? 'demo' : undefined;
  const file = args.find((x, i) => !x.startsWith('-') && args[i - 1] !== '--connect');

  const config = loadConfig();
  if (demo) config.connections = [...DEMO_CONNECTIONS, ...config.connections.filter((c) => !DEMO_CONNECTIONS.some((d) => d.name === c.name))];
  applyTheme(config);

  // Draw on the alternate screen, like a full-screen app, and give the terminal back untouched on
  // exit, window title included: terminals that keep a stack of titles get theirs back (CSI 22/23 t),
  // and on Windows the console's own title, which Node reads, is put back.
  const title = process.platform === 'win32' ? process.title : null;
  process.stdout.write('\x1b[?1049h\x1b[H\x1b[22;0t');
  process.on('exit', () => process.stdout.write(`\x1b[?1049l${title ? `\x1b]0;${clean(title)}\x07` : ''}\x1b[23;0t`));
  const setTitle = (text) => process.stdout.write(`\x1b]0;${clean(text)}\x07`);

  // Only the downloaded executables look for updates and install them: a checkout updates with git
  // pull, and its package.json version is behind the releases (the Release workflow sets the version as it builds).
  const checkLatest = COMPILED ? (opts) => fetchLatest({ current: VERSION, ...opts }) : undefined;
  // What an earlier update moved aside; quietly, and it doesn't hold up the start.
  if (COMPILED) removeOldExecutables();
  // Clicks and the wheel, where the terminal can report them; App turns reporting on unless the setting
  // is off. Set up before rendering, so mouse reports never reach Ink as keys.
  const mouse = await terminalMouse(process.stdin, process.stdout);
  const app = render(
    <App
      config={config}
      initialFile={file}
      initialConnection={connectTo}
      checkLatest={checkLatest}
      installUpdate={COMPILED ? installUpdate : undefined}
      setTitle={setTitle}
      mouse={mouse}
      notify={(title, body) => process.stdout.write(notification(title, body))}
    />,
    // Through the mouse's stdout, which watches the frames to select text from.
    { exitOnCtrlC: false, stdout: mouse?.stdout ?? process.stdout },
  );
  await app.waitUntilExit();
  process.exit(0);
}
