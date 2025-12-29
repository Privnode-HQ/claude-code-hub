import { describe, expect, test } from "vitest";
import { checkSameOriginForMutatingRequest } from "@/lib/security/csrf";

describe("checkSameOriginForMutatingRequest（登录态接口同源校验）", () => {
  test("允许同源请求（Origin 匹配）", () => {
    const result = checkSameOriginForMutatingRequest({
      method: "POST",
      origin: "https://example.com",
      headers: new Headers({
        origin: "https://example.com",
      }),
    });

    expect(result.ok).toBe(true);
  });

  test("拒绝跨站请求（Sec-Fetch-Site=cross-site）", () => {
    const result = checkSameOriginForMutatingRequest({
      method: "POST",
      origin: "https://example.com",
      headers: new Headers({
        "sec-fetch-site": "cross-site",
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("sec-fetch-site-cross-site");
    }
  });

  test("拒绝 Origin 不匹配的请求", () => {
    const result = checkSameOriginForMutatingRequest({
      method: "POST",
      origin: "https://example.com",
      headers: new Headers({
        origin: "https://evil.example",
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("origin-mismatch");
    }
  });

  test("拒绝 Referer 不匹配的请求", () => {
    const result = checkSameOriginForMutatingRequest({
      method: "POST",
      origin: "https://example.com",
      headers: new Headers({
        referer: "https://evil.example/login",
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("referer-mismatch");
    }
  });

  test("Referer 非法值默认拒绝（防御性）", () => {
    const result = checkSameOriginForMutatingRequest({
      method: "POST",
      origin: "https://example.com",
      headers: new Headers({
        referer: "not-a-url",
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-referer");
    }
  });

  test("无来源头时放行（兼容脚本/CLI 调用）", () => {
    const result = checkSameOriginForMutatingRequest({
      method: "POST",
      origin: "https://example.com",
      headers: new Headers(),
    });

    expect(result.ok).toBe(true);
  });

  test("非变更类请求不做限制", () => {
    const result = checkSameOriginForMutatingRequest({
      method: "GET",
      origin: "https://example.com",
      headers: new Headers({
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
        referer: "https://evil.example/x",
      }),
    });

    expect(result.ok).toBe(true);
  });
});
