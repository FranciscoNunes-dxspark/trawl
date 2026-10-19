import React from 'react';
import { render } from 'ink';
import { COMPILED, VERSION } from './version.js';
import { fetchLatest } from './update.js';
import { loadConfig } from './config.js';
import { DEMO_CONNECTIONS } from './connections.js';
import { setAccent } from './theme.js';
import { App } from './ui/App.jsx';

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
  setAccent(config.accent);

  // Draw on the alternate screen, like a full-screen app, and give the terminal back untouched on exit.
  process.stdout.write('\x1b[?1049h\x1b[H');
  process.on('exit', () => process.stdout.write('\x1b[?1049l'));

  // Only the downloaded executables look for updates: a checkout updates with git pull, and its
  // package.json version is behind the releases (the Release workflow sets the version as it builds).
  const checkLatest = COMPILED ? (opts) => fetchLatest({ current: VERSION, ...opts }) : undefined;
  const app = render(<App config={config} initialFile={file} initialConnection={connectTo} checkLatest={checkLatest} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  process.exit(0);
}
