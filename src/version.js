import { readFileSync } from 'node:fs';

// The compiled builds have it baked in by scripts/build.js; from a checkout, read package.json.
export const VERSION =
  process.env.TRAWL_VERSION ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// True in the single-file executables, false when running from a checkout.
export const COMPILED = process.env.TRAWL_VERSION != null;
