import { createI18n } from 'vue-i18n';
import { DEFAULT_LOCALE, resolveLocale, type LocaleCode } from '@kravn/contracts';
import en from './locales/en';
import esAR from './locales/es-AR';
import frFR from './locales/fr-FR';
import ptPT from './locales/pt-PT';

const STORAGE_KEY = 'kravn-locale';

/** The user's explicit per-session choice, if any (persisted). Overrides the instance default. */
export function userLocaleOverride(): LocaleCode | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return resolveLocale(raw);
}

/** Initial locale at boot: user override → browser language → English. The instance default (from the
 *  public bootstrap) is applied once it loads, in App.vue, unless the user has an override. */
function initialLocale(): LocaleCode {
  return userLocaleOverride() ?? resolveLocale(navigator.language, DEFAULT_LOCALE);
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages: { en, 'es-AR': esAR, 'fr-FR': frFR, 'pt-PT': ptPT },
});

export function currentLocale(): LocaleCode {
  return i18n.global.locale.value as LocaleCode;
}

/**
 * Switch the active locale. `persist` (default true) records it as the user's explicit choice so it wins
 * over the instance default; the App-level bootstrap sync passes persist=false so it only sets the default.
 */
export function setLocale(code: LocaleCode, persist = true): void {
  const locale = resolveLocale(code);
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  if (persist) localStorage.setItem(STORAGE_KEY, locale);
}

/** Apply the instance-default locale from bootstrap — but never override the user's explicit choice. */
export function applyInstanceLocale(code: string | null | undefined): void {
  if (userLocaleOverride()) return;
  setLocale(resolveLocale(code), false);
}
