// Saved queries ("snippets"), kept in config.json by name for the connection they were saved on, or
// for every connection when saved while not connected. Pure: actions.js saves, lists and runs them.

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

// Words /snippet takes itself, which a snippet can't be called.
export const SNIPPET_WORDS = ['save', 'delete'];

/** Why `name` can't name a snippet, or null when it can: a word or two, no quotes or slashes. */
export function snippetNameProblem(name) {
  const n = String(name ?? '').trim();
  if (!n) return 'Name it: /snippet save <name>';
  if (n.length > 60) return 'Keep the name under 60 characters.';
  if (/["/\\]/.test(n)) return 'A snippet name can’t have quotes or slashes.';
  if (SNIPPET_WORDS.includes(n.toLowerCase())) return `"${n}" is one of /snippet's own words; pick another name.`;
  return null;
}

/** The snippets that go with connection `conn` (by name): its own first, then those for every connection, by name. */
export function snippetsFor(list, conn) {
  const byName = (x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' });
  return [...(list ?? []).filter((s) => conn && same(s.conn, conn)).sort(byName), ...(list ?? []).filter((s) => !s.conn).sort(byName)];
}

/** The one called `name` for `conn`: its own before one for every connection. */
export const findSnippet = (list, conn, name) => snippetsFor(list, conn).find((s) => same(s.name, name)) ?? null;

/** `list` with `snippet` in it, replacing one of the same name for the same connection. */
export const withSnippet = (list, snippet) => [...(list ?? []).filter((s) => !(same(s.name, snippet.name) && same(s.conn, snippet.conn))), snippet];

/** `list` without `snippet`. */
export const withoutSnippet = (list, snippet) => (list ?? []).filter((s) => !(same(s.name, snippet.name) && same(s.conn, snippet.conn)));
