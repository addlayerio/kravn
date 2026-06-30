import { XMLParser } from 'fast-xml-parser';
import type { SamlMetadataResult } from '@kravn/contracts';

/**
 * Parse a SAML 2.0 IdP metadata document (e.g. Azure/Entra federation metadata XML) and extract
 * what Kravn needs: the SSO redirect URL (entryPoint), the signing certificate, and the IdP entityID.
 *
 * `removeNSPrefix` normalizes prefixed elements (md:/ds:/saml:) so prefix variance doesn't matter.
 */
function toArray<T>(x: T | T[] | undefined | null): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function text(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)['#text'] ?? '');
  }
  return String(node);
}

/** Strip PEM armor + whitespace, leaving a single base64 line (accepted by @node-saml). */
function cleanCert(raw: string): string {
  return raw
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Normalize one-or-more pasted/imported signing certificates into Kravn's stored form: each cert as a
 * single base64 line, multiple certs joined by newlines. Accepts multiple PEM blocks or a bare base64
 * blob. IdPs like Entra publish SEVERAL signing certs (key rollover); keeping all of them is what lets
 * a response validate regardless of which key the IdP signed with.
 */
export function normalizeCerts(raw: string): string {
  const pem = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  const certs = pem ? pem.map(cleanCert) : raw.split('\n').map(cleanCert);
  return [...new Set(certs.filter(Boolean))].join('\n');
}

export function parseSamlMetadata(xml: string): SamlMetadataResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseAttributeValue: false,
    trimValues: true,
  });

  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error('Document is not valid XML.');
  }

  let ed = doc?.EntityDescriptor;
  if (!ed && doc?.EntitiesDescriptor) {
    const eds = toArray(doc.EntitiesDescriptor.EntityDescriptor);
    ed = eds.find((e: any) => e?.IDPSSODescriptor) ?? eds[0];
  }
  if (!ed) throw new Error('No EntityDescriptor found — is this SAML metadata?');

  const entityId = String(ed['@_entityID'] ?? '');
  const idp = Array.isArray(ed.IDPSSODescriptor) ? ed.IDPSSODescriptor[0] : ed.IDPSSODescriptor;
  if (!idp) throw new Error('No IDPSSODescriptor — this is not Identity Provider metadata.');

  // Signing certificates: collect EVERY KeyDescriptor use="signing" (IdPs publish several for key
  // rollover) and every X509Certificate within each, so validation works whichever key signed the response.
  const kds = toArray<any>(idp.KeyDescriptor);
  const signingKds = kds.filter((k) => (k['@_use'] ?? 'signing') === 'signing');
  const certs = (signingKds.length ? signingKds : kds)
    .flatMap((k) => toArray<unknown>(k?.KeyInfo?.X509Data?.X509Certificate))
    .map((n) => cleanCert(text(n)))
    .filter(Boolean);
  const idpCert = [...new Set(certs)].join('\n');
  if (!idpCert) throw new Error('No signing certificate found in metadata.');

  // SSO redirect endpoint.
  const sso = toArray<any>(idp.SingleSignOnService);
  const redirect =
    sso.find((s) => String(s['@_Binding'] ?? '').endsWith('HTTP-Redirect')) ?? sso[0];
  const entryPoint = String(redirect?.['@_Location'] ?? '');
  if (!entryPoint) throw new Error('No SingleSignOnService (SSO URL) found in metadata.');

  return { entityId, entryPoint, idpCert };
}
