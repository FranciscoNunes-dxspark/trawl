// Running one read-only query on every connection in a folder: which connections those are, and
// their result sets merged into one, each row led by the connection and database it came from.
// Pure; actions.js opens the sessions and runs the query.

const lower = (s) => String(s ?? '').toLowerCase();

/** Every folder the connections are in, parents included ("Clubs/PROD" gives "Clubs" too), by name. */
export function folderNames(connections) {
  const out = new Set();
  for (const c of connections) {
    const parts = String(c.folder ?? '').split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'));
  }
  return [...out].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }));
}

/** The connections in `folder` or a folder under it, ignoring case. */
export function inFolder(connections, folder) {
  const f = lower(String(folder ?? '').replace(/^\/+|\/+$/g, ''));
  if (!f) return [];
  return connections.filter((c) => c.folder && (lower(c.folder) === f || lower(c.folder).startsWith(`${f}/`)));
}

/**
 * The query as it runs on each connection: inside a transaction that is rolled back afterwards, as
 * trawl mcp runs Claude's, a second lock behind refusing writes. `offset` is the lines added in front.
 */
export const readOnlyScript = (text) => ({ sql: `SET XACT_ABORT ON;\nBEGIN TRANSACTION;\n${text}`, offset: 2 });

/**
 * Merges what each connection returned ({ conn, database, sets } or { conn, database, error }) into
 * result sets: the n-th set of every connection goes into the n-th merged one, led by `connection` and
 * `database` columns. Columns are matched by name, ignoring case; one a connection lacks is NULL in its
 * rows. `messages` says how many answered and what each failure was.
 */
export function mergeResults(parts) {
  const answered = parts.filter((p) => !p.error);
  const most = Math.max(0, ...answered.map((p) => p.sets.length));
  const sets = [];
  for (let k = 0; k < most; k++) {
    const columns = [];
    const index = new Map();
    for (const p of answered) {
      for (const c of p.sets[k]?.columns ?? []) {
        const key = lower(c.name);
        if (!index.has(key)) {
          index.set(key, columns.length);
          columns.push({ name: c.name, type: c.type ?? '' });
        }
      }
    }
    const rows = [];
    let truncated = false;
    for (const p of answered) {
      const set = p.sets[k];
      if (!set) continue;
      truncated ||= Boolean(set.truncated);
      const at = set.columns.map((c) => index.get(lower(c.name)));
      for (const row of set.rows) {
        const out = new Array(columns.length).fill(null);
        row.forEach((v, i) => (out[at[i]] = v));
        rows.push([p.conn, p.database ?? null, ...out]);
      }
    }
    // Names the query itself returns win: theirs are kept, and these get a different one.
    const taken = new Set(columns.map((c) => lower(c.name)));
    const lead = (name) => (taken.has(name) ? `[${name}]` : name);
    sets.push({ columns: [{ name: lead('connection'), type: 'NVarChar' }, { name: lead('database'), type: 'NVarChar' }, ...columns], rows, truncated });
  }
  const failed = parts.filter((p) => p.error);
  const messages = [`${answered.length} of ${parts.length} connection${parts.length === 1 ? '' : 's'} answered`, ...failed.map((p) => `${p.conn}${p.database ? ` (${p.database})` : ''}: ${String(p.error).split('\n')[0]}`)];
  return { sets, messages };
}

/** Runs `fn` over `items`, at most `n` at a time, keeping their order in the answers. */
export async function inParallel(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
