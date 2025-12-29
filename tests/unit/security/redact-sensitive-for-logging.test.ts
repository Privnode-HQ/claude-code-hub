import { describe, expect, test } from "vitest";
import { redactSensitiveForLogging } from "@/lib/utils/redact";

describe("redactSensitiveForLogging（日志脱敏）", () => {
  test("对常见敏感字段进行脱敏", () => {
    const result = redactSensitiveForLogging({
      key: "sk-123",
      token: "tok-abc",
      password: "p@ss",
      authorization: "Bearer xxx",
      normal: "ok",
    });

    expect(result).toEqual({
      key: "[REDACTED]",
      token: "[REDACTED]",
      password: "[REDACTED]",
      authorization: "[REDACTED]",
      normal: "ok",
    });
  });

  test("避免误伤常见 *_id 字段", () => {
    const result = redactSensitiveForLogging({
      key_id: 123,
      user_id: 456,
      providerId: 789,
    });

    expect(result).toEqual({
      key_id: 123,
      user_id: 456,
      providerId: 789,
    });
  });

  test("支持嵌套对象与数组脱敏", () => {
    const result = redactSensitiveForLogging({
      provider: {
        name: "p1",
        key: "upstream-secret",
      },
      headers: [
        { name: "x-api-key", value: "k" },
        { name: "content-type", value: "application/json" },
      ],
    });

    expect(result).toEqual({
      provider: {
        name: "p1",
        key: "[REDACTED]",
      },
      headers: [
        { name: "x-api-key", value: "k" },
        { name: "content-type", value: "application/json" },
      ],
    });
  });

  test("超深对象会被截断（防御性）", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: "x" } } } } } } };
    const result = redactSensitiveForLogging(deep, { maxDepth: 3 });
    expect(result).toEqual({ a: { b: { c: "[TRUNCATED]" } } });
  });
});
