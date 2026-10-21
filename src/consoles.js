// The console's tabs: several named SQL buffers sharing the session, each kept in a file of its own
// beside the config. The first is console.sql, as when there was only one. Pure: App keeps their
// text and undo history, config.js reads and writes the files.

export const FIRST_TAB = { name: 'console', file: 'console.sql' };

/** The tabs as config.json lists them ({ name, file }), the first console.sql when there are none. */
export function tabsOf(config) {
  const list = Array.isArray(config?.consoleTabs) ? config.consoleTabs.filter((t) => t?.name && t?.file && safeFile(t.file)) : [];
  return list.length ? list : [FIRST_TAB];
}

// Only names Trawl made itself: console.sql, or consoles/<something>.sql.
const safeFile = (file) => file === 'console.sql' || /^consoles\/[\w-]+\.sql$/.test(file);

/** Why `name` can't name a tab, or null when it can. */
export function tabNameProblem(name, tabs, { except = -1 } = {}) {
  const n = String(name ?? '').trim();
  if (!n) return 'Name the tab.';
  if (n.length > 30) return 'Keep a tab name under 30 characters.';
  if (/^\d+$/.test(n)) return 'A tab name can’t be just a number (those pick tabs by position).';
  if (/\s/.test(n)) return 'A tab name is one word (use - or _ between words).';
  if (tabs.some((t, i) => i !== except && t.name.toLowerCase() === n.toLowerCase())) return `There's a tab called ${n} already.`;
  return null;
}

/** A name no tab has yet: `base`, else base-2, base-3… */
export function freeName(tabs, base = 'query') {
  const taken = new Set(tabs.map((t) => t.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`.toLowerCase())) return `${base}-${n}`;
}

/** A file for a new tab, under consoles/, that no tab uses. The name stays the same through renames. */
export function freeFile(tabs, name) {
  const slug = String(name).toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'query';
  const taken = new Set(tabs.map((t) => t.file));
  for (let n = 1; ; n++) {
    const file = `consoles/${slug}${n > 1 ? `-${n}` : ''}.sql`;
    if (!taken.has(file)) return file;
  }
}

/** Which tab `which` means: a number counting from 1, or a name (ignoring case). -1 when none. */
export function findTab(tabs, which) {
  const w = String(which ?? '').trim();
  if (/^\d+$/.test(w)) return Number(w) >= 1 && Number(w) <= tabs.length ? Number(w) - 1 : -1;
  return tabs.findIndex((t) => t.name.toLowerCase() === w.toLowerCase());
}
