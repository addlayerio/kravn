import {
  LLM_MODEL_CATALOG,
  type CreateLlmProviderRequest,
  type UpdateLlmProviderRequest,
  type DiscoverLlmModelsRequest,
  type LlmModelsResult,
  type LlmProvider,
  type LlmProviderType,
  type LlmTestResult,
} from '@kravn/contracts';
import { newId, type Encryptor } from '../crypto.js';
import { safeFetch } from '../http/client.js';
import type { Repos } from '../db/repos.js';
import type { Logger } from 'pino';

const DEFAULT_BASE: Record<LlmProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  'azure-openai': '',
  ollama: 'http://localhost:11434/v1',
  'openai-compatible': '',
};

/** Provider types whose model list cannot be fetched from the inference endpoint. */
const NO_LIVE_LIST: LlmProviderType[] = ['azure-openai'];

export class LlmService {
  constructor(private repos: Repos, private encryptor: Encryptor, private log: Logger) {}

  list(): Promise<LlmProvider[]> {
    return this.repos.llmProviders.list();
  }
  get(id: string): Promise<LlmProvider | undefined> {
    return this.repos.llmProviders.getById(id);
  }

  async create(req: CreateLlmProviderRequest): Promise<LlmProvider> {
    return this.repos.llmProviders.create({
      id: newId(),
      name: req.name,
      type: req.type,
      baseUrl: req.baseUrl,
      apiKeyEncrypted: req.apiKey ? this.encryptor.encrypt(req.apiKey) : '',
      defaultModel: req.defaultModel,
      models: req.models,
      enabled: req.enabled,
    });
  }

  async update(id: string, req: UpdateLlmProviderRequest): Promise<LlmProvider | undefined> {
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'baseUrl', 'defaultModel', 'models', 'enabled'] as const) {
      if (req[k] !== undefined) patch[k] = req[k];
    }
    if (req.apiKey) patch.apiKeyEncrypted = this.encryptor.encrypt(req.apiKey);
    await this.repos.llmProviders.update(id, patch);
    return this.repos.llmProviders.getById(id);
  }

  async delete(id: string): Promise<void> {
    await this.repos.llmProviders.delete(id);
  }

  private baseUrlFor(p: LlmProvider): string {
    return (p.baseUrl || DEFAULT_BASE[p.type] || '').replace(/\/$/, '');
  }

  /** Run a minimal completion to verify connectivity + credentials. */
  async test(id: string, modelOverride: string): Promise<LlmTestResult> {
    const p = await this.repos.llmProviders.getById(id);
    if (!p) throw new Error('Provider not found.');
    const key = this.encryptor.decrypt(await this.repos.llmProviders.getApiKeyEncrypted(id));
    const base = this.baseUrlFor(p);
    const model = modelOverride || p.defaultModel || p.models[0] || '';

    if (!base) return this.record(id, false, model, 0, 'No base URL configured for this provider.');
    if (!model) return this.record(id, false, model, 0, 'No model configured to test.');

    const started = Date.now();
    try {
      const { url, init } = this.buildRequest(p, base, model, key);
      const res = await safeFetch(url, init, 20_000);
      const latency = Date.now() - started;
      if (res.ok) return this.record(id, true, model, latency, 'OK');
      const body = await res.text();
      return this.record(id, false, model, latency, `HTTP ${res.status}: ${extractError(body)}`);
    } catch (err) {
      const latency = Date.now() - started;
      return this.record(id, false, model, latency, err instanceof Error ? err.message : 'Request failed.');
    }
  }

  private buildRequest(p: LlmProvider, base: string, model: string, key: string): { url: string; init: RequestInit } {
    const messages = [{ role: 'user', content: 'ping' }];
    if (p.type === 'anthropic') {
      return {
        url: `${base}/v1/messages`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({ model, max_tokens: 1, messages }),
        },
      };
    }
    if (p.type === 'azure-openai') {
      return {
        url: `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-06-01`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-key': key },
          body: JSON.stringify({ messages, max_tokens: 1 }),
        },
      };
    }
    if (p.type === 'gemini') {
      return {
        url: `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } }),
        },
      };
    }
    // openai / openai-compatible / ollama
    return {
      url: `${base}/chat/completions`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ model, messages, max_tokens: 1 }),
      },
    };
  }

  /**
   * Discover the model ids a provider exposes by calling its list-models API. Resolves the key from
   * a saved provider (by id) or an ad-hoc one passed in. Falls back to the offline catalog if there's
   * no live listing for the type, no key, or the call fails — so the UI always has something to show.
   */
  async discoverModels(input: DiscoverLlmModelsRequest): Promise<LlmModelsResult> {
    let type: LlmProviderType | undefined = input.type;
    let baseUrl = input.baseUrl ?? '';
    let key = input.apiKey ?? '';

    if (input.providerId) {
      const p = await this.repos.llmProviders.getById(input.providerId);
      if (!p) throw new Error('Provider not found.');
      type = p.type;
      if (input.apiKey) {
        // Caller supplied their OWN key — fine to use it against a caller-supplied URL.
        baseUrl = input.baseUrl || p.baseUrl;
        key = input.apiKey;
      } else {
        // No caller key → use the SAVED provider as the sole source of truth. Never pair the stored
        // (decrypted) secret with a caller-supplied baseUrl, or it could be exfiltrated to any host.
        baseUrl = p.baseUrl;
        key = this.encryptor.decrypt(await this.repos.llmProviders.getApiKeyEncrypted(input.providerId));
      }
    }
    if (!type) throw new Error('Provider type is required to discover models.');

    const catalog = LLM_MODEL_CATALOG[type] ?? [];
    const base = (baseUrl || DEFAULT_BASE[type] || '').replace(/\/$/, '');

    if (NO_LIVE_LIST.includes(type)) {
      return { models: catalog, source: 'catalog', message: 'Azure deployments cannot be auto-listed — add your deployment names.' };
    }
    if (!base) {
      return { models: catalog, source: 'catalog', message: 'No base URL configured — showing common models.' };
    }
    // openai/anthropic/gemini need a key to list; ollama/openai-compatible may not.
    if (!key && (type === 'openai' || type === 'anthropic' || type === 'gemini')) {
      return { models: catalog, source: 'catalog', message: 'Enter an API key to fetch live models — showing common models.' };
    }

    try {
      const { url, init } = this.listRequest(type, base, key);
      const res = await safeFetch(url, init, 20_000);
      if (!res.ok) {
        return { models: catalog, source: 'catalog', message: `Live fetch failed (HTTP ${res.status}: ${extractError(await res.text())}). Showing common models.` };
      }
      const models = parseModelList(type, await res.json());
      if (models.length === 0) return { models: catalog, source: 'catalog', message: 'Provider returned no models — showing common models.' };
      return { models, source: 'live', message: `Fetched ${models.length} models from the provider.` };
    } catch (err) {
      return { models: catalog, source: 'catalog', message: `${err instanceof Error ? err.message : 'Live fetch failed'}. Showing common models.` };
    }
  }

  private listRequest(type: LlmProviderType, base: string, key: string): { url: string; init: RequestInit } {
    if (type === 'anthropic') {
      return { url: `${base}/v1/models`, init: { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } } };
    }
    if (type === 'gemini') {
      return { url: `${base}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`, init: {} };
    }
    // openai / openai-compatible / ollama (OpenAI-compatible /models)
    return { url: `${base}/models`, init: { headers: key ? { Authorization: `Bearer ${key}` } : {} } };
  }

  private async record(id: string, ok: boolean, model: string, latencyMs: number, message: string): Promise<LlmTestResult> {
    await this.repos.llmProviders.update(id, {
      status: ok ? 'ok' : 'error',
      lastError: ok ? '' : message,
      lastTestedAt: new Date().toISOString(),
    });
    return { ok, model, latencyMs, message };
  }
}

function extractError(body: string): string {
  try {
    const j = JSON.parse(body);
    return j?.error?.message || j?.message || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

/** Normalize the dialect-specific list-models response into a sorted, de-duplicated id array. */
function parseModelList(type: LlmProviderType, data: any): string[] {
  let ids: string[] = [];
  if (type === 'gemini') {
    // { models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: [...] }] }
    ids = (Array.isArray(data?.models) ? data.models : [])
      .filter((m: any) => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
      .map((m: any) => String(m?.name ?? '').replace(/^models\//, ''));
  } else {
    // OpenAI/Anthropic shape: { data: [{ id }] }
    ids = (Array.isArray(data?.data) ? data.data : []).map((m: any) => String(m?.id ?? ''));
  }
  return [...new Set(ids.filter(Boolean))].sort();
}
