import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read per call so tests can point FATHOM_HOME somewhere temporary.
const configDir = () => process.env.FATHOM_HOME || join(homedir(), '.fathom');

// `history` is what was typed at the prompt; `ran` is every statement that reached a database.
const DEFAULTS = { connections: [], history: [], ran: [], limit: 500, last: null };

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
