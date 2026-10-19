import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read per call so tests can point TRAWL_HOME somewhere temporary.
const configDir = () => process.env.TRAWL_HOME || join(homedir(), '.trawl');

// `history` is what was typed at the prompt; `ran` is every statement that reached a database.
// `updateCheck` remembers the last look at GitHub Releases, so it happens at most once a day.
const DEFAULTS = { connections: [], history: [], ran: [], limit: 500, last: null, checkUpdates: true, updateCheck: null };

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

// The Query console's text lives beside the config, so it is there again next time.
const consolePath = () => join(configDir(), 'console.sql');

export function loadConsole() {
  try {
    return readFileSync(consolePath(), 'utf8');
  } catch {
    return '';
  }
}

export function saveConsole(text) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(consolePath(), text);
  } catch {
    // As with the config: not being able to keep it shouldn't stop anything.
  }
}
