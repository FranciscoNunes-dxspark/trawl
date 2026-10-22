// The real credential store's error handling, with a stand-in for the keyring tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { osCredentials } from '../src/credentials.js';

// Linux's tool is secret-tool; macOS and Windows reach theirs another way.
test('a keyring tool that refuses before reading the password is an error, not a crash', { skip: process.platform !== 'linux' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trawl-keyring-'));
  const path = process.env.PATH;
  try {
    writeFileSync(join(dir, 'secret-tool'), '#!/bin/sh\necho "the keyring is locked" >&2\nexit 1\n');
    chmodSync(join(dir, 'secret-tool'), 0o755);
    process.env.PATH = `${dir}${delimiter}${path}`;
    // A password big enough that writing it outlasts the tool, which used to throw EPIPE outside any handler.
    for (let i = 0; i < 5; i++) await assert.rejects(osCredentials.set(`test-${i}`, { user: 'u', password: 'x'.repeat(200_000) }), /the keyring is locked|exit|Command failed/);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});
