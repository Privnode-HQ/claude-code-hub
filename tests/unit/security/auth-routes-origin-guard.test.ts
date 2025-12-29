import { beforeEach, describe, expect, test, vi } from "vitest";

const validateKeyMock = vi.fn();
const setAuthCookieMock = vi.fn();
const getLoginRedirectTargetMock = vi.fn();
const clearAuthCookieMock = vi.fn();

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({
  validateKey: (...args: unknown[]) => validateKeyMock(...args),
  setAuthCookie: (...args: unknown[]) => setAuthCookieMock(...args),
  getLoginRedirectTarget: (...args: unknown[]) => getLoginRedirectTargetMock(...args),
  clearAuthCookie: (...args: unknown[]) => clearAuthCookieMock(...args),
}));

describe("/api/auth/login & /api/auth/logout（同源防护）", () => {
  beforeEach(() => {
    vi.resetModules();
    validateKeyMock.mockReset();
    setAuthCookieMock.mockReset();
    getLoginRedirectTargetMock.mockReset();
    clearAuthCookieMock.mockReset();
  });

  test("login：跨站请求应被拒绝（Sec-Fetch-Site=cross-site）", async () => {
    const { POST } = await import("@/app/api/auth/login/route");

    const request = {
      method: "POST",
      headers: new Headers({ "sec-fetch-site": "cross-site" }),
      nextUrl: new URL("https://example.com/api/auth/login"),
      json: vi.fn(),
    };

    const response = await POST(request as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "非法请求来源" });
    expect(request.json).not.toHaveBeenCalled();
  });

  test("login：缺少 key 返回 400", async () => {
    const { POST } = await import("@/app/api/auth/login/route");

    const request = {
      method: "POST",
      headers: new Headers({ origin: "https://example.com" }),
      nextUrl: new URL("https://example.com/api/auth/login"),
      json: vi.fn(async () => ({})),
    };

    const response = await POST(request as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "请输入 API Key" });
  });

  test("login：key 无效返回 401（不设置 cookie）", async () => {
    const { POST } = await import("@/app/api/auth/login/route");

    validateKeyMock.mockResolvedValueOnce(null);

    const request = {
      method: "POST",
      headers: new Headers({ origin: "https://example.com" }),
      nextUrl: new URL("https://example.com/api/auth/login"),
      json: vi.fn(async () => ({ key: "bad-key" })),
    };

    const response = await POST(request as never);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "API Key 无效或已过期" });
    expect(setAuthCookieMock).not.toHaveBeenCalled();
  });

  test("login：key 有效设置 cookie 并返回 redirectTo", async () => {
    const { POST } = await import("@/app/api/auth/login/route");

    validateKeyMock.mockResolvedValueOnce({
      user: { id: 1, name: "u1", description: "d1", role: "user" },
      key: { id: 1, userId: 1, canLoginWebUi: true },
    });
    getLoginRedirectTargetMock.mockReturnValueOnce("/dashboard");

    const request = {
      method: "POST",
      headers: new Headers({ origin: "https://example.com" }),
      nextUrl: new URL("https://example.com/api/auth/login"),
      json: vi.fn(async () => ({ key: "good-key" })),
    };

    const response = await POST(request as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      user: { id: 1, name: "u1", description: "d1", role: "user" },
      redirectTo: "/dashboard",
    });
    expect(setAuthCookieMock).toHaveBeenCalledWith("good-key");
  });

  test("logout：跨站请求应被拒绝（Sec-Fetch-Site=cross-site）", async () => {
    const { POST } = await import("@/app/api/auth/logout/route");

    const request = {
      method: "POST",
      headers: new Headers({ "sec-fetch-site": "cross-site" }),
      nextUrl: new URL("https://example.com/api/auth/logout"),
    };

    const response = await POST(request as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "非法请求来源" });
    expect(clearAuthCookieMock).not.toHaveBeenCalled();
  });

  test("logout：同源请求应清理 cookie 并返回 ok", async () => {
    const { POST } = await import("@/app/api/auth/logout/route");

    const request = {
      method: "POST",
      headers: new Headers({ origin: "https://example.com" }),
      nextUrl: new URL("https://example.com/api/auth/logout"),
    };

    const response = await POST(request as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(clearAuthCookieMock).toHaveBeenCalledTimes(1);
  });
});
