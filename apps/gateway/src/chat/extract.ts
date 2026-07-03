import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import type { ChatAttachmentKind } from '@kravn/contracts';
import { htmlToMarkdown, MAX_HTML_BYTES } from '../lib/html.js';

/** Cap extracted text so a huge file can't blow up the prompt / DB row. */
const MAX_CHARS = 200_000;

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'xml', 'html', 'htm',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'rb', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'sql', 'ini', 'toml', 'env',
]);

export interface Extracted {
  kind: ChatAttachmentKind;
  text: string;
}

// Strip NUL bytes (e.g. from UTF-16 files force-decoded as UTF-8): PostgreSQL text columns reject 0x00,
// and a NUL in the prompt is meaningless to the model.
const NUL = new RegExp(String.fromCharCode(0), 'g');

function cap(text: string): string {
  const clean = text.replace(NUL, '');
  if (clean.length <= MAX_CHARS) return clean;
  return clean.slice(0, MAX_CHARS) + `\n\n[…truncated — file exceeded ${MAX_CHARS.toLocaleString()} characters]`;
}

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Extract plain text from an uploaded file for injection into the model context. */
export async function extractText(name: string, mime: string, buf: Buffer): Promise<Extracted> {
  const e = ext(name);
  const m = (mime || '').toLowerCase();

  // PDF
  if (m === 'application/pdf' || e === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const out = await pdfExtractText(pdf, { mergePages: true });
    const raw = out.text as unknown;
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('\n') : '';
    return { kind: 'pdf', text: cap(text) };
  }

  // Word (.docx) → render to HTML, then reduce to structured Markdown (keeps headings, lists, bold and
  // — the real win over raw text — tables). Far fewer tokens than the source XML and more legible to the
  // model than flat text. Very large docs (HTML over the processing cap) fall back to plain-text extraction.
  if (e === 'docx' || m.includes('officedocument.wordprocessingml')) {
    // Drop images: mammoth would otherwise inline each as a base64 data: URI, exploding tokens for content
    // the model can't use anyway. An empty src yields <img src=""> that htmlToMarkdown collapses to nothing.
    const { value: html } = await mammoth.convertToHtml({ buffer: buf }, { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) });
    if (html.length > MAX_HTML_BYTES) {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return { kind: 'document', text: cap(value) };
    }
    return { kind: 'document', text: cap(htmlToMarkdown(html)) };
  }

  // Spreadsheets (.xlsx/.xls/.csv) → one CSV block per sheet
  if (e === 'xlsx' || e === 'xls' || e === 'csv' || e === 'tsv' || m.includes('spreadsheetml') || m === 'application/vnd.ms-excel' || m === 'text/csv') {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const parts = wb.SheetNames.map((n) => `# Sheet: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`);
    return { kind: 'spreadsheet', text: cap(parts.join('\n\n')) };
  }

  // Plain text / code / structured text
  if (m.startsWith('text/') || m === 'application/json' || TEXT_EXTS.has(e)) {
    return { kind: 'text', text: cap(buf.toString('utf8')) };
  }

  // Unknown: best-effort utf-8, but bail if it looks binary (a NUL byte ⇒ not text).
  if (buf.includes(0)) return { kind: 'other', text: '' };
  return { kind: 'other', text: cap(buf.toString('utf8')) };
}
