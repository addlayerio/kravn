// Kravn example plugin — an Apigee-style request/response hook.
// Manipulate tool-call arguments/results and filter the advertised tool list.
export default {
  manifest: {
    id: 'tool-guard',
    name: 'Tool Guard',
    version: '0.1.0',
    type: 'hook',
    description: 'Blocks configured tools and logs every tool call.',
    author: 'Kravn',
    priority: 50,
    configSchema: {
      type: 'object',
      properties: {
        // 'x-kravn-source' makes the admin render a live picker of the actual tools.
        deny: { type: 'array', items: { type: 'string' }, title: 'Tools to block', 'x-kravn-source': 'tools' },
      },
    },
  },
  hooks: {
    // Hide blocked tools from what downstream clients can list.
    onListTools(ctx) {
      const deny = (ctx.config && ctx.config.deny) || [];
      ctx.tools = ctx.tools.filter((t) => !deny.includes(t.name));
    },
    // Inspect / mutate / block a call before it is forwarded upstream.
    onToolCall(ctx) {
      const deny = (ctx.config && ctx.config.deny) || [];
      ctx.log('tool call ' + ctx.server + '/' + ctx.tool);
      if (deny.includes(ctx.tool)) ctx.deny('Tool "' + ctx.tool + '" is blocked by policy.');
    },
    // Inspect / mutate the result before it is returned to the client.
    onToolResult(ctx) {
      // Example (disabled): annotate text results.
      // ctx.result.content.push({ type: 'text', text: '[checked by tool-guard]' });
    },
  },
};
