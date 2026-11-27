// Adapter for the Anthropic Messages API. With auth `api-key` it sends the x-api-key header.
// With auth `oauth` it sends a bearer token, which is meant for an enterprise gateway that
// fronts the Messages API and accepts tokens from your own identity provider.

import { request, errorSnippet, safeUrl } from './http.js';
import { PagetreeError } from '../errors.js';

export function createAnthropicAdapter(cfg) {
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  if (!cfg.model) throw new PagetreeError('usage', 'the anthropic adapter needs a model id (PAGETREE_MODEL or --model)');
  return {
    name: 'anthropic',
    model: cfg.model,
    async complete({ system, messages, maxTokens }) {
      const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
      const token = await cfg.getToken();
      if (token && cfg.auth === 'api-key') headers['x-api-key'] = token;
      else if (token) headers.authorization = `Bearer ${token}`;
      const body = { model: cfg.model, system, messages, max_tokens: maxTokens };
      if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
      const t0 = Date.now();
      const res = await request(`${base}/v1/messages`, {
        headers,
        body: JSON.stringify(body),
        timeoutMs: cfg.timeoutMs,
        fetchImpl: cfg.fetchImpl,
        retryOn: (s) => s === 429 || s === 529 || s >= 500,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new PagetreeError(res.status === 401 || res.status === 403 ? 'auth' : 'provider',
          `${safeUrl(base)} answered ${res.status}: ${errorSnippet(res)}`);
      }
      const blocks = (res.json && res.json.content) || [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const u = (res.json && res.json.usage) || {};
      const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      return {
        text,
        model: (res.json && res.json.model) || cfg.model,
        stop: res.json && res.json.stop_reason,
        latencyMs: Date.now() - t0,
        usage: { input_tokens: input, output_tokens: u.output_tokens ?? null, cost_usd: null },
      };
    },
  };
}
