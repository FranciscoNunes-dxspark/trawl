// Glim, Trawl's anglerfish. One pixel drawing feeds the terminal pet, the SVG logo and the app icon.
// Anglerfish carry their own light into the deep, which is roughly what a query does.

export const PALETTE = {
  B: '#5fafff', // outline and the lure's stalk, the accent blue
  D: '#1d4f91', // body
  P: '#3a7bd5', // belly
  E: '#081326', // eye, mouth
  W: '#ffffff', // eye shine, teeth
  Y: '#ffd75f', // the lure's glow
  L: '#fff6c2', // the lure's bright centre
  y: '#5c5230', // the lure, dimmed (asleep)
  l: '#7a6f45',
  R: '#ff875f', // the lure, amber-red (a transaction is open)
  r: '#ffd0b8',
};

// 16 × 10 pixels; '.' is transparent. Facing right: a forked tail on the left, a big round head,
// an open jaw full of teeth at the front, and the lure hanging on its stalk above it.
const BASE = [
  '......BBBBBB....',
  '.....B......YY..',
  '...BBBBBB..YLLY.',
  '..BDDDDDDB..YY..',
  'BBDDDDWEDDB.....',
  'BBDDDDEEDDDBBBB.',
  '.BDDDDDDDBWEWEW.',
  '.BDDDDDDDBEEEEE.',
  'BBDPPPPDDBEWEWE.',
  'B.BBBBBBBBBBBBB.',
];

// Each mood replaces some rows of the base drawing, and can recolour the lure.
const MOODS = {
  idle: {},
  look: { rows: { 4: 'BBDDDDEWDDB.....' } }, // glancing the other way, for the busy animation
  sleep: { rows: { 4: 'BBDDDDDDDDB.....' }, lure: ['y', 'l'] },
  happy: { rows: { 4: 'BBDDDDEEDDB.....', 5: 'BBDDDEDDEDDBBBB.' } },
  worried: { rows: { 4: 'BBDDDWWEDDB.....', 5: 'BBDDDWEEDDDBBBB.' } },
  alert: { lure: ['R', 'r'] },
};

/** The drawing for a mood, as rows of palette letters. */
export function glimPixels(mood = 'idle') {
  const { rows = {}, lure } = MOODS[mood] ?? {};
  const px = BASE.map((row, i) => rows[i] ?? row);
  return lure ? px.map((row) => row.replace(/Y/g, lure[0]).replace(/L/g, lure[1])) : px;
}

/**
 * The drawing as terminal rows of segments, two pixels per cell: "▀" with the top pixel as
 * the text colour and the bottom one as the background.
 */
export function glimRows(mood = 'idle') {
  const px = glimPixels(mood);
  const rows = [];
  for (let y = 0; y < px.length; y += 2) {
    const segs = [];
    for (let x = 0; x < px[y].length; x++) {
      const top = PALETTE[px[y][x]];
      const bottom = PALETTE[px[y + 1]?.[x]];
      if (top && bottom) segs.push({ text: '▀', color: top, bg: bottom });
      else if (top) segs.push({ text: '▀', color: top });
      else if (bottom) segs.push({ text: '▄', color: bottom });
      else segs.push({ text: ' ' });
    }
    rows.push(segs);
  }
  return rows;
}

/** A one-line fish for the header, facing the same way as Glim. */
export const FACES = {
  idle: '><((•>',
  look: '><((•>',
  sleep: '><((–>',
  happy: '><((^>',
  worried: '><((◉>',
  alert: '><((!>',
};

/** How Glim feels about the session right now. */
export function moodFor({ session, busy, lastEntry, tranCount = 0, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (tranCount) return 'alert';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  return session ? 'idle' : 'sleep';
}

/** A sentence for the welcome box. */
export function moodLine(mood, session) {
  if (mood === 'alert') return 'A transaction is open, so the lure is glowing red: /commit or /rollback.';
  if (mood === 'worried') return 'That one went wrong; the details are below.';
  if (!session) return 'Connect somewhere (5 for Connections) and Glim will light the way.';
  return `Down in ${session.database} on ${session.conn.name}. ↵ on a table brings up its rows.`;
}
