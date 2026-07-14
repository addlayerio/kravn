#!/usr/bin/env node
/**
 * i18n message guard — compiles every locale message with the SAME compiler vue-i18n uses at runtime, so a
 * string that would crash the app (e.g. an unescaped `@`, which vue-i18n reads as a linked message and throws
 * `INVALID_LINKED_FORMAT` / "SyntaxError: 10") is caught at build time instead of white-screening a user.
 *
 * Locale files are `export default { … } as const;` where the object body is JSON (the reformat script emits
 * JSON.stringify output). We strip the wrapper, JSON.parse, walk every string leaf, and compile it.
 *
 * Fix for a flagged string: escape the special char as a literal — `@` → `{'@'}`, `|` → `{'|'}`,
 * a literal brace → `{'{'}` / `{'}'}`. See AGENTS.md (i18n rule).
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { baseCompile, CompileErrorCodes } from '@intlify/message-compiler';

const CODE_NAME = Object.fromEntries(Object.entries(CompileErrorCodes).map(([k, v]) => [v, k]));

const files = [
  ...globSync('apps/client/src/i18n/locales/*.ts'),
  ...globSync('apps/operator/src/i18n/locales/*.ts'),
].filter((f) => !/\/index\.ts$/.test(f));

function messagesOf(file) {
  const src = readFileSync(file, 'utf8');
  const body = src.replace(/^[\s\S]*?export default\s*/, '').replace(/\s*as const;?\s*$/, '').trim();
  return JSON.parse(body);
}

function* leaves(obj, path = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') yield [[...path, k].join('.'), v];
    else if (v && typeof v === 'object') yield* leaves(v, [...path, k]);
  }
}

let failures = 0;
for (const file of files) {
  let msgs;
  try {
    msgs = messagesOf(file);
  } catch (e) {
    console.error(`✗ ${file}: could not parse locale object — ${e.message}`);
    failures++;
    continue;
  }
  for (const [key, value] of leaves(msgs)) {
    try {
      baseCompile(value, { onError: (err) => { throw err; } });
    } catch (err) {
      const name = CODE_NAME[err.code] ?? `code ${err.code}`;
      console.error(`✗ ${file} → ${key}: ${name}\n    "${value.length > 80 ? value.slice(0, 80) + '…' : value}"`);
      failures++;
    }
  }
}

if (failures) {
  console.error(`\n${failures} unsafe i18n message(s). Escape the special char (e.g. @ → {'@'}). See AGENTS.md.`);
  process.exit(1);
}
console.log(`✓ i18n guard: ${files.length} locale files, all messages compile safely.`);
