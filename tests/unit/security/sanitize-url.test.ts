import { describe, expect, test } from "vitest";
import { sanitizeUrl } from "@/app/v1/_lib/proxy/errors";

describe("sanitizeUrl", () => {
  test("绝对 URL：应脱敏敏感查询参数（key/token 等）", () => {
    const input = "https://example.com/path?key=secret&token=abc&foo=bar";
    const output = sanitizeUrl(input);
    expect(output).toBe("https://example.com/path?key=[REDACTED]&token=[REDACTED]&foo=bar");
  });

  test("相对路径：应保留路径并脱敏敏感查询参数", () => {
    const input = "/v1beta/models/gemini:generateContent?key=secret&alt=sse";
    const output = sanitizeUrl(input);
    expect(output).toBe("/v1beta/models/gemini:generateContent?key=[REDACTED]&alt=sse");
  });

  test("非敏感参数：不应被误伤", () => {
    const input = "https://example.com/path?foobar=baz";
    const output = sanitizeUrl(input);
    expect(output).toBe("https://example.com/path?foobar=baz");
  });

  test("空字符串：应返回占位值", () => {
    expect(sanitizeUrl("")).toBe("(empty url)");
    expect(sanitizeUrl("   ")).toBe("(empty url)");
  });
});
