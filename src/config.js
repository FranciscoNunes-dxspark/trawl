import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Read per call so tests can point TRAWL_HOME somewhere temporary.
export const configDir = () => process.env.TRAWL_HOME || join(homedir(), '.trawl');

// `history` is what was typed at the prompt; `ran` is every statement that reached a database.
// `updateCheck` remembers the last look at GitHub Releases, so it happens at most once a day;
// `autoUpdate: false` keeps the check but only says a release is out, instead of installing it.
const DEFAULTS = { connections: [], history: [], ran: [], limit: 500, last: null, checkUpdates: true, autoUpdate: true, updateCheck: null };

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(join(configDir(), 'config.json'), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Saves everything except the demo connections, which only live for the session. */
export function saveConfig(config) {
  try {
    mkdirSync(configDir(), { recursive: true });
    const keep = { ...config, connections: config.connections.filter((c) => !c.demo) };
    writeFileSync(join(configDir(), 'config.json'), JSON.stringify(keep, null, 2));
  } catch {
    // A read-only home folder shouldn't stop the app; settings just won't stick.
  }
}

/** Adds a statement to the run history, newest first. */
export function withRan(config, entry) {
  return { ...config, ran: [entry, ...config.ran].slice(0, 500) };
}

// The Query console's text lives beside the config, so it is there again next time: console.sql for
// the first tab, consoles/<name>.sql for the others (consoles.js).
const consolePath = (file = 'console.sql') => join(configDir(), file);

export function loadConsole(file) {
  try {
    return readFileSync(consolePath(file), 'utf8');
  } catch {
    return '';
  }
}

export function saveConsole(text, file) {
  try {
    mkdirSync(dirname(consolePath(file)), { recursive: true });
    writeFileSync(consolePath(file), text);
  } catch {
    // As with the config: not being able to keep it shouldn't stop anything.
  }
}

/** Deletes a closed tab's file. */
export function removeConsole(file) {
  try {
    if (file !== 'console.sql') rmSync(consolePath(file), { force: true });
  } catch {
    // Left behind, it does no harm.
  }
}

/**
 * What Claude ran through `trawl mcp` (a separate process, so it appends to its own file rather
 * than racing the app for config.json), newest first.
 */
export function loadClaudeHistory() {
  try {
    return readFileSync(join(configDir(), 'claude-history.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse()
      .slice(0, 500);
  } catch {
    return [];
  }
}
