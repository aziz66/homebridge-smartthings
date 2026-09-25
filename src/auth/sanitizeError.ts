/**
 * Describe an error for logging without leaking credentials.
 *
 * Passing an AxiosError object straight to the Homebridge logger prints its request config,
 * including the Authorization header (Bearer access token, or Basic client credentials on
 * token requests) and the form body (refresh_token / authorization code). Only the message,
 * the HTTP status and the OAuth/SmartThings error fields are safe to show.
 */
export function describeError(error: unknown): string {
  if (error === null || error === undefined) {
    return String(error);
  }
  if (typeof error !== 'object') {
    return String(error);
  }
  const e = error as { message?: unknown; code?: unknown; response?: { status?: unknown; data?: unknown } };
  const parts: string[] = [typeof e.message === 'string' && e.message ? e.message : 'Unknown error'];
  if (typeof e.code === 'string' && !parts[0].includes(e.code)) {
    parts.push(`(${e.code})`);
  }
  const response = e.response;
  if (response && typeof response === 'object') {
    if (typeof response.status === 'number') {
      parts.push(`[HTTP ${response.status}]`);
    }
    const data = response.data as { error?: unknown; error_description?: unknown } | undefined;
    if (data && typeof data === 'object') {
      if (typeof data.error === 'string') {
        parts.push(data.error);
      } else if (data.error && typeof data.error === 'object') {
        // SmartThings API errors: { requestId, error: { code, message } }
        const apiError = data.error as { code?: unknown; message?: unknown };
        if (typeof apiError.code === 'string') {
          parts.push(apiError.code);
        }
        if (typeof apiError.message === 'string') {
          parts.push(apiError.message);
        }
      }
      if (typeof data.error_description === 'string') {
        parts.push(data.error_description);
      }
    }
  }
  return parts.join(' ');
}

/**
 * Strip credentials from an (axios) error in place before it is rethrown, so callers that log
 * the whole object - including service code - cannot print them: masks the Authorization
 * header, optionally the request body (token requests carry the refresh token / authorization
 * code), and hides the raw request objects, whose header block (`_header`) repeats the
 * Authorization value, from util.inspect.
 */
export function redactAxiosError<T>(error: T, redactBody = false): T {
  if (!error || typeof error !== 'object') {
    return error;
  }
  const e = error as { config?: Record<string, unknown>; response?: Record<string, unknown> };
  for (const config of [e.config, e.response?.config as Record<string, unknown> | undefined]) {
    if (!config || typeof config !== 'object') {
      continue;
    }
    const headers = config.headers as Record<string, unknown> | undefined;
    if (headers && typeof headers === 'object') {
      for (const name of ['Authorization', 'authorization']) {
        if (headers[name] !== undefined) {
          headers[name] = '[REDACTED]';
        }
      }
    }
    if (redactBody && config.data !== undefined) {
      config.data = '[REDACTED]';
    }
  }
  for (const holder of [e as Record<string, unknown>, e.response]) {
    if (holder && typeof holder === 'object' && 'request' in holder) {
      Object.defineProperty(holder, 'request', { value: holder.request, enumerable: false, configurable: true, writable: true });
    }
  }
  return error;
}
