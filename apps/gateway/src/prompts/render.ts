import nunjucks from 'nunjucks';
import type { LocalPromptArgument } from '@kravn/contracts';

/**
 * Jinja2-compatible rendering via nunjucks (the closest Node analog to ContextForge's Jinja2).
 * Autoescape is OFF because prompts are plain text, not HTML. Undefined variables render empty
 * rather than throwing, so a missing-but-optional argument is harmless.
 */
const env = new nunjucks.Environment(undefined, {
  autoescape: false,
  throwOnUndefined: false,
  trimBlocks: true,
  lstripBlocks: true,
});

export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return env.renderString(template, values);
}

/** Returns the names of required arguments that are missing/blank. */
export function missingRequiredArgs(args: LocalPromptArgument[], values: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const a of args) {
    if (!a.required) continue;
    const v = values[a.name];
    if (v === undefined || v === null || v === '') missing.push(a.name);
  }
  return missing;
}
