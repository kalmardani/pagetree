// Hand written schema check, enough for the model outputs and the index file. A schema is a
// plain object:
//   { type: 'object', props: { a: S, b: S }, required: ['a'], extra: false }
//   { type: 'array', items: S, min: 0, max: 10 }
//   { type: 'string', min: 1, max: 200, pattern: /re/, enum: ['x', 'y'] }
//   { type: 'integer', min: 1, max: 99 }
//   { type: 'number' } { type: 'boolean' } { type: 'null' }
//   { anyOf: [S, S] }
// validate() returns a list of human readable errors naming the path, value and rule, which is
// also what goes back to the model in the repair round.

export function validate(value, schema, path = '$') {
  const errors = [];
  check(value, schema, path, errors);
  return errors;
}

function show(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

function check(v, s, p, errors) {
  if (s.anyOf) {
    for (const alt of s.anyOf) {
      const sub = [];
      check(v, alt, p, sub);
      if (sub.length === 0) return;
    }
    errors.push(`${p}: value ${show(v)} matches none of the allowed shapes`);
    return;
  }
  switch (s.type) {
    case 'object': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        errors.push(`${p}: expected object, got ${show(v)}`);
        return;
      }
      for (const key of s.required || []) {
        if (!(key in v)) errors.push(`${p}.${key}: required field missing`);
      }
      for (const [key, val] of Object.entries(v)) {
        const sub = s.props && s.props[key];
        if (!sub) {
          if (s.extra === false) errors.push(`${p}.${key}: unknown field not allowed`);
          continue;
        }
        check(val, sub, `${p}.${key}`, errors);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(v)) {
        errors.push(`${p}: expected array, got ${show(v)}`);
        return;
      }
      if (s.min !== undefined && v.length < s.min) errors.push(`${p}: needs at least ${s.min} items, has ${v.length}`);
      if (s.max !== undefined && v.length > s.max) errors.push(`${p}: allows at most ${s.max} items, has ${v.length}`);
      v.forEach((item, i) => check(item, s.items, `${p}[${i}]`, errors));
      return;
    }
    case 'string': {
      if (typeof v !== 'string') {
        errors.push(`${p}: expected string, got ${show(v)}`);
        return;
      }
      if (s.min !== undefined && v.length < s.min) errors.push(`${p}: string shorter than ${s.min} characters`);
      if (s.max !== undefined && v.length > s.max) errors.push(`${p}: string longer than ${s.max} characters (has ${v.length})`);
      if (s.pattern && !s.pattern.test(v)) errors.push(`${p}: value ${show(v)} does not match ${s.pattern}`);
      if (s.enum && !s.enum.includes(v)) errors.push(`${p}: value ${show(v)} is not one of ${s.enum.join(', ')}`);
      return;
    }
    case 'integer':
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v))) {
        errors.push(`${p}: expected ${s.type}, got ${show(v)}`);
        return;
      }
      if (s.min !== undefined && v < s.min) errors.push(`${p}: ${v} is below the minimum ${s.min}`);
      if (s.max !== undefined && v > s.max) errors.push(`${p}: ${v} is above the maximum ${s.max}`);
      return;
    }
    case 'boolean':
      if (typeof v !== 'boolean') errors.push(`${p}: expected boolean, got ${show(v)}`);
      return;
    case 'null':
      if (v !== null) errors.push(`${p}: expected null, got ${show(v)}`);
      return;
    default:
      errors.push(`${p}: schema has unknown type ${show(s.type)}`);
  }
}

/**
 * Pull one JSON value out of a model reply. Accepts a bare JSON object, or one wrapped in a
 * markdown code fence, or preceded by a short sentence. Returns { value } or { error }.
 */
export function extractJson(text) {
  const t = String(text).trim();
  const candidates = [];
  candidates.push(t);
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(t.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return { value: JSON.parse(c) };
    } catch {
      // try the next candidate
    }
  }
  return { error: 'reply is not valid JSON (expected one JSON object and nothing else)' };
}
