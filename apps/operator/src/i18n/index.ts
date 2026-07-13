import { createI18n } from 'vue-i18n';
import { DEFAULT_LOCALE, resolveLocale, type LocaleCode } from '@kravn/contracts';
import en from './locales/en';
import esAR from './locales/es-AR';
import frFR from './locales/fr-FR';
import ptPT from './locales/pt-PT';

const STORAGE_KEY = 'kravn-locale'; // shared key name with the client (same origin per app, separate storage)

export function userLocaleOverride(): LocaleCode | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? resolveLocale(raw) : null;
}

function initialLocale(): LocaleCode {
  return userLocaleOverride() ?? resolveLocale(navigator.language, DEFAULT_LOCALE);
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages: { en, 'es-AR': esAR, 'fr-FR': frFR, 'pt-PT': ptPT },
});

export function setLocale(code: LocaleCode, persist = true): void {
  const locale = resolveLocale(code);
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  if (persist) localStorage.setItem(STORAGE_KEY, locale);
}

/** Apply the instance-default locale from bootstrap without overriding the user's explicit choice. */
export function applyInstanceLocale(code: string | null | undefined): void {
  if (userLocaleOverride()) return;
  setLocale(resolveLocale(code), false);
}
