// Public routes count wire bytes before decoding or parsing. A declared
// length is only an early refusal; chunked and dishonest lengths get the same cap.
export async function cappedText(request: Request, maxBytes: number): Promise<{ text: string } | 'tooBig' | null> {
  const length = request.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    void request.body?.cancel().catch(() => undefined);
    return 'tooBig';
  }
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return 'tooBig';
      }
      parts.push(value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.byteLength; }
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(data) };
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function cappedJson(request: Request, maxBytes: number): Promise<Record<string, unknown> | 'tooBig' | null> {
  const body = await cappedText(request, maxBytes);
  if (!body || body === 'tooBig') return body;
  try {
    const value: unknown = body.text ? JSON.parse(body.text) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
