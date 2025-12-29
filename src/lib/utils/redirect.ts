/**
 * 站内跳转目标校验/归一化
 *
 * 用途：防止开放重定向（CWE-601）。
 * 约束：不做“功能删除”，仅拒绝明显的外部/伪装跳转目标。
 *
 * 规则：
 * - 仅允许以 "/" 开头的站内路径
 * - 拒绝以 "//" 开头的协议相对 URL
 * - 拒绝包含 "://" 的绝对 URL
 * - 拒绝以 "\\" 开头的路径（避免在某些环境下被当作网络路径/伪装）
 * - 拒绝包含换行符的输入（避免日志/头部污染）
 * - 限制最大长度，避免极端输入造成不必要的资源消耗
 */
export function toSafeRedirectPath(
  candidate: string | null | undefined,
  fallback: string = "/"
): string {
  const safeFallback = fallback.startsWith("/") && !fallback.startsWith("//") ? fallback : "/";

  if (typeof candidate !== "string") {
    return safeFallback;
  }

  const value = candidate.trim();
  if (!value) {
    return safeFallback;
  }

  // 过长输入直接拒绝（防御性）
  if (value.length > 2048) {
    return safeFallback;
  }

  if (value.includes("\n") || value.includes("\r")) {
    return safeFallback;
  }

  // 绝对 URL / 协议相对 URL / 反斜杠路径一律拒绝
  if (value.includes("://")) {
    return safeFallback;
  }

  if (value.startsWith("//")) {
    return safeFallback;
  }

  if (value.startsWith("\\")) {
    return safeFallback;
  }

  // 只允许站内路径（以 / 开头）
  if (!value.startsWith("/")) {
    return safeFallback;
  }

  return value;
}
