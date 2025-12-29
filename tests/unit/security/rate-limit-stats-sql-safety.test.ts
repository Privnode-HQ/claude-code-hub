import { beforeEach, describe, expect, test, vi } from "vitest";

let capturedLikePattern: unknown;

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();

  const sqlWrapper = (strings: TemplateStringsArray, ...params: unknown[]) =>
    actual.sql(strings, ...params);
  Object.assign(sqlWrapper, actual.sql);
  // 防御性：一旦有人回归到 sql.raw 拼接 WHERE，这里会立刻让单测失败。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sqlWrapper as any).raw = () => {
    throw new Error("禁止使用 sql.raw（避免潜在 SQL 注入与参数错位）");
  };

  return {
    ...actual,
    sql: sqlWrapper,
    // 捕获 LIKE 的模式，确保查询仍限定在 rate_limit_metadata 事件
    like: (column: unknown, pattern: unknown) => {
      capturedLikePattern = pattern;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return actual.like(column as any, pattern as any);
    },
  };
});

vi.mock("@/lib/config", () => ({
  getEnvConfig: () => ({ TZ: "UTC" }),
}));

let resolvedKeyRows: Array<{ key: string }> = [];
let resolvedEventRows: Array<{
  id: number;
  user_id: number;
  provider_id: number;
  error_message: string;
  hour: Date;
}> = [];

const orderByMock = vi.fn(() => Promise.resolve(resolvedEventRows));
const limitMock = vi.fn(() => Promise.resolve(resolvedKeyRows));
const whereMock = vi.fn(() => ({ orderBy: orderByMock, limit: limitMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock("@/drizzle/db", () => ({
  db: {
    select: selectMock,
  },
}));

describe("getRateLimitEventStats（SQL 安全与参数化）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedLikePattern = undefined;
    resolvedKeyRows = [];
    resolvedEventRows = [];
  });

  test("不使用 sql.raw，并固定限定 rate_limit_metadata 事件", async () => {
    const { getRateLimitEventStats } = await import("@/repository/statistics");

    const result = await getRateLimitEventStats({});

    expect(result.total_events).toBe(0);
    expect(capturedLikePattern).toBe("%rate_limit_metadata%");
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(orderByMock).toHaveBeenCalledTimes(1);
  });

  test("key_id 不存在时直接返回空统计（且不查询 message_request）", async () => {
    const { getRateLimitEventStats } = await import("@/repository/statistics");

    resolvedKeyRows = [];
    resolvedEventRows = [
      {
        id: 1,
        user_id: 1,
        provider_id: 1,
        error_message: 'rate_limit_metadata: {"limit_type":"rpm","current":1}',
        hour: new Date("2025-01-01T00:00:00.000Z"),
      },
    ];

    const result = await getRateLimitEventStats({ key_id: 999 });

    expect(result.total_events).toBe(0);
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(limitMock).toHaveBeenCalledTimes(1);
    expect(orderByMock).toHaveBeenCalledTimes(0);
  });
});
