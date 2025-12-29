import { beforeEach, describe, expect, test, vi } from "vitest";

const loggerMock = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
};

vi.mock("@/lib/logger", () => ({
  logger: loggerMock,
}));

const hgetallMock = vi.fn<(key: string) => Promise<Record<string, string>>>(() =>
  Promise.resolve({})
);

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: () => ({
    hgetall: (key: string) => hgetallMock(key),
    hset: vi.fn(),
    expire: vi.fn(),
  }),
}));

const findProviderByIdMock = vi.fn();

vi.mock("@/repository/provider", () => ({
  findProviderById: (...args: unknown[]) => findProviderByIdMock(...args),
  findAllProviders: vi.fn(),
}));

describe("Redis hgetall 空对象的完整性处理（防止真值误判）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hgetallMock.mockResolvedValue({});
    findProviderByIdMock.mockReset();
  });

  test("loadCircuitState：当 hgetall 返回空对象 {} 时应视为未命中并返回 null", async () => {
    const { loadCircuitState } = await import("@/lib/redis/circuit-breaker-state");

    const state = await loadCircuitState(123);
    expect(state).toBeNull();
    expect(hgetallMock).toHaveBeenCalledTimes(1);
  });

  test("loadProviderCircuitConfig：当 hgetall 返回空对象 {} 时应走数据库降级加载", async () => {
    const { loadProviderCircuitConfig } = await import("@/lib/redis/circuit-breaker-config");

    findProviderByIdMock.mockResolvedValue({
      id: 1,
      circuitBreakerFailureThreshold: 9,
      circuitBreakerOpenDuration: 111,
      circuitBreakerHalfOpenSuccessThreshold: 3,
    });

    const config = await loadProviderCircuitConfig(1);

    expect(hgetallMock).toHaveBeenCalledTimes(1);
    expect(findProviderByIdMock).toHaveBeenCalledTimes(1);
    expect(config).toEqual({
      failureThreshold: 9,
      openDuration: 111,
      halfOpenSuccessThreshold: 3,
    });
  });
});
