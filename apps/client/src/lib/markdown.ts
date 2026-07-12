import MarkdownIt from 'markdown-it';

// SAFE markdown renderer for LLM chat responses. `html: false` means any raw HTML in the model's output is
// ESCAPED, not rendered — so a model (or an injected tool result echoed back) cannot inject <script>, event
// handlers, or other markup; markdown-it only ever emits structural markdown tags (p, code, pre, ul, a, …).
// markdown-it also validates link schemes (blocks javascript:/vbscript:/data:). This is what makes v-html of
// the result safe. `breaks: true` keeps chat line breaks; `linkify` auto-links bare URLs.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true });

// Open links in a new tab, safely.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** Render an LLM chat message (markdown) to sanitized HTML. Empty string for empty input. */
export function renderMarkdown(text?: string): string {
  return text ? md.render(text) : '';
}
