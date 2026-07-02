import type { KravnPlugin, McpServerPlugin, McpToolResult } from '@kravn/plugin-sdk';
import type { CodeExecutor } from '../interpreter/executor.js';
import { sharepointPlugin } from './sharepoint.js';
import { jiraPlugin } from './jira.js';
import { confluencePlugin } from './confluence.js';
import { nativeHookPlugins } from './native-hooks.js';

/**
 * Native (built-in) plugins shipped with Kravn.
 *
 * Per AGENTS.md, capabilities are plugins — not tools hardcoded into a service. A native plugin is a
 * real `McpServerPlugin` (with `server.listTools`/`callTool`) so it flows through the exact same
 * registry pipeline as any imported mcp-server plugin: it's seeded + pre-loaded (appears in the
 * Plugins screen, enable/disable), its tools are synced into the registry (appear in Tools,
 * composable into virtual servers), and it's executed via the normal invoke path.
 *
 * The difference vs a user/imported plugin: a native plugin ships IN-CODE (not as a sandboxed
 * DB-stored ES module), so it can use privileged runtime — here, the Pyodide code executor and the
 * per-call file workspace (McpCallContext.files). That's why it's built by a factory with injected deps.
 */
export interface NativeDeps {
  interpreter: CodeExecutor;
}

export const CODE_INTERPRETER_ID = 'kravn-code-interpreter';
export const INTERPRETER_TOOL_NAME = 'kravn_run_python';

function codeInterpreterPlugin(deps: NativeDeps): McpServerPlugin {
  return {
    manifest: {
      id: CODE_INTERPRETER_ID,
      name: 'Code Interpreter (Python)',
      version: '0.1.0',
      type: 'mcp-server',
      description:
        'Runs Python in a sandbox (Pyodide/WASM, no host filesystem or network) to read and transform ' +
        "the user's attached files — e.g. complete an Excel and return it as a download. Exposes the " +
        'run_python tool. openpyxl + the Python stdlib are available.',
      author: 'Kravn',
      priority: 100,
      configSchema: { type: 'object', properties: {} },
    },
    server: {
      listTools() {
        return [
          {
            name: INTERPRETER_TOOL_NAME,
            description:
              "Run Python 3 in a secure sandbox to read or transform the user's attached files. " +
              'The attached files are already present in the working directory under their original filenames. ' +
              'openpyxl (Excel .xlsx) and the Python standard library (csv, json, io, datetime, statistics, etc.) are available. ' +
              'Write any result file to the working directory (e.g. wb.save("completed.xlsx")) and it will be offered to the user as a download. ' +
              'Returns stdout and stderr. Network and host filesystem are not available.',
            inputSchema: {
              type: 'object',
              properties: { code: { type: 'string', description: 'The Python code to execute.' } },
              required: ['code'],
            },
          },
        ];
      },
      async callTool(name, args, _config, ctx): Promise<McpToolResult> {
        if (name !== INTERPRETER_TOOL_NAME) {
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }
        const code = typeof args.code === 'string' ? args.code : '';
        if (!code.trim()) return { content: [{ type: 'text', text: 'Error: no code provided.' }], isError: true };

        const res = await deps.interpreter.run(code, ctx?.files ?? []);
        const parts: string[] = [];
        if (res.timedOut) parts.push('Execution timed out.');
        if (res.stdout.trim()) parts.push(`STDOUT:\n${res.stdout.slice(0, 4000)}`);
        if (res.stderr.trim()) parts.push(`STDERR:\n${res.stderr.slice(0, 4000)}`);
        if (res.outputs.length) parts.push(`Files produced (offered to the user for download): ${res.outputs.map((o) => o.name).join(', ')}`);
        if (!parts.length) parts.push(res.ok ? '(no output)' : '(execution failed with no output)');
        return {
          content: [{ type: 'text', text: parts.join('\n\n') }],
          isError: !res.ok,
          files: res.outputs.map((o) => ({ name: o.name, b64: o.b64, mime: o.mime })),
        };
      },
    },
  };
}

/** Build the native plugin instances (privileged, in-code) with their runtime dependencies. */
export function nativePlugins(deps: NativeDeps): KravnPlugin[] {
  return [codeInterpreterPlugin(deps), sharepointPlugin(), jiraPlugin(), confluencePlugin(), ...nativeHookPlugins()];
}
