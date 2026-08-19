export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const raw = await response.text();
  let payload: unknown;
  let validJson = true;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      validJson = false;
    }
  }
  if (!response.ok) {
    const body = payload && typeof payload === 'object'
      ? payload as { message?: unknown; error?: unknown }
      : undefined;
    const message = typeof body?.message === 'string' && body.message
      ? body.message
      : typeof body?.error === 'string' && body.error
        ? body.error
        : `请求失败 (${response.status})`;
    throw new ApiError(
      message,
      response.status,
    );
  }
  if (!validJson) {
    throw new ApiError('服务器返回了无效 JSON', response.status);
  }
  return payload as T;
}
