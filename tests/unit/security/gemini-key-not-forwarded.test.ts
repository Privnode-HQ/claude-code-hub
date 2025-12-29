import { describe, expect, test, vi } from "vitest";

const buildProxyUrlMock = vi.fn(() => {
  throw new Error("stop_buildProxyUrl");
});

vi.mock("@/app/v1/_lib/url", () => ({
  buildProxyUrl: (...args: unknown[]) => buildProxyUrlMock(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  },
}));

describe("ProxyForwarder (Gemini)", () => {
  test("转发到上游时应剥离鉴权用的 key 查询参数（避免透传 Hub Key）", async () => {
    const { ProxyForwarder } = await import("@/app/v1/_lib/proxy/forwarder");

    const session = {
      authState: { key: { cacheTtlPreference: null } },
      setCacheTtlResolved: vi.fn(),
      getOriginalModel: () => null,
      isModelRedirected: () => false,
      request: {
        model: "gemini-1.5-pro",
        message: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
      },
      requestUrl: new URL(
        "https://example.com/v1beta/models/gemini-1.5-pro:generateContent?key=HUB_KEY&alt=sse"
      ),
      method: "POST",
    };

    const provider = {
      id: 1,
      name: "gemini-test",
      providerType: "gemini",
      key: "PROVIDER_KEY",
      url: "https://generativelanguage.googleapis.com/v1beta",
      cacheTtlPreference: null,
      modelRedirects: null,
    };

    const forwarder = ProxyForwarder as unknown as {
      doForward: (s: unknown, p: unknown) => Promise<unknown>;
    };

    await expect(forwarder.doForward(session, provider)).rejects.toThrow("stop_buildProxyUrl");

    expect(buildProxyUrlMock).toHaveBeenCalledTimes(1);
    const [_baseUrl, requestUrlArg] = buildProxyUrlMock.mock.calls[0];

    expect(requestUrlArg).toBeInstanceOf(URL);
    const upstreamUrl = requestUrlArg as URL;

    expect(upstreamUrl.searchParams.get("key")).toBeNull();
    expect(upstreamUrl.searchParams.get("alt")).toBe("sse");
  });
});
