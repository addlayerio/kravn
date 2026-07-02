import type { HookPlugin } from '@kravn/plugin-sdk';

/**
 * Built-in HOOK plugins shipped with Kravn (disabled by default).
 *
 * These are content-processing interceptors — they transform (or block) what flows through the MCP
 * pipeline rather than providing tools. They run in-code (like the native mcp-server plugins) so they can
 * be shared logic and are always available / re-seeded, but they're plain hook plugins: they appear on the
 * Plugins screen and are composed per junction (and per virtual server) on the Pipelines screen. Off by
 * default — an operator enables and orders the ones they want.
 *
 * They are dependency-free and operate on the MCP result/args shape by walking string leaves. The secret /
 * safety / deny regexes are linear (bounded quantifiers, single-class runs). The HTML plugins use lazy /
 * greedy scans that are only quadratic in the worst case, so they cap the input they process (MAX_HTML_BYTES)
 * and use `[^<>]` (not `[^>]`) in tag strips to keep a run of unclosed `<` linear — both bound the cost on
 * adversarial upstream content. Operator-supplied regexes (extraPatterns / deny patterns) run on that same
 * untrusted content with no engine timeout, so a catastrophic operator pattern is the one exponential risk —
 * flagged in their config titles.
 */

type Json = unknown;

/** HTML plugins skip (pass through) content larger than this, to bound worst-case regex cost. */
const MAX_HTML_BYTES = 128 * 1024;

/** Deep-map every string leaf of a value (arrays + plain objects recursed; other types passed through). */
function mapStrings(v: Json, fn: (s: string) => string): Json {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) o[k] = mapStrings(o[k], fn);
    return o;
  }
  return v;
}

/** True if any string leaf satisfies the predicate. */
function anyString(v: Json, test: (s: string) => boolean): boolean {
  if (typeof v === 'string') return test(v);
  if (Array.isArray(v)) return v.some((x) => anyString(x, test));
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some((x) => anyString(x, test));
  return false;
}

const str = (c: Record<string, unknown>, k: string, d: string): string => (typeof c[k] === 'string' && c[k] ? (c[k] as string) : d);
const bool = (c: Record<string, unknown>, k: string): boolean => c[k] === true;
const arr = (c: Record<string, unknown>, k: string): string[] => (Array.isArray(c[k]) ? (c[k] as unknown[]).filter((x) => typeof x === 'string') as string[] : []);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── 1. Secrets Redactor ────────────────────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]{1,4000}?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g, // PEM private keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // AWS temporary key id
  /\bgh[posru]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,72}\b/g, // Slack tokens
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g, // Google OAuth token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, // bearer tokens
  /\bhttps?:\/\/[^\s:@/]{1,64}:[^\s@/]{1,64}@/g, // credentials in a URL
];

// Long, mixed-charset base64/hex tokens (opt-in — noisier). Entropy-checked below.
const HIGH_ENTROPY_RE = /\b[A-Za-z0-9+/=_-]{32,80}\b/g;
function shannon(s: string): number {
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  let h = 0;
  for (const k of Object.keys(freq)) {
    const p = freq[k] / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function secretsRedactor(): HookPlugin {
  const redact = (config: Record<string, unknown>) => (s: string): string => {
    const placeholder = str(config, 'placeholder', '[REDACTED_SECRET]');
    let out = s;
    for (const re of SECRET_PATTERNS) out = out.replace(re, placeholder);
    for (const p of arr(config, 'extraPatterns')) {
      try {
        out = out.replace(new RegExp(p, 'g'), placeholder);
      } catch {
        /* ignore a bad operator regex */
      }
    }
    // A whole-string base64/hex blob or data: URI is binary/data, not embedded secrets — don't shred it.
    const isBlob = /^data:[^,]{0,200},/.test(s) || /^[A-Za-z0-9+/=_-]{200,}$/.test(s.trim());
    if (bool(config, 'detectHighEntropy') && !isBlob) {
      out = out.replace(HIGH_ENTROPY_RE, (m) => (/[A-Za-z]/.test(m) && /[0-9]/.test(m) && shannon(m) >= 3.5 ? placeholder : m));
    }
    return out;
  };
  const apply = (ctx: any) => {
    ctx.result = mapStrings(ctx.result, redact(ctx.config || {}));
  };
  return {
    manifest: {
      id: 'secrets-redactor',
      name: 'Secrets Redactor',
      version: '0.1.0',
      type: 'hook',
      description:
        'Detects secrets (private keys, AWS/GitHub/Slack/Stripe/Google keys, JWTs, bearer tokens, credentials in URLs) in tool/resource/prompt results and replaces them so they never reach the model.',
      author: 'Kravn',
      priority: 10,
      configSchema: {
        type: 'object',
        properties: {
          placeholder: { type: 'string', title: 'Replacement text', default: '[REDACTED_SECRET]' },
          detectHighEntropy: { type: 'boolean', title: 'Also flag long high-entropy strings (may increase false positives)' },
          extraPatterns: { type: 'array', items: { type: 'string' }, title: 'Extra regex patterns to redact (run on untrusted content — avoid catastrophic backtracking)' },
        },
      },
    },
    hooks: { onToolResult: apply, onResourceResult: apply, onPromptResult: apply },
  };
}

// ─── 2. Content Safety Filter (self-harm / violence / hate) ───────────────────────────────────────

const SAFETY_DEFAULTS: Record<string, string[]> = {
  selfHarm: ['suicide', 'kill myself', 'self-harm', 'self harm', 'end my life', 'cut myself'],
  violence: ['kill you', 'shoot up', 'make a bomb', 'build a bomb', 'mass shooting', 'behead'],
  hate: ['ethnic cleansing', 'genocide', 'racial slur'],
};
const CATEGORIES = ['selfHarm', 'violence', 'hate'] as const;

function contentSafety(): HookPlugin {
  const termsFor = (config: Record<string, unknown>, cat: string): string[] => {
    const custom = arr(config, cat + 'Terms');
    return custom.length ? custom : SAFETY_DEFAULTS[cat] || [];
  };
  const matcher = (config: Record<string, unknown>) => {
    const res: Array<{ cat: string; re: RegExp }> = [];
    for (const cat of CATEGORIES) {
      const terms = termsFor(config, cat).map(escapeRe).filter(Boolean);
      if (terms.length) res.push({ cat, re: new RegExp('\\b(?:' + terms.join('|') + ')\\b', 'gi') });
    }
    return res;
  };
  const flaggedCats = (config: Record<string, unknown>, s: string): string[] =>
    matcher(config).filter((m) => m.re.test(s)).map((m) => m.cat);

  const applyPost = (ctx: any) => {
    const config = ctx.config || {};
    const action = str(config, 'action', 'redact');
    const placeholder = str(config, 'placeholder', '[REMOVED: unsafe content]');
    const ms = matcher(config);
    ctx.result = mapStrings(ctx.result, (s) => {
      let out = s;
      let hit = false;
      for (const m of ms) {
        m.re.lastIndex = 0;
        if (m.re.test(out)) {
          hit = true;
          if (action === 'redact') out = out.replace(m.re, placeholder);
        }
      }
      if (hit && action === 'annotate') out = out + '\n\n[content-safety] flagged: ' + [...new Set(ms.filter((m) => (m.re.lastIndex = 0, m.re.test(s))).map((m) => m.cat))].join(', ');
      return out;
    });
  };
  return {
    manifest: {
      id: 'content-safety',
      name: 'Content Safety Filter',
      version: '0.1.0',
      type: 'hook',
      description:
        'Flags self-harm, violence and hate content in results and, per config, redacts or annotates it — and can block a tool CALL whose arguments contain such content. Lexicon-based (fully configurable); for production-grade moderation pair it with a classifier/LLM moderation endpoint.',
      author: 'Kravn',
      priority: 20,
      configSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['redact', 'annotate'], title: 'Action on results', default: 'redact' },
          placeholder: { type: 'string', title: 'Redaction text', default: '[REMOVED: unsafe content]' },
          blockRequests: { type: 'boolean', title: 'Block a tool call whose arguments are flagged' },
          selfHarmTerms: { type: 'array', items: { type: 'string' }, title: 'Self-harm terms (overrides defaults)' },
          violenceTerms: { type: 'array', items: { type: 'string' }, title: 'Violence terms (overrides defaults)' },
          hateTerms: { type: 'array', items: { type: 'string' }, title: 'Hate terms (overrides defaults)' },
        },
      },
    },
    hooks: {
      onToolCall: (ctx: any) => {
        if (!bool(ctx.config || {}, 'blockRequests')) return;
        const cats = new Set<string>();
        anyString(ctx.arguments, (s) => (flaggedCats(ctx.config || {}, s).forEach((c) => cats.add(c)), false));
        if (cats.size) ctx.deny('Request blocked by content safety (' + [...cats].join(', ') + ').');
      },
      onToolResult: applyPost,
      onResourceResult: applyPost,
      onPromptResult: applyPost,
    },
  };
}

// ─── 3. Deny List Filter ──────────────────────────────────────────────────────────────────────────

function compilePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(p);
    try {
      out.push(m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : new RegExp(escapeRe(p), 'gi'));
    } catch {
      out.push(new RegExp(escapeRe(p), 'gi'));
    }
  }
  return out;
}

function denyListFilter(): HookPlugin {
  const matchesAny = (res: RegExp[], s: string): boolean => res.some((re) => ((re.lastIndex = 0), re.test(s)));
  const pre = (ctx: any) => {
    const config = ctx.config || {};
    if (bool(config, 'skipRequests')) return;
    const res = compilePatterns(arr(config, 'patterns'));
    if (!res.length) return;
    const target = ctx.arguments !== undefined ? ctx.arguments : ctx.uri;
    if (anyString(target, (s) => matchesAny(res, s))) {
      ctx.deny(str(config, 'denyMessage', 'Request blocked by deny-list policy.'));
    }
  };
  const post = (ctx: any) => {
    const config = ctx.config || {};
    if (bool(config, 'skipResults')) return;
    const res = compilePatterns(arr(config, 'patterns'));
    if (!res.length) return;
    const placeholder = str(config, 'placeholder', '[BLOCKED]');
    ctx.result = mapStrings(ctx.result, (s) => {
      let out = s;
      for (const re of res) {
        re.lastIndex = 0;
        out = out.replace(re, placeholder);
      }
      return out;
    });
  };
  return {
    manifest: {
      id: 'deny-list-filter',
      name: 'Deny List Filter',
      version: '0.1.0',
      type: 'hook',
      description:
        'Blocks requests and/or redacts results that match a configurable deny list. Each entry is a plain phrase (case-insensitive) or a /regex/flags. Blocks the call on the request side (deny) and replaces matches on the result side.',
      author: 'Kravn',
      priority: 15,
      configSchema: {
        type: 'object',
        properties: {
          patterns: { type: 'array', items: { type: 'string' }, title: 'Deny patterns (phrase or /regex/flags) — regexes run on untrusted content, avoid catastrophic backtracking' },
          placeholder: { type: 'string', title: 'Replacement for matches in results', default: '[BLOCKED]' },
          denyMessage: { type: 'string', title: 'Message when a request is blocked', default: 'Request blocked by deny-list policy.' },
          skipRequests: { type: 'boolean', title: 'Do not block requests (results only)' },
          skipResults: { type: 'boolean', title: 'Do not redact results (requests only)' },
        },
      },
    },
    hooks: { onToolCall: pre, onResourceRead: pre, onPromptGet: pre, onToolResult: post, onResourceResult: post, onPromptResult: post },
  };
}

// ─── 4. HTML → Markdown ──────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
/** A valid Unicode scalar value (not a surrogate, within range) — else keep the literal (avoids RangeError). */
function codePoint(n: number, literal: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : literal;
}
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] || m)
    .replace(/&#(\d{1,7});/g, (m, d) => codePoint(Number(d), m))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (m, h) => codePoint(parseInt(h, 16), m));
}
/** Neutralise any `<` that begins a tag-like sequence so entity-decoded markup can't reconstruct live tags. */
const neutralizeTags = (s: string): string => s.replace(/<(?=[a-zA-Z/!?])/g, '&lt;');
const looksHtml = (s: string): boolean => /<\/?[a-z][\s\S]{0,200}?>/i.test(s);

function htmlToMarkdown(html: string): string {
  if (html.length > MAX_HTML_BYTES) return html; // too large to process safely — pass through
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, h, t) => '\n' + '#'.repeat(Number(h[1])) + ' ' + t.trim() + '\n');
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => '**' + t.trim() + '**');
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => '*' + t.trim() + '*');
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => '[' + t.trim() + '](' + href + ')');
  s = s.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*>/gi, (_, alt, src) => '![' + alt + '](' + src + ')');
  s = s.replace(/<img\b[^>]*src=["']([^"']*)["'][^>]*>/gi, (_, src) => '![](' + src + ')');
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => '- ' + t.trim() + '\n');
  s = s.replace(/<\/(ul|ol)>/gi, '\n');
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => '\n```\n' + t.replace(/<[^<>]+>/g, '').trim() + '\n```\n');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => '`' + t.replace(/<[^<>]+>/g, '') + '`');
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => '\n> ' + t.replace(/<[^<>]+>/g, '').trim() + '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n').replace(/<p\b[^>]*>/gi, '');
  s = s.replace(/<[^<>]+>/g, ''); // strip any remaining tags
  s = neutralizeTags(decodeEntities(s)); // decode entities, then neutralise any markup they revealed
  return s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

function htmlToMarkdownPlugin(): HookPlugin {
  const apply = (ctx: any) => {
    ctx.result = mapStrings(ctx.result, (s) => (looksHtml(s) ? htmlToMarkdown(s) : s));
  };
  return {
    manifest: {
      id: 'html-to-markdown',
      name: 'HTML → Markdown',
      version: '0.1.0',
      type: 'hook',
      description:
        'Converts HTML content in resource/tool results to Markdown — cleaner and far fewer tokens for the model than raw HTML. Handles headings, links, images, lists, bold/italic, code, blockquotes; strips the rest.',
      author: 'Kravn',
      priority: 60,
      configSchema: { type: 'object', properties: {} },
    },
    hooks: { onResourceResult: apply, onToolResult: apply },
  };
}

// ─── 5. SafeHTML Sanitizer ────────────────────────────────────────────────────────────────────────

function sanitizeHtml(html: string, textOnly: boolean): string {
  if (html.length > MAX_HTML_BYTES) return textOnly ? neutralizeTags(html) : html; // too large to process safely
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|base|form)\b[^<>]*>/gi, '');
  if (textOnly) {
    return neutralizeTags(decodeEntities(s.replace(/<[^<>]+>/g, ' '))).replace(/\s{2,}/g, ' ').trim();
  }
  // Event handlers — the separator before on* can be whitespace OR '/' (e.g. <svg/onload=…>).
  s = s.replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, ' ');
  s = s.replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, ' ');
  s = s.replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, ' ');
  // Dangerous URL schemes in href/src — quoted (allowing leading spaces/entities) or unquoted.
  s = s.replace(/(href|src|xlink:href)\s*=\s*"(?:\s|&#\w+;)*(?:javascript|vbscript|data):[^"]*"/gi, '$1="#"');
  s = s.replace(/(href|src|xlink:href)\s*=\s*'(?:\s|&#\w+;)*(?:javascript|vbscript|data):[^']*'/gi, "$1='#'");
  s = s.replace(/(href|src|xlink:href)\s*=\s*(?:javascript|vbscript|data):[^\s>]*/gi, '$1="#"');
  s = s.replace(/\sstyle\s*=\s*("[^"]*expression[^"]*"|'[^']*expression[^']*')/gi, ''); // CSS expression()
  return s;
}

function safeHtmlPlugin(): HookPlugin {
  const apply = (ctx: any) => {
    const textOnly = bool(ctx.config || {}, 'textOnly');
    ctx.result = mapStrings(ctx.result, (s) => (looksHtml(s) ? sanitizeHtml(s, textOnly) : s));
  };
  return {
    manifest: {
      id: 'safe-html',
      name: 'SafeHTML Sanitizer',
      version: '0.1.0',
      type: 'hook',
      description:
        'Best-effort HTML sanitisation of results: removes common XSS vectors (script/style/iframe/object tags, most on* handlers, javascript:/vbscript:/data: URLs, CSS expression). Regex-based, so NOT complete — never rely on it as the only defence; keep a real DOM sanitizer (e.g. DOMPurify) at the render layer. Optional text-only mode strips all markup. Content over 128 KB is passed through unprocessed.',
      author: 'Kravn',
      priority: 50,
      configSchema: {
        type: 'object',
        properties: { textOnly: { type: 'boolean', title: 'Strip all HTML to plain text' } },
      },
    },
    hooks: { onResourceResult: apply, onToolResult: apply },
  };
}

// ─── 6. TOON Encoder ──────────────────────────────────────────────────────────────────────────────

const isScalar = (v: Json): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);
function toonScalar(v: Json): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '' || /^[-\s]|[\s]$|[,:"\\[\]{}]|[ -]/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }
  return s;
}
const uniformKeys = (a: unknown[]): string[] | null => {
  if (!a.length || !a.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return null;
  const keys = Object.keys(a[0] as object);
  const set = keys.join(' ');
  for (const o of a) {
    const k = Object.keys(o as object);
    if (k.join(' ') !== set) return null;
    if (!k.every((key) => isScalar((o as any)[key]))) return null;
  }
  return keys;
};
function toonKeyed(key: string | null, v: Json, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  const label = key === null ? '' : key;
  if (Array.isArray(v)) {
    const keys = uniformKeys(v);
    if (keys) {
      out.push(pad + label + '[' + v.length + ']{' + keys.join(',') + '}:');
      for (const o of v) out.push('  '.repeat(depth + 1) + keys.map((k) => toonScalar((o as any)[k])).join(','));
    } else if (v.every(isScalar)) {
      out.push(pad + label + '[' + v.length + ']: ' + v.map(toonScalar).join(','));
    } else {
      out.push(pad + label + '[' + v.length + ']:');
      for (const item of v) {
        if (isScalar(item)) out.push('  '.repeat(depth + 1) + '- ' + toonScalar(item));
        else {
          out.push('  '.repeat(depth + 1) + '-');
          toonObject(item, depth + 2, out);
        }
      }
    }
  } else if (v && typeof v === 'object') {
    out.push(pad + label + ':');
    toonObject(v, depth + 1, out);
  } else {
    out.push(pad + label + ': ' + toonScalar(v));
  }
}
function toonObject(v: Json, depth: number, out: string[]): void {
  if (!v || typeof v !== 'object') {
    out.push('  '.repeat(depth) + toonScalar(v));
    return;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) toonKeyed(k, val, depth, out);
}
function encodeToon(v: Json): string {
  const out: string[] = [];
  if (Array.isArray(v)) toonKeyed('data', v, 0, out);
  else if (v && typeof v === 'object') toonObject(v, 0, out);
  else return toonScalar(v);
  return out.join('\n');
}

function toonEncoder(): HookPlugin {
  const apply = (ctx: any) => {
    const config = ctx.config || {};
    const minItems = typeof config.minItems === 'number' ? (config.minItems as number) : 3;
    const result = ctx.result;
    const content = result && (result as any).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
      let parsed: Json;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        continue; // not JSON — leave as-is
      }
      // Only worth it for arrays (or objects holding arrays) big enough to save tokens.
      const big = Array.isArray(parsed) ? parsed.length >= minItems : parsed && typeof parsed === 'object' && Object.values(parsed).some((x) => Array.isArray(x) && x.length >= minItems);
      if (!big) continue;
      block.text = encodeToon(parsed);
      block._format = 'toon';
    }
  };
  return {
    manifest: {
      id: 'toon-encoder',
      name: 'TOON Encoder',
      version: '0.1.0',
      type: 'hook',
      description:
        'Re-encodes JSON tool results as TOON (Token-Oriented Object Notation) — a compact, tabular, LLM-friendly format that cuts 30–70% of tokens for uniform arrays of objects. Best placed LAST in the chain (after redaction/sanitization). Only converts results large enough to benefit.',
      author: 'Kravn',
      priority: 90,
      configSchema: {
        type: 'object',
        properties: { minItems: { type: 'number', title: 'Minimum array length to convert', default: 3 } },
      },
    },
    hooks: { onToolResult: apply },
  };
}

/** All built-in hook plugins (disabled by default; composed on the Pipelines screen). */
export function nativeHookPlugins(): HookPlugin[] {
  return [secretsRedactor(), contentSafety(), denyListFilter(), htmlToMarkdownPlugin(), safeHtmlPlugin(), toonEncoder()];
}
