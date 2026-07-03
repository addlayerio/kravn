/**
 * Shared HTML → Markdown / text utilities.
 *
 * Used both by the native HOOK plugins (`plugins/native-hooks.ts` — HTML→Markdown and SafeHTML, running on
 * untrusted upstream content) and by the document extractor (`chat/extract.ts` — DOCX is rendered to HTML by
 * mammoth, then reduced to structured Markdown here). Keeping it in one place means the same, reviewed
 * conversion (and the same ReDoS guards) back every consumer.
 *
 * Safety: the scans are lazy/greedy and only quadratic in the worst case, so callers process at most
 * MAX_HTML_BYTES of input, and tag strips use `[^<>]` (not `[^>]`) so a run of unclosed `<` stays linear.
 */

/** Callers skip (pass through) content larger than this, to bound worst-case regex cost. */
export const MAX_HTML_BYTES = 128 * 1024;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

/** A valid Unicode scalar value (not a surrogate, within range) — else keep the literal (avoids RangeError). */
function codePoint(n: number, literal: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : literal;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] || m)
    .replace(/&#(\d{1,7});/g, (m, d) => codePoint(Number(d), m))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (m, h) => codePoint(parseInt(h, 16), m));
}

/** Neutralise any `<` that begins a tag-like sequence so entity-decoded markup can't reconstruct live tags. */
export const neutralizeTags = (s: string): string => s.replace(/<(?=[a-zA-Z/!?])/g, '&lt;');

export const looksHtml = (s: string): boolean => /<\/?[a-z][\s\S]{0,200}?>/i.test(s);

/**
 * Sanitise an image src for Markdown output: drop `data:` URIs and absurdly long URLs. An inline `data:`
 * image (base64) is a token bomb and can smuggle a large opaque payload into the model prompt — worthless
 * to the model and the opposite of the token reduction this conversion exists for. Emits `![alt]()` instead.
 */
/** Decode HTML entities repeatedly until stable, so no multi-encoded entity (e.g. `&amp;#124;`) survives. */
function decodeFixpoint(s: string): string {
  let prev = s;
  for (let i = 0; i < 5; i++) {
    const next = decodeEntities(prev);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

const imgSrc = (src: string): string => {
  // Test the FULLY-decoded scheme/length: an entity-encoded `&#100;ata:` (or `&amp;…`) would otherwise slip
  // past a raw-string check and be resolved to `data:` by the pipeline's later decode pass.
  const d = decodeFixpoint(src);
  return /^\s*(?:data|javascript|vbscript):/i.test(d) || d.length > 2048 ? '' : src;
};

/**
 * Flatten one table cell to safe, single-line Markdown text: strip inner tags, fully decode entities,
 * neutralise any revealed tag-start, collapse whitespace (killing injected newlines) and escape `|`.
 * Because rendered tables are stashed behind a placeholder until AFTER the pipeline's final decode pass
 * (see htmlToMarkdown), this escaping is FINAL — a later `decodeEntities` can no longer resurrect a `|`,
 * a newline or a live tag from a multi-encoded entity, so cell content cannot break out of the table.
 */
function cellText(cell: string): string {
  return neutralizeTags(decodeFixpoint(cell.replace(/<[^<>]+>/g, ' ')))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
}

/** Render one `<table>` body to a GitHub-flavoured Markdown table (cells already fully escaped). */
function renderTable(inner: string): string {
  const rows: string[][] = [];
  inner.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_r, rowHtml: string) => {
    const cells: string[] = [];
    rowHtml.replace(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_c: string, _tag: string, cell: string) => {
      cells.push(cellText(cell));
      return '';
    });
    if (cells.length) rows.push(cells);
    return '';
  });
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push('');
  const line = (c: string[]): string => '| ' + c.join(' | ') + ' |';
  const sep = '| ' + Array(width).fill('---').join(' | ') + ' |';
  return [line(rows[0]), sep, ...rows.slice(1).map(line)].join('\n');
}

/**
 * Reduce HTML to Markdown — cleaner and far fewer tokens than raw HTML. Handles tables, headings, links,
 * images, lists, bold/italic, code, blockquotes; strips the rest. Content over MAX_HTML_BYTES is returned
 * unchanged (too large to process within the worst-case cost budget).
 */
export function htmlToMarkdown(html: string): string {
  if (html.length > MAX_HTML_BYTES) return html; // too large to process safely — pass through
  let s = html.replace(/\x00/g, ''); // drop NULs so upstream content can't forge a table placeholder
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  // Render tables to final Markdown NOW and stash them behind a NUL-delimited placeholder that survives the
  // rest of the pipeline (incl. the final decodeEntities), so cell escaping can never be undone downstream.
  const tables: string[] = [];
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner: string) => {
    const md = renderTable(inner);
    if (!md) return '';
    tables.push(md);
    return '\n\n\x00T' + (tables.length - 1) + '\x00\n\n';
  });
  s = s.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, h, t) => '\n' + '#'.repeat(Number(h[1])) + ' ' + t.trim() + '\n');
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => '**' + t.trim() + '**');
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => '*' + t.trim() + '*');
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => '[' + t.trim() + '](' + href + ')');
  s = s.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*>/gi, (_, alt, src) => '![' + alt + '](' + imgSrc(src) + ')');
  s = s.replace(/<img\b[^>]*src=["']([^"']*)["'][^>]*>/gi, (_, src) => '![](' + imgSrc(src) + ')');
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => '- ' + t.trim() + '\n');
  s = s.replace(/<\/(ul|ol)>/gi, '\n');
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => '\n```\n' + t.replace(/<[^<>]+>/g, '').trim() + '\n```\n');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => '`' + t.replace(/<[^<>]+>/g, '') + '`');
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => '\n> ' + t.replace(/<[^<>]+>/g, '').trim() + '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n').replace(/<p\b[^>]*>/gi, '');
  s = s.replace(/<[^<>]+>/g, ''); // strip any remaining tags
  s = s.replace(/!\[\]\(\)/g, ''); // drop empty images (e.g. an image whose src we dropped)
  s = neutralizeTags(decodeEntities(s)); // decode entities, then neutralise any markup they revealed
  s = s.replace(/\x00T(\d+)\x00/g, (_m, i) => tables[Number(i)] ?? ''); // restore tables AFTER the decode pass
  return s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}
