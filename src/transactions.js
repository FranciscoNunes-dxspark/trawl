// A transaction left open: after it has sat idle for a while ("openTransactionWarning" minutes in
// config.json, 5 by default, 0 for never), Trawl says so once, with what it holds. Pure: App keeps the
// clock, runs the dialect's locksSql and notifies.

// Minutes idle before the warning, unless config.json says otherwise.
export const WARN_AFTER = 5;
// What Settings' row goes through; 0 is off.
export const WARN_STEPS = [1, 2, 5, 10, 15, 30, 60, 0];

/** The minutes of the config's "openTransactionWarning" (fractions too), else 5; 0 means never. */
export function warnMinutes(config) {
  const v = config?.openTransactionWarning;
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) || n < 0 ? WARN_AFTER : n;
}

/** The step after `n` in Settings: 1, 2, 5, 10, 15, 30, 60 minutes, then off. */
export function nextWarnMinutes(n) {
  const i = WARN_STEPS.indexOf(n);
  return i >= 0 ? WARN_STEPS[(i + 1) % WARN_STEPS.length] : (WARN_STEPS.find((x) => x > n) ?? 0);
}

/** How long, as the header says it: "7m", "1h 5m", "2h"; '' under a minute. */
export function openFor(ms) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return '';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/** Minutes as the Settings row says them: "5 min", "30 s" for a fraction under one. */
export const minutesText = (n) => (n >= 1 ? `${Number.isInteger(n) ? n : n.toFixed(1)} min` : `${Math.round(n * 60)} s`);

/** Whether it's time to warn: a transaction open, idle `minutes` or more, not warned about yet. */
export const dueWarning = ({ open, warned, idleMs, minutes }) => Boolean(open && !warned && minutes > 0 && idleMs >= minutes * 60_000);

/**
 * What the transaction holds, from the dialect's locksSql (rows of object, resource type, mode and
 * count): a line per object, "dbo.Players: X on 3 keys, IX on the page, IX on the table".
 */
export function locksText(sets) {
  const rows = sets?.at(-1)?.rows ?? [];
  if (!rows.length) return ['It holds no locks in this database that Trawl can see (it may only have read so far).'];
  const by = new Map();
  for (const [object, type, mode, n] of rows) {
    const key = String(object ?? type ?? '?');
    if (!by.has(key)) by.set(key, []);
    const what = String(type ?? '').toLowerCase();
    const count = Number(n) || 1;
    const on = ['object', 'table', 'relation'].includes(what) ? 'the table' : count > 1 ? `${count} ${what}s` : `the ${what}`;
    by.get(key).push(`${mode} on ${on}`);
  }
  return [...by].map(([object, list]) => `${object}: ${list.join(', ')}`);
}

/** The warning's first line: "Transaction open on demo for 7m, idle 5m: /commit or /rollback ends it." */
export function warningTitle({ conn, openMs, idleMs }) {
  return `Transaction open on ${conn} for ${openFor(openMs) || 'under 1m'}, idle ${openFor(idleMs) || 'under 1m'}: /commit or /rollback ends it.`;
}
