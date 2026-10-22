// One palette for the whole UI, dark or light (the Theme setting: "theme": "dark" | "light" | "auto"
// in ~/.trawl/config.json). The accent can be changed too ("accent": "#hex"). Everything on screen
// takes its colours from `theme`, read as it draws, so applyTheme repaints the next frame.
export const DARK = {
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
  func: '#87d7af',
  nul: '#6c6c6c',
  number: '#ffaf5f',
  bangMode: '#ff87d7',
};

// For a white (or pale) background: darker inks, a pale selection, white on the coloured bars.
export const LIGHT = {
  accent: '#005fd7',
  border: '#a8a8a8',
  dim: '#6c6c6c',
  selBg: '#d7e7ff',
  ink: '#ffffff',
  ok: '#008700',
  del: '#d70000',
  warn: '#af5f00',
  info: '#005f87',
  schema: '#5f00af',
  table: '#005f87',
  view: '#008787',
  routine: '#870087',
  func: '#005f5f',
  nul: '#9e9e9e',
  number: '#af5f00',
  bangMode: '#d7005f',
};

export const theme = { ...DARK, mode: 'dark' };

// Windows terminals draw ⏺ as a wide emoji, so use the plain circle there (as Claude Code does).
export const BULLET = process.platform === 'win32' ? '●' : '⏺';

// The accents Settings cycles through; any "#hex" in config.json works too. Blue is Glim's, the
// default. `light` is the same colour as it reads on a light background.
export const ACCENTS = [
  { name: 'blue', color: '#5fafff', light: '#005fd7' },
  { name: 'teal', color: '#5fd7d7', light: '#008787' },
  { name: 'green', color: '#5fd787', light: '#00875f' },
  { name: 'amber', color: '#ffaf5f', light: '#af5f00' },
  { name: 'pink', color: '#ff87d7', light: '#d7005f' },
  { name: 'violet', color: '#af87ff', light: '#5f00d7' },
];

export const THEMES = ['dark', 'light', 'auto'];

/**
 * The terminal's background from COLORFGBG ("15;0", "0;default;15"), which some terminals set: the
 * last number is the background's colour; 7 and 15 (white, bright white) are light. null when it
 * says nothing.
 */
export function backgroundFrom(colorfgbg) {
  const bg = String(colorfgbg ?? '').split(';').at(-1).trim();
  if (!/^\d+$/.test(bg)) return null;
  return bg === '7' || bg === '15' ? 'light' : 'dark';
}

/** The palette a setting asks for: dark, light, or with auto (or none) what COLORFGBG says, else dark. */
export function themeMode(setting, env = process.env) {
  if (setting === 'dark' || setting === 'light') return setting;
  return backgroundFrom(env.COLORFGBG) ?? 'dark';
}

/** Sets the accent: a preset as it reads on this theme's background, or any colour as given. */
export function setAccent(color) {
  if (typeof color !== 'string' || !color) return void (theme.accent = (theme.mode === 'light' ? LIGHT : DARK).accent);
  const preset = ACCENTS.find((a) => a.color.toLowerCase() === color.toLowerCase());
  theme.accent = preset && theme.mode === 'light' ? preset.light : color;
}

/** Puts the config's theme (dark, light, auto) and accent in place. */
export function applyTheme(config = {}, env = process.env) {
  const mode = themeMode(config.theme, env);
  Object.assign(theme, mode === 'light' ? LIGHT : DARK, { mode });
  setAccent(config.accent);
  return mode;
}
