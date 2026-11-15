const SENSITIVE_KEY = /(email|phone|token|secret|password|api[-_]?key|authorization|cookie)/i;

/**
 * Deep-copies a value, masking fields whose names suggest secrets or personal data.
 * Diagnostic traces should explain *what happened*, not replicate customer records.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(v, depth + 1);
  }
  return out as T;
}
