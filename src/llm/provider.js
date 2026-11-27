// The one module that hides the provider. Everything else calls `session.json(...)` and never
// sees which adapter or auth mode is behind it.
//
// A session owns: the adapter, a call cap (cost ceiling), usage totals, the per call log line,
// and the structured output loop (parse, validate, one repair round, then fail closed).

import { createOpenAIAdapter } from './openai.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createClaudeCliAdapter } from './claude-cli.js';
import { createCodexCliAdapter } from './codex-cli.js';
import { createFakeAdapter } from './fake.js';
import { validate, extractJson } from '../schema.js';
import { PagetreeError } from '../errors.js';
import { getAccessToken } from '../auth/oauth.js';
import { createTokenStore, configDir } from '../auth/store.js';

export function createAdapter(cfg, extra = {}) {
  const getToken = async () => {
    if (cfg.auth === 'api-key') {
      const key = cfg.env[cfg.apiKeyEnv];
      if (!key) throw new PagetreeError('auth', `no API key: set ${cfg.apiKeyEnv} (the value is never printed)`);
      return key;
    }
    if (cfg.auth === 'oauth') {
      const store = extra.tokenStore || createTokenStore(configDir(cfg.env));
      return getAccessToken(cfg.oauth, store, { fetchImpl: extra.fetchImpl });
    }
    return null;
  };
  const full = { ...cfg, getToken, fetchImpl: extra.fetchImpl };
  switch (cfg.provider) {
    case 'openai':
      return createOpenAIAdapter(full);
    case 'anthropic':
      return createAnthropicAdapter(full);
    case 'claude-cli':
      return createClaudeCliAdapter(full);
    case 'codex-cli':
      return createCodexCliAdapter(full);
    case 'fake':
      return extra.fake || createFakeAdapter({ scriptFile: cfg.fakeScriptFile });
    default:
      throw new PagetreeError('usage', `unknown provider ${cfg.provider}`);
  }
}

/**
 * @param {object} adapter  object with complete({system, messages, maxTokens, meta})
 * @param {{maxCalls?:number, log?:(line:object)=>void}} opts
 */
export function createSession(adapter, opts = {}) {
  const usage = { calls: 0, repairs: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_known: true, models: new Set() };
  const maxCalls = opts.maxCalls || Infinity;
  const log = opts.log || null;

  async function call(req) {
    if (usage.calls >= maxCalls) {
      throw new PagetreeError('budget', `call cap reached (${maxCalls} model calls). Raise it with --max-calls if the plan needs more.`);
    }
    usage.calls++;
    const res = await adapter.complete(req);
    const u = res.usage || {};
    usage.input_tokens += u.input_tokens || 0;
    usage.output_tokens += u.output_tokens || 0;
    if (typeof u.cost_usd === 'number') usage.cost_usd += u.cost_usd;
    else usage.cost_known = false;
    if (res.model) usage.models.add(res.model);
    if (log) {
      log({
        event: 'model_call',
        task: req.meta && req.meta.task,
        provider: adapter.name,
        model: res.model || adapter.model,
        prompt_version: req.promptVersion || null,
        input_tokens: u.input_tokens ?? null,
        output_tokens: u.output_tokens ?? null,
        cost_usd: u.cost_usd ?? null,
        latency_ms: res.latencyMs ?? null,
        stop: res.stop ?? null,
      });
    }
    return res;
  }

  /**
   * Ask for one JSON object, validate it with `schema` and then with `check` (semantic rules).
   * One repair round with the validation errors, then a model_output error.
   */
  async function json({ system, user, schema, check, maxTokens = 1024, meta, promptVersion }) {
    const messages = [{ role: 'user', content: user }];
    let lastErrors = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await call({ system, messages, maxTokens, meta, promptVersion });
      const parsed = extractJson(res.text);
      let errors;
      if (parsed.error) errors = [parsed.error];
      else {
        errors = validate(parsed.value, schema);
        if (!errors.length && check) errors = check(parsed.value) || [];
      }
      if (log) log({ event: 'validation', task: meta && meta.task, attempt: attempt + 1, ok: errors.length === 0, errors: errors.slice(0, 5) });
      if (!errors.length) return parsed.value;
      lastErrors = errors;
      if (attempt === 0) {
        usage.repairs++;
        messages.push({ role: 'assistant', content: String(res.text).slice(0, 8000) });
        messages.push({
          role: 'user',
          content: `Your reply was rejected by the validator:\n- ${errors.slice(0, 12).join('\n- ')}\nReply again with only the corrected JSON object.`,
        });
      }
    }
    throw new PagetreeError('model_output', `model output for ${meta && meta.task} failed validation twice: ${lastErrors.slice(0, 3).join('; ')}`);
  }

  function summary() {
    return {
      calls: usage.calls,
      repairs: usage.repairs,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost_usd: usage.cost_known ? Number(usage.cost_usd.toFixed(6)) : null,
      models: [...usage.models],
    };
  }

  return { call, json, usage, summary, adapter };
}
