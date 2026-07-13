import { sanitizeCssOverride, type BootstrapInfo } from '@kravn/contracts';

/**
 * Apply white-label branding to the running client: document title, a primary-colour CSS var, an optional
 * raw CSS override, and the favicon. Called whenever the (public) bootstrap info changes.
 *
 * The primary colour is a validated hex value (safe as a CSS var). The CSS override is operator-supplied and
 * only ever applied here, on the CLIENT chat surface — never on the OAuth approval screen, where hiding the
 * Approve/Deny controls would be a real risk. It is still sanitised of any `</style` breakout.
 */
export function applyBranding(info: BootstrapInfo | null): void {
  const b = info?.branding;
  document.title = b?.brandName || info?.instanceName || 'Kravn';

  let style = document.getElementById('kravn-branding') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'kravn-branding';
    document.head.appendChild(style);
  }
  const parts: string[] = [];
  if (b?.primaryColor) parts.push(`:root{--accent:${b.primaryColor};}`);
  if (b?.cssOverride) parts.push(sanitizeCssOverride(b.cssOverride));
  // Attribution guard — appended AFTER the override (later + higher specificity wins) so a CSS override
  // can't strip the "Powered by Kravn" mark. Covers the common hiding vectors; note that a determined
  // operator writing adversarial CSS can still find edge cases — raw CSS is an admin-only capability.
  parts.push(
    '[data-kravn-attribution][data-kravn-attribution]{' +
      'display:inline-flex!important;visibility:visible!important;opacity:1!important;' +
      'height:auto!important;max-height:none!important;width:auto!important;max-width:none!important;' +
      'min-height:0!important;min-width:0!important;position:static!important;inset:auto!important;' +
      'transform:none!important;scale:none!important;translate:none!important;rotate:none!important;' +
      'clip:auto!important;clip-path:none!important;filter:none!important;-webkit-filter:none!important;' +
      'margin:0!important;padding:0!important;font-size:11px!important;line-height:1!important;' +
      'overflow:visible!important;transition:none!important;animation:none!important;' +
      'text-indent:0!important;pointer-events:auto!important;content-visibility:visible!important;}',
  );
  style.textContent = parts.join('\n');

  if (b?.logoDataUri) {
    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = b.logoDataUri;
  }
}
