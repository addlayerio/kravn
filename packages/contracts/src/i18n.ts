/**
 * Supported locales — the single source of truth for the whole platform. Everything keys off the ISO
 * code `language-REGION` (e.g. `es-AR`), so adding a regional variant later (e.g. `es-UY`, whose wording
 * differs from `es-AR`/`es-ES`) is: add its code here + a message file per app. Nothing else changes.
 */
export const LOCALE_CODES = ['en', 'es-AR', 'fr-FR', 'pt-PT'] as const;
export type LocaleCode = (typeof LOCALE_CODES)[number];

/** Human labels shown in the language picker. TS enforces one per code. */
const LOCALE_NAMES: Record<LocaleCode, string> = {
  en: 'English',
  'es-AR': 'Español (Argentina)',
  'fr-FR': 'Français (France)',
  'pt-PT': 'Português (Portugal)',
};

export interface AvailableLocale {
  code: LocaleCode;
  name: string;
}

export const AVAILABLE_LOCALES: AvailableLocale[] = LOCALE_CODES.map((code) => ({ code, name: LOCALE_NAMES[code] }));

export const DEFAULT_LOCALE: LocaleCode = 'en';

/**
 * Resolve any string (a stored preference, a browser `navigator.language`, a settings value) to a supported
 * locale: exact match first, then by language prefix (`es-UY` → the first `es-*` we ship), else the fallback.
 */
export function resolveLocale(value: string | null | undefined, fallback: LocaleCode = DEFAULT_LOCALE): LocaleCode {
  if (!value) return fallback;
  const exact = LOCALE_CODES.find((c) => c === value);
  if (exact) return exact;
  const lang = value.toLowerCase().split('-')[0];
  const byLang = LOCALE_CODES.find((c) => c.toLowerCase().split('-')[0] === lang);
  return byLang ?? fallback;
}
