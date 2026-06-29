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

  // Signing certificate: prefer KeyDescriptor use="signing", else first.
  const kds = toArray<any>(idp.KeyDescriptor);
  const signing = kds.find((k) => (k['@_use'] ?? 'signing') === 'signing') ?? kds[0];
  let certNode = signing?.KeyInfo?.X509Data?.X509Certificate;
  if (Array.isArray(certNode)) certNode = certNode[0];
  const idpCert = cleanCert(text(certNode));
  if (!idpCert) throw new Error('No signing certificate found in metadata.');

  // SSO redirect endpoint.
  const sso = toArray<any>(idp.SingleSignOnService);
  const redirect =
    sso.find((s) => String(s['@_Binding'] ?? '').endsWith('HTTP-Redirect')) ?? sso[0];
  const entryPoint = String(redirect?.['@_Location'] ?? '');
  if (!entryPoint) throw new Error('No SingleSignOnService (SSO URL) found in metadata.');

  return { entityId, entryPoint, idpCert };
}
