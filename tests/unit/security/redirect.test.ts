import { describe, expect, test } from "vitest";
import { toSafeRedirectPath } from "@/lib/utils/redirect";

describe("toSafeRedirectPath（防开放重定向）", () => {
  test("允许站内路径", () => {
    expect(toSafeRedirectPath("/dashboard", "/fallback")).toBe("/dashboard");
    expect(toSafeRedirectPath("/zh-CN/dashboard?tab=1", "/fallback")).toBe(
      "/zh-CN/dashboard?tab=1"
    );
  });

  test("拒绝绝对 URL（包含协议）", () => {
    expect(toSafeRedirectPath("https://evil.example/phish", "/dashboard")).toBe("/dashboard");
    expect(toSafeRedirectPath("http://evil.example/phish", "/dashboard")).toBe("/dashboard");
  });

  test("拒绝协议相对 URL（//evil）", () => {
    expect(toSafeRedirectPath("//evil.example", "/dashboard")).toBe("/dashboard");
    expect(toSafeRedirectPath("///evil.example", "/dashboard")).toBe("/dashboard");
  });

  test("拒绝非站内相对路径", () => {
    expect(toSafeRedirectPath("dashboard", "/dashboard")).toBe("/dashboard");
    expect(toSafeRedirectPath("./dashboard", "/dashboard")).toBe("/dashboard");
  });

  test("拒绝带换行的输入（防污染）", () => {
    expect(toSafeRedirectPath("/dashboard\nhttps://evil.example", "/dashboard")).toBe("/dashboard");
  });

  test("空值与过长输入回退到 fallback", () => {
    expect(toSafeRedirectPath("", "/dashboard")).toBe("/dashboard");
    expect(toSafeRedirectPath("   ", "/dashboard")).toBe("/dashboard");
    expect(toSafeRedirectPath("a".repeat(5000), "/dashboard")).toBe("/dashboard");
  });
});
