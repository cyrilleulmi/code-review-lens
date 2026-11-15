import { signal } from '@angular/core';

/**
 * Colour theme: IntelliJ New UI dark (default) or light. The colours are tokens in styles.scss; light overrides them
 * under html[data-theme='light']. The choice is kept per browser; index.html applies it before the first paint.
 */
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'scr.theme';

export const theme = signal<Theme>(readTheme());

export function setTheme(value: Theme): void {
  theme.set(value);
  applyTheme(value);
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // storage unavailable - the theme is just not remembered
  }
}

export function toggleTheme(): void {
  setTheme(theme() === 'dark' ? 'light' : 'dark');
}

/** Sets <html data-theme>, once at start and on every switch. */
export function applyTheme(value: Theme = theme()): void {
  if (typeof document === 'undefined') return;
  if (value === 'light') {
    document.documentElement.dataset['theme'] = 'light';
  } else {
    delete document.documentElement.dataset['theme'];
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
