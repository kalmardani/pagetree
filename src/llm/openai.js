// Adapter for any OpenAI compatible chat completions endpoint, hosted or a local server that
// speaks the same API.

import { request, errorSnippet, safeUrl } from './http.js';
import { PagetreeError } from '../errors.js';

export function createOpenAIAdapter(cfg) {
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!cfg.model) throw new PagetreeError('usage', 'the openai adapter needs a model id (PAGETREE_MODEL or --model)');
  return {
    name: 'openai',
    model: cfg.model,
    async complete({ system, messages, maxTokens }) {
      const headers = { 'content-type': 'application/json' };
      const token = await cfg.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const body = {
        model: cfg.model,
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: maxTokens,
      };
      if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
      const t0 = Date.now();
      const res = await request(`${base}/chat/completions`, {
        headers,
        body: JSON.stringify(body),
        timeoutMs: cfg.timeoutMs,
        fetchImpl: cfg.fetchImpl,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new PagetreeError(res.status === 401 || res.status === 403 ? 'auth' : 'provider',
          `${safeUrl(base)} answered ${res.status}: ${errorSnippet(res)}`);
      }
      const choice = res.json && res.json.choices && res.json.choices[0];
      const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
      const u = (res.json && res.json.usage) || {};
      return {
        text,
        model: (res.json && res.json.model) || cfg.model,
        stop: choice && choice.finish_reason,
        latencyMs: Date.now() - t0,
        usage: { input_tokens: u.prompt_tokens ?? null, output_tokens: u.completion_tokens ?? null, cost_usd: null },
      };
    },
  };
}
