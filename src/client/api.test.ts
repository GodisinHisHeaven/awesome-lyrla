import { ApiError, api } from './api.js';

function response(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

describe('client api response parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"ok":true}')));

    await expect(api<{ ok: boolean }>('/api/test')).resolves.toEqual({ ok: true });
  });

  it('rejects a successful non-JSON response instead of returning an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('<html>gateway error</html>')));

    await expect(api('/api/test')).rejects.toEqual(
      new ApiError('服务器返回了无效 JSON', 200),
    );
  });

  it('keeps a non-JSON error response as an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('upstream unavailable', 502)));

    await expect(api('/api/test')).rejects.toEqual(
      new ApiError('请求失败 (502)', 502),
    );
  });
});
