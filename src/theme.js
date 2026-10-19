// One palette for the whole UI. The accent can be changed in ~/.trawl/config.json ("accent": "#hex").
export const theme = {
  accent: '#5fafff',
  border: '#5f5f5f',
  dim: '#8a8a8a',
  selBg: '#1c2b3d',
  ink: '#121212',
  ok: '#5fd75f',
  del: '#ff5f5f',
  warn: '#ffd75f',
  info: '#5fafd7',
  schema: '#af87ff',
  table: '#afd7ff',
  view: '#5fd7d7',
  routine: '#d787ff',
  nul: '#6c6c6c',
  number: '#ffaf5f',
  sqlMode: '#ff87d7',
};

// Windows terminals draw ⏺ as a wide emoji, so use the plain circle there (as Claude Code does).
export const BULLET = process.platform === 'win32' ? '●' : '⏺';

export function setAccent(color) {
  if (typeof color === 'string' && color) theme.accent = color;
}
