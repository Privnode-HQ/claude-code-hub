/**
 * 日志脱敏工具
 *
 * 目标：避免在日志中意外输出密钥/令牌/密码等敏感信息（CWE-532）。
 * 原则：只影响日志展示，不改变业务行为；尽量保留结构以便排障。
 */

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

export interface RedactForLoggingOptions {
  /**
   * 递归最大深度，避免异常深对象导致性能问题
   * @default 6
   */
  maxDepth?: number;
  /**
   * 单个对象最多处理的键数量，避免超大对象影响性能
   * @default 50
   */
  maxKeys?: number;
  /**
   * 数组最多处理的元素数量，避免超大数组影响性能
   * @default 50
   */
  maxArrayLength?: number;
}

export function redactSensitiveForLogging(
  input: unknown,
  options: RedactForLoggingOptions = {}
): unknown {
  const maxDepth = options.maxDepth ?? 6;
  const maxKeys = options.maxKeys ?? 50;
  const maxArrayLength = options.maxArrayLength ?? 50;

  function redactValue(value: unknown, depth: number): unknown {
    if (depth >= maxDepth) {
      return TRUNCATED;
    }

    if (value == null) {
      return value;
    }

    if (typeof value !== "object") {
      return value;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }

    if (Array.isArray(value)) {
      const sliced = value.slice(0, maxArrayLength);
      const redacted = sliced.map((item) => redactValue(item, depth + 1));
      return value.length > maxArrayLength ? [...redacted, TRUNCATED] : redacted;
    }

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    let count = 0;

    for (const [rawKey, rawValue] of Object.entries(obj)) {
      count += 1;
      if (count > maxKeys) {
        result.__truncated__ = TRUNCATED;
        break;
      }

      if (shouldRedactKey(rawKey)) {
        result[rawKey] = REDACTED;
      } else {
        result[rawKey] = redactValue(rawValue, depth + 1);
      }
    }

    return result;
  }

  return redactValue(input, 0);
}

function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();

  // 常见“ID”字段不应被误伤（例如 key_id / user_id）
  if (lower.endsWith("_id") || lower.endsWith("id")) {
    return false;
  }

  // 典型敏感字段：精确匹配优先（减少误伤）
  if (
    lower === "key" ||
    lower === "apikey" ||
    lower === "api_key" ||
    lower === "token" ||
    lower === "password" ||
    lower === "secret" ||
    lower === "authorization" ||
    lower === "cookie" ||
    lower === "set-cookie"
  ) {
    return true;
  }

  // 兜底：包含敏感语义的字段名
  if (
    lower.includes("api-key") ||
    lower.includes("api_key") ||
    lower.includes("access_token") ||
    lower.includes("refresh_token") ||
    lower.includes("bearer") ||
    lower.includes("passwd") ||
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("authorization") ||
    lower.includes("cookie")
  ) {
    return true;
  }

  return false;
}
