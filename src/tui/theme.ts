export type ThemeName = 'forest' | 'light' | 'contrast';
export interface TuiTheme {
  background: string; surface: string; raised: string; text: string; muted: string;
  border: string; accent: string; green: string; warning: string; error: string;
}
export const THEMES: Record<ThemeName, TuiTheme> = {
  forest: { background: '#101810', surface: '#152219', raised: '#254831', text: '#e1efe4', muted: '#a1b9a8', border: '#355642', accent: '#80ee64', green: '#00eb81', warning: '#f0c77a', error: '#ff9d9d' },
  light: { background: '#f1f6ef', surface: '#ffffff', raised: '#d8ebd4', text: '#17291c', muted: '#4a6650', border: '#89a38b', accent: '#256d20', green: '#007a43', warning: '#81570d', error: '#ad302c' },
  contrast: { background: '#000000', surface: '#080d09', raised: '#183d23', text: '#ffffff', muted: '#d5e9d9', border: '#9fcfac', accent: '#a2ff75', green: '#00ff8c', warning: '#ffdf80', error: '#ffa4a4' },
};

export function isTheme(value: string): value is ThemeName { return Object.hasOwn(THEMES, value); }

export function tokens(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return String(Math.max(0, Math.round(value)));
}

/** Rank ordered subsequences; exact/prefix matches win without expensive edit distance. */
export function fuzzyScore(query: string, value: string): number {
  const needle = query.toLocaleLowerCase().trim(); const haystack = value.toLocaleLowerCase();
  if (!needle) return 1;
  if (haystack.startsWith(needle)) return 10_000 - value.length;
  const contiguous = haystack.indexOf(needle);
  if (contiguous >= 0) return 5_000 - contiguous;
  let at = 0; let score = 0; let previous = -2;
  for (const char of needle) {
    const index = haystack.indexOf(char, at);
    if (index < 0) return -1;
    score += index === previous + 1 ? 20 : 1;
    if (index === 0 || /[\s/_.-]/.test(haystack[index - 1]!)) score += 10;
    previous = index; at = index + 1;
  }
  return score - value.length / 1_000;
}
