import { Registry, collectDefaultMetrics, Counter, Gauge } from 'prom-client';

export class Metrics {
  readonly registry = new Registry();
  readonly toolCalls: Counter;
  readonly toolErrors: Counter;
  readonly upstreamConnected: Gauge;
  readonly httpRequests: Counter;
  readonly llmTokens: Counter;
  readonly budgetBlocks: Counter;

  constructor() {
    this.registry.setDefaultLabels({ app: 'kravn' });
    collectDefaultMetrics({ register: this.registry });

    this.toolCalls = new Counter({
      name: 'kravn_tool_calls_total',
      help: 'Total MCP tool invocations proxied',
      labelNames: ['server', 'tool'],
      registers: [this.registry],
    });
    this.toolErrors = new Counter({
      name: 'kravn_tool_call_errors_total',
      help: 'Total failed MCP tool invocations',
      labelNames: ['server', 'tool'],
      registers: [this.registry],
    });
    this.upstreamConnected = new Gauge({
      name: 'kravn_upstream_connected',
      help: 'Number of currently connected upstream MCP servers',
      registers: [this.registry],
    });
    this.httpRequests = new Counter({
      name: 'kravn_http_requests_total',
      help: 'HTTP requests handled',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.llmTokens = new Counter({
      name: 'kravn_llm_tokens_total',
      help: 'LLM tokens consumed via the gateway chat',
      labelNames: ['kind', 'model'], // kind = input | output
      registers: [this.registry],
    });
    this.budgetBlocks = new Counter({
      name: 'kravn_budget_blocks_total',
      help: 'Requests blocked (or warned) by a cost/quota budget',
      labelNames: ['kind', 'action'], // kind = calls | tokens ; action = warn | block
      registers: [this.registry],
    });
  }

  async expose(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
