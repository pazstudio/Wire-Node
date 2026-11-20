/**
 * Light / dark theme. "auto" follows the operating system. The choice is kept per browser and
 * applied as data-theme on <html>, which styles.css uses.
 */
export type ThemeChoice = 'auto' | 'light' | 'dark';
const KEY = 'wn:theme';

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {
    /* storage blocked */
  }
  return 'auto';
}

const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;

export function applyTheme(choice: ThemeChoice = readTheme()) {
  const dark = choice === 'dark' || (choice === 'auto' && !!media?.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function setTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* storage blocked: applies until reload */
  }
  applyTheme(choice);
}

media?.addEventListener?.('change', () => applyTheme());
