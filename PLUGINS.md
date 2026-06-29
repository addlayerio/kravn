# Kravn Plugins — developer guide

Kravn is extensible through **plugins**. A plugin is a single, self-contained JavaScript module that
either:

- **hooks** into the request/response flow of every tool call (Apigee-style: you get the request, you
  get the response, you manipulate them), or
- provides an **in-process MCP server** (its own tools / resources / prompts) that Kravn exposes and
  composes like any other server.

Both kinds use the **same contract** and the same install/enable flow. This guide tells you everything
you need to build, test, install and share one.

> **Trust model (read this first).** Plugins run **in-process**, with the same privileges as the Kravn
> server (full Node.js access). They are powerful by design — like Apigee policies or VS Code
> extensions. **Only install plugins you trust.** A hardened, sandboxed execution mode is on the
> roadmap; today, treat installing a plugin like running code on your server.

---

## 1. The shape of a plugin

A plugin is an **ES module** that **default-exports** a plain object. No build step, no dependencies
required:

```js
// my-plugin.mjs
export default {
  manifest: {
    id: 'my-plugin',          // unique slug: [a-z0-9-]
    name: 'My Plugin',
    version: '0.1.0',
    type: 'hook',             // 'hook' | 'mcp-server'
    description: 'What it does.',
    author: 'you',
  },
  // ...one of `hooks` (type: 'hook') or `server` (type: 'mcp-server')
};
```

That's the whole requirement: a `manifest`, plus either `hooks` or `server` depending on the type.

### Manifest fields

| Field          | Required | Notes |
|----------------|----------|-------|
| `id`           | yes      | Unique slug, lowercase letters/numbers/dashes. For single-file plugins it is also the filename (`<id>.mjs`). |
| `name`         | yes      | Human-friendly display name. |
| `version`      | no       | Semver-ish string. Default `0.1.0`. |
| `type`         | yes      | `'hook'` or `'mcp-server'`. |
| `description`  | no       | Shown in the Plugins page. |
| `author`       | no       | |
| `priority`     | no       | Hook ordering — **lower runs first**. Default `100`. |
| `configSchema` | no       | JSON Schema describing the operator-editable config. Shown as a reference when configuring. |

---

## 2. Hook plugins (Apigee-style)

A hook plugin manipulates the MCP request/response flow. You implement any of three hooks:

```js
export default {
  manifest: { id: 'redactor', name: 'Redactor', type: 'hook', priority: 50 },
  hooks: {
    onToolCall(ctx)  { /* inspect/mutate arguments, or block the call */ },
    onToolResult(ctx){ /* inspect/mutate the result */ },
  },
};
```

Implement only the hooks you need. Enabled hooks run in `priority` order (lowest first) for every
matching operation that flows through Kravn (the downstream `/mcp` endpoints and the admin "Test"
playground).

### All hook points

| Hook              | Runs when…                              | Can mutate            | Can deny |
|-------------------|------------------------------------------|-----------------------|----------|
| `onListTools`     | a client lists tools                     | `ctx.tools`           | —        |
| `onToolCall`      | before a tool is invoked (pre-invoke)    | `ctx.arguments`       | ✅       |
| `onToolResult`    | after a tool returns (post-invoke)       | `ctx.result`          | —        |
| `onListResources` | a client lists resources                 | `ctx.resources`       | —        |
| `onResourceRead`  | before a resource is read (pre-fetch)    | `ctx.uri`             | ✅       |
| `onResourceResult`| after a resource is read (post-fetch)    | `ctx.result`          | —        |
| `onListPrompts`   | a client lists prompts                   | `ctx.prompts`         | —        |
| `onPromptGet`     | before a prompt is fetched (pre-fetch)   | `ctx.arguments`       | ✅       |
| `onPromptResult`  | after a prompt is fetched (post-fetch)   | `ctx.result`          | —        |
| `onResolveUser`   | right after authentication               | `ctx.user`            | ✅       |

Every context also carries `config`, `actor` (the caller) and `log(msg)`. `deny(reason)` blocks the
operation. The admin Plugins page shows, per plugin, exactly which hook points it implements.

### `onToolCall(ctx)` — the request side

```ts
ctx.server: string                       // upstream server id the tool belongs to
ctx.tool: string                         // tool name
ctx.arguments: Record<string, unknown>   // MUTABLE — edit in place or reassign
ctx.actor?: { id, email, role }          // the caller, when known
ctx.config: Record<string, unknown>      // this plugin's operator config
ctx.log(message): void                   // write to the Kravn log viewer
ctx.deny(reason): void                   // BLOCK the call (client gets an MCP error)
```

Examples:

```js
onToolCall(ctx) {
  // mutate arguments
  ctx.arguments.maxResults = Math.min(ctx.arguments.maxResults ?? 10, 50);

  // enforce a policy
  if (ctx.tool === 'delete_database') ctx.deny('Destructive tools are disabled.');

  // role-based control
  if (ctx.tool.startsWith('admin_') && ctx.actor?.role !== 'admin') ctx.deny('Admins only.');
}
```

### `onToolResult(ctx)` — the response side

```ts
ctx.server, ctx.tool, ctx.actor, ctx.config, ctx.log   // as above
ctx.result: { content: McpContent[], isError?: boolean }  // MUTABLE
```

```js
onToolResult(ctx) {
  // redact secrets from text content
  for (const part of ctx.result.content) {
    if (part.type === 'text') part.text = part.text.replace(/sk-[a-z0-9]+/gi, '[redacted]');
  }
}
```

### `onListTools(ctx)` — what clients can see

```ts
ctx.tools: Array<{ name, description?, inputSchema?, server }>  // MUTABLE — reassign to filter
ctx.actor, ctx.config, ctx.log
```

```js
onListTools(ctx) {
  // hide tools by name, or per role
  const blocked = ctx.config.hide ?? [];
  ctx.tools = ctx.tools.filter(t => !blocked.includes(t.name));
}
```

### Hook error behaviour

- Calling `ctx.deny(reason)` blocks the call — the client receives an MCP error with your reason.
- If a hook **throws** unexpectedly, Kravn logs it and **continues** (fail-open) so one buggy plugin
  can't take down every call. If you need fail-closed behaviour, call `ctx.deny()` explicitly in a
  `try/catch`.

---

## 3. MCP-server plugins

An `mcp-server` plugin provides tools/resources/prompts implemented in JavaScript. When enabled, it
appears as a **server** in Kravn (source: plugin) and can be composed into virtual servers exactly
like a federated upstream.

```js
export default {
  manifest: { id: 'clock', name: 'Clock', type: 'mcp-server' },
  server: {
    listTools(config) {
      return [{ name: 'now', description: 'Current time', inputSchema: { type: 'object', properties: {} } }];
    },
    async callTool(name, args, config) {
      return { content: [{ type: 'text', text: new Date().toISOString() }] };
    },
    // optional:
    // listResources(config) { return [{ uri, name, mimeType }] }
    // readResource(uri, config) { ... }
    // listPrompts(config) { return [{ name, description, arguments }] }
    // getPrompt(name, args, config) { ... }
  },
};
```

Handler contract:

| Handler          | Required | Returns |
|------------------|----------|---------|
| `listTools`      | yes      | `Array<{ name, description?, inputSchema? }>` |
| `callTool`       | yes      | `{ content: [{ type:'text', text }], isError? }` |
| `listResources`  | no       | `Array<{ uri, name?, description?, mimeType? }>` |
| `readResource`   | no       | MCP resource read result |
| `listPrompts`    | no       | `Array<{ name, description?, arguments? }>` |
| `getPrompt`      | no       | MCP prompt get result |

Every handler receives the operator `config` as its last argument.

---

## 4. Configuration

Declare a `configSchema` (JSON Schema) in your manifest. Operators edit the config from the Plugins
page; your code reads it via `ctx.config` (hooks) or the `config` argument (mcp-server handlers).

```js
manifest: {
  id: 'rate-limit', name: 'Rate limit', type: 'hook',
  configSchema: { type: 'object', properties: { perMinute: { type: 'number', default: 60 } } },
},
hooks: { onToolCall(ctx) { const limit = ctx.config.perMinute ?? 60; /* ... */ } }
```

Config is stored per-instance in the database and survives restarts and plugin updates.

### Live pickers (`x-kravn-source`)

If a field should be chosen from things that exist in this instance, add the vendor extension
`x-kravn-source` to its schema. The admin then renders a **live picker** instead of a free-text box:

- on an **array** field → a multi-select of the available items;
- on a **string** field → a single-select.

Supported sources: `tools`, `resources`, `prompts`, `servers`.

```js
configSchema: {
  type: 'object',
  properties: {
    // multi-select of the gateway's tools
    excludeTools: { type: 'array', items: { type: 'string' }, title: 'Tools to exclude', 'x-kravn-source': 'tools' },
    // single-select of a server
    onlyServer:   { type: 'string', title: 'Limit to server', 'x-kravn-source': 'servers' },
  },
}
```

Your plugin reads these like any other config value (e.g. `ctx.config.excludeTools` is an array of tool
names). Kravn doesn't impose any include/exclude meaning — your hook decides what the list does
(allowlist, denylist, pass-through, etc.).

---

## 5. Installing a plugin

There are two ways:

**A. From the admin UI (easiest).** Plugins page → **Import plugin** → paste the module source and the
id → Import. Kravn writes it to the plugins directory and loads it. (This is the path a future
marketplace "Install" button uses.)

**B. Drop it in the plugins directory (developer inbox).** Copy a single-file `<name>.mjs` into the
plugins directory and click **Rescan** (or restart). It is **ingested into the database** on scan. The
directory is:

```
${KRAVN_PLUGINS_DIR:-<data dir>/plugins}
```

After install, a plugin starts **disabled**. Enable it (and configure it) from the Plugins page.

### Persistence & portability

Plugins are stored **in the database**, not on the pod's filesystem. The module source lives in the
`plugins` table and is loaded from memory at runtime (via an in-process `data:` import). That means:

- Imported plugins **survive pod restarts and rescheduling** even without a persistent volume.
- With Postgres, plugins (and their enabled/config state) are **shared across all replicas** automatically.
- The plugins directory is only an optional ingestion inbox for developers — it is *not* where plugins live.

**Self-contained requirement:** because plugins load from memory, a plugin must be a single
self-contained module. Node.js built-ins (`node:crypto`, `node:url`, …) are available; **external npm
packages are not resolvable** — bundle anything you need into the single file before importing it.

---

## 6. Lifecycle

- **Discovery / reload:** the Plugins page **Rescan** button re-reads the directory and reloads changed
  files. (Edits are picked up without a restart.)
- **Enable / disable:** toggled per-instance; disabled plugins never run.
- **mcp-server plugins:** enabling one registers a plugin-backed server and imports its catalog;
  disabling/deleting removes it and its tools.
- **Delete:** removes the plugin file from the directory and its record.

---

## 7. Authoring in TypeScript (optional)

Plugins are plain objects, so TypeScript is optional. If you want full type-checking, install the SDK
as a dev dependency and use `definePlugin`:

```ts
import { definePlugin, textResult } from '@kravn/plugin-sdk';

export default definePlugin({
  manifest: { id: 'echo', name: 'Echo', type: 'mcp-server' },
  server: {
    listTools: () => [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    callTool: (_name, args) => textResult(String(args.text ?? '')),
  },
});
```

Compile to a single `.mjs` and install it like any other plugin. The SDK is **types only** at runtime —
the installed plugin doesn't need it.

---

## 8. Testing your plugin

1. Import/enable it in a dev Kravn instance.
2. For **mcp-server** plugins: it appears under Servers; open Tools → Test, or call the gateway:
   ```bash
   curl -X POST http://localhost:8080/mcp -H "authorization: Bearer <token>" \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"say_hello","arguments":{"name":"Ada"}}}'
   ```
3. For **hook** plugins: enable it, then call any tool — watch the Logs page for your `ctx.log()` output
   and confirm your mutation/deny behaviour.

---

## 9. Sharing & the marketplace (roadmap)

Because a plugin is one self-contained module + a manifest, sharing is just sharing a file. A future
Kravn **marketplace** will let you publish a plugin and let others install it into their instance with
one click — which is exactly the **Import** flow above, fed from a catalog. Design your plugin to be
self-contained and configurable (via `configSchema`) so it drops cleanly into any instance.

---

## 10. Full reference

The complete, authoritative types live in [`packages/plugin-sdk/src/index.ts`](packages/plugin-sdk/src/index.ts).
Working examples live in [`examples/plugins/`](examples/plugins/):

- [`tool-guard.mjs`](examples/plugins/tool-guard.mjs) — a hook plugin (block/log/filter).
- [`hello-server.mjs`](examples/plugins/hello-server.mjs) — an mcp-server plugin.

These two are also seeded (disabled) into the database on first run so you can enable them and see the
system work immediately.
