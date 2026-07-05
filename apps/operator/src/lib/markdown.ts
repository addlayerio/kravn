import MarkdownIt from 'markdown-it';

// Small, SAFE markdown renderer for author-provided help/setup text (catalog + plugin manifests).
// `html: false` means any raw HTML in the source is escaped, not passed through — so even an imported
// plugin's manifest text can't inject markup; markdown-it also validates link schemes (blocks
// javascript:/vbscript:/data:). Combined with the operator CSP, rendering these strings is safe.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true });

// Make links open in a new tab, safely.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** Render author-provided markdown to sanitized HTML (block-level). Empty string for empty input. */
export function renderMarkdown(text?: string): string {
  return text ? md.render(text) : '';
}

/** Render a short inline string (no wrapping <p>), for field help/labels. */
export function renderMarkdownInline(text?: string): string {
  return text ? md.renderInline(text) : '';
}
