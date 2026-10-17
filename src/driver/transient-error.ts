// Classifies a failed wake-up for the scheduler's bounded retry. Transports
// throw plain Errors, so this matches their messages (src/llm/{chat,messages,
// responses}.ts) and undici's network failures. Anything unrecognised is
// treated as permanent so a config or data error cannot retry-spin. A primary
// call aborted at the turn deadline is rethrown by the runner as "Turn
// deadline reached ...", which is deliberately not matched here.
const HTTP_STATUS = /\bAPI (\d{3}):/;
const TRANSIENT_STATUSES = new Set([408, 409, 425, 429]);
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const hasTransientCause = (error: Error): boolean => {
  const seen = new Set<unknown>();
  for (let current: unknown = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  }
  return false;
};

export const isTransientModelError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error.message.includes('request timed out after')) return true;
  // undici rejects with `TypeError: fetch failed` for DNS, reset, refused, TLS
  // and socket errors before a response, and `TypeError: terminated` when the
  // connection drops while the body is read.
  if (error instanceof TypeError && (error.message === 'fetch failed' || error.message === 'terminated')) return true;
  if (hasTransientCause(error)) return true;
  const status = HTTP_STATUS.exec(error.message)?.[1];
  if (status == null) return false;
  const code = Number(status);
  return code >= 500 || TRANSIENT_STATUSES.has(code);
};
