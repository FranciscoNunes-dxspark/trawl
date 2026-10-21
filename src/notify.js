// Telling the terminal that a long query has finished, for when you've looked away: a bell, and a
// desktop notification through the escape sequence the terminal understands (OSC 9, as iTerm2,
// Windows Terminal, WezTerm and kitty take it, or OSC 777 for VTE terminals such as GNOME Terminal).
// Pure: cli.jsx writes what it returns.

// Seconds a run takes before its end is worth a notification, unless config.json says otherwise.
export const NOTIFY_AFTER = 10;

// Nothing in the text may end the sequence early or start another.
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f\x9b]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/** The bytes that ring the bell and raise a notification saying `title` and `body`, for this terminal. */
export function notification(title, body, env = process.env) {
  const t = clean(title);
  const b = clean(body);
  const vte = Boolean(env.VTE_VERSION) || /^(foot|rxvt)/.test(env.TERM ?? '');
  const osc = vte ? `\x1b]777;notify;${t.replace(/;/g, ',')};${b.replace(/;/g, ',')}\x1b\\` : `\x1b]9;${b ? `${t}: ${b}` : t}\x07`;
  return `\x07${osc}`;
}

/** Whether a run of `ms` should notify, by the config's `notify` (on unless false) and `notifyAfter` (seconds). */
export const worthNotifying = (ms, config) => config?.notify !== false && ms >= (Number(config?.notifyAfter) >= 0 ? Number(config.notifyAfter) : NOTIFY_AFTER) * 1000;
