// Your own slash commands ("commands" in config.json), shared by Trawl and Splice. Pure: reading
// them from the config and filling in what's typed after them. App runs the lines.
//
//   "commands": {
//     "mine": "!…",                                         a line, as typed at the prompt (! is SQL in Trawl, git in Splice)
//     "morning": ["/one", "/two $1"],                       lines run in order, stopping at the first that fails
//     "d": { "run": "/describe $1", "desc": "Describe" }    with a description of its own
//   }

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * The commands in `spec` (config.json's "commands") as { name, args, desc, lines, user: true }, and
 * what was left out, and why, a line each in `problems`. `builtins` are the app's own commands'
 * names, which yours can't take.
 */
export function userCommands(spec, builtins = []) {
  const commands = [];
  const problems = [];
  if (spec == null) return { commands, problems };
  if (typeof spec !== 'object' || Array.isArray(spec)) return { commands, problems: ['"commands" should be an object: { "name": "/command or !line", … }'] };
  const taken = new Set(builtins.map((n) => n.toLowerCase()));
  for (const [raw, value] of Object.entries(spec)) {
    const name = raw.replace(/^\//, '').toLowerCase();
    if (!NAME.test(name)) {
      problems.push(`/${raw}: a name is letters, digits, - and _`);
      continue;
    }
    if (taken.has(name)) {
      problems.push(`/${name} is built in, so yours is left out: give it another name`);
      continue;
    }
    const v = typeof value === 'string' || Array.isArray(value) ? { run: value } : value;
    const lines = (Array.isArray(v?.run) ? v.run : [v?.run]).filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim());
    if (!lines.length || (Array.isArray(v?.run) && lines.length !== v.run.length)) {
      problems.push(`/${name}: give it a line to run, or a list of them, as text`);
      continue;
    }
    taken.add(name);
    const desc = typeof v.desc === 'string' && v.desc.trim() ? v.desc.trim() : lines.join(' then ');
    commands.push({ name, args: typeof v.args === 'string' && v.args.trim() ? v.args.trim() : argsOf(lines), desc, lines, user: true });
  }
  return { commands, problems };
}

/** What a command's lines take, for the menu: <1> <2> for $1 $2, [text] for $* alone, or nothing (null). */
export function argsOf(lines) {
  const text = lines.join('\n');
  const n = Math.max(0, ...[...text.matchAll(/(?<!\$)\$([1-9])/g)].map((m) => Number(m[1])));
  if (n) return Array.from({ length: n }, (_, i) => `<${i + 1}>`).join(' ') + (/(?<!\$)\$\*/.test(text) ? ' […]' : '');
  return /(?<!\$)\$\*/.test(text) ? '<text>' : null;
}

/** Whether a command can run without anything typed after it (picking it from the menu runs it). */
export const runsAlone = (cmd) => !cmd.args || cmd.args.startsWith('[');

/** Splits what's typed after a command into words; "quoted words" stay one. */
export function words(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}

/**
 * The command's lines with `rest` (what was typed after its name) filled in: $1…$9 its words (a
 * "quoted word" is one, put in without its quotes), $* all of it, $$ a $. A command whose lines
 * take nothing gets `rest` at the end of its last line, so "co": "/checkout" works as /co main.
 */
export function expandLines(cmd, rest = '') {
  const typed = String(rest ?? '').trim();
  const args = words(typed);
  const takes = cmd.lines.some((l) => /(?<!\$)\$([1-9*])/.test(l));
  const lines = cmd.lines.map((l) => l.replace(/\$(\$|[1-9]|\*)/g, (_, w) => (w === '$' ? '$' : w === '*' ? typed : args[Number(w) - 1] ?? '')));
  if (!takes && typed) lines[lines.length - 1] = `${lines.at(-1)} ${typed}`;
  return lines;
}
