import { signal } from '@angular/core';
import { EN } from './i18n.en';
import { SERVER_EN, SERVER_EN_PATTERNS } from './i18n.server.en';

/**
 * UI language. German is the source language: every text is written in German in the code and is its own key
 * (`t('Übersicht')`); the English translations live in i18n.en.ts. Texts that come from the backend (analysis,
 * rules.json, error messages) stay German in the data files and are translated for display by `serverText`
 * (i18n.server.en.ts), so ids, line keys and the files agents read do not depend on the language.
 *
 * `lang` is a signal: templates and computeds that call `t` re-render when the language is switched.
 */
export type Lang = 'de' | 'en';

const STORAGE_KEY = 'scr.lang';

export const lang = signal<Lang>(readLang());

export function setLang(value: Lang): void {
  lang.set(value);
  applyLang(value);
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // storage unavailable - the language is just not remembered
  }
}

/** Sets <html lang>, once at start and on every switch. */
export function applyLang(value: Lang = lang()): void {
  if (typeof document !== 'undefined') document.documentElement.lang = value;
}

/**
 * A UI text in the current language. `de` is the German text and the key of its translation; `{name}` placeholders
 * are filled from `params` (also in German). Missing translations fall back to German.
 */
export function t(de: string, params?: Record<string, string | number | null | undefined>): string {
  const text = lang() === 'en' ? EN[de] ?? de : de;
  return params ? fill(text, params) : text;
}

/**
 * A German text from the backend in the current language: exact matches first (rules texts, fixed messages), then
 * the patterns of composed messages. Unknown texts - e.g. of an own rules.json - are shown as they are.
 */
export function serverText(text: string | null | undefined): string {
  if (text == null) return '';
  if (lang() !== 'en' || !text) return text;
  return translateServerText(text);
}

/** Like serverText, but always into English (for tests and for the parts of composed messages). */
export function translateServerText(text: string): string {
  const exact = SERVER_EN[text];
  if (exact !== undefined) return exact;
  for (const [pattern, replace] of SERVER_EN_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return replace(m, translateServerText);
  }
  return text;
}

/** Locale for dates and numbers. */
export function locale(): string {
  return lang() === 'en' ? 'en-GB' : 'de-CH';
}

function fill(text: string, params: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name] ?? '') : all));
}

function readLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'de' || stored === 'en') return stored;
  } catch {
    // storage unavailable
  }
  return 'de';
}
