import { trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';

/**
 * OpenTelemetry tracing (OTLP/HTTP), opt-in via KRAVN_OTEL_ENABLED. Manual instrumentation only — the OTel
 * packages are loaded with a dynamic import ONLY when enabled (zero cost + no ESM instrumentation-hook
 * ordering to worry about). Request spans come from a Fastify hook (app.ts); MCP/LLM/pipeline spans from
 * `withSpan`. Endpoint/service/headers come from the standard OTEL_* env vars.
 */

let tracer: Tracer | null = null;
let shutdownFn: (() => Promise<void>) | null = null;

interface OtelLog {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
}

export async function initOtel(opts: { enabled: boolean; version: string; log: OtelLog }): Promise<void> {
  if (!opts.enabled) return;
  try {
    const { NodeTracerProvider, BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import('@opentelemetry/semantic-conventions');

    const serviceName = process.env.OTEL_SERVICE_NAME || 'kravn-gateway';
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName, [ATTR_SERVICE_VERSION]: opts.version }),
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    });
    provider.register();
    tracer = trace.getTracer('kravn');
    shutdownFn = () => provider.shutdown();
    opts.log.info(
      { service: serviceName, endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '(default localhost:4318)' },
      'OpenTelemetry tracing enabled',
    );
  } catch (err) {
    // Never let observability wiring break boot.
    opts.log.warn({ err }, 'OpenTelemetry init failed; continuing without tracing');
  }
}

export async function shutdownOtel(): Promise<void> {
  if (shutdownFn) await shutdownFn().catch(() => {});
}

export function otelTracer(): Tracer | null {
  return tracer;
}

/** Run `fn` inside a span (a no-op passthrough when tracing is disabled). Records exceptions + error status. */
export async function withSpan<T>(
  name: string,
  fn: (span: Span | undefined) => Promise<T>,
  attrs?: Record<string, string | number | boolean>,
): Promise<T> {
  const t = tracer;
  if (!t) return fn(undefined);
  return t.startActiveSpan(name, async (span) => {
    if (attrs) span.setAttributes(attrs);
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
