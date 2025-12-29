import { beforeEach, describe, expect, test, vi } from "vitest";

let redisStore: Map<string, string>;
let redisClient: {
  status: string;
  get: (key: string) => Promise<string | null>;
  setex: (key: string, ttl: number, value: string) => Promise<"OK">;
  expire: (key: string, ttl: number) => Promise<number>;
  pipeline: () => {
    setex: (key: string, ttl: number, value: string) => unknown;
    expire: (key: string, ttl: number) => unknown;
    del: (key: string) => unknown;
    exec: () => Promise<unknown[]>;
  };
} | null = null;

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logger", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/app/v1/_lib/proxy/errors", () => ({
  sanitizeHeaders: vi.fn(() => "(empty)"),
}));

vi.mock("@/lib/redis", () => ({
  getRedisClient: () => redisClient,
}));

function createMockRedis(store: Map<string, string>) {
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const setex = vi.fn(async (key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return "OK" as const;
  });
  const expire = vi.fn(async (_key: string, _ttl: number) => 1);

  const pipelineFactory = () => {
    const ops: Array<() => void> = [];
    const pipeline = {
      setex: (key: string, _ttl: number, value: string) => {
        ops.push(() => store.set(key, value));
        return pipeline;
      },
      expire: (_key: string, _ttl: number) => {
        ops.push(() => undefined);
        return pipeline;
      },
      del: (key: string) => {
        ops.push(() => store.delete(key));
        return pipeline;
      },
      exec: vi.fn(async () => {
        for (const op of ops) op();
        return [];
      }),
    };
    return pipeline;
  };

  return {
    status: "ready",
    get,
    setex,
    expire,
    pipeline: pipelineFactory,
  };
}

describe("SessionManager.getOrCreateSessionId（会话隔离与防碰撞）", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    redisStore = new Map();
    redisClient = createMockRedis(redisStore);
  });

  test("contentHash 映射按 keyId 隔离（避免跨 Key 复用 session）", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    vi.spyOn(SessionManager, "calculateMessagesHash").mockReturnValue("hash123");
    vi.spyOn(SessionManager, "generateSessionId")
      .mockReturnValueOnce("sess_A")
      .mockReturnValueOnce("sess_B");

    const messages = [{ content: "hi" }, { content: "x" }, { content: "y" }];

    const id1 = await SessionManager.getOrCreateSessionId(1, messages, null);
    const id2 = await SessionManager.getOrCreateSessionId(2, messages, null);

    expect(id1).toBe("sess_A");
    expect(id2).toBe("sess_B");

    expect(redisStore.get("hash:1:hash123:session")).toBe("sess_A");
    expect(redisStore.get("hash:2:hash123:session")).toBe("sess_B");
  });

  test("legacy hash key 仅在 owner=同 keyId 时允许复用并迁移", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    vi.spyOn(SessionManager, "calculateMessagesHash").mockReturnValue("hash123");

    redisStore.set("hash:hash123:session", "sess_legacy");
    redisStore.set("session:sess_legacy:key", "1");

    const messages = [{ content: "hi" }, { content: "x" }, { content: "y" }];

    const reused = await SessionManager.getOrCreateSessionId(1, messages, null);
    expect(reused).toBe("sess_legacy");
    expect(redisStore.get("hash:1:hash123:session")).toBe("sess_legacy");

    vi.spyOn(SessionManager, "generateSessionId").mockReturnValueOnce("sess_new");
    const notReused = await SessionManager.getOrCreateSessionId(2, messages, null);
    expect(notReused).toBe("sess_new");
    expect(redisStore.get("hash:2:hash123:session")).toBe("sess_new");
  });

  test("客户端 sessionId 若被其他 keyId 占用则拒绝复用", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    redisStore.set("session:client_123:key", "1");

    vi.spyOn(SessionManager, "generateSessionId").mockReturnValueOnce("sess_collision_new");

    const messages = [{ content: "hi" }, { content: "x" }, { content: "y" }];
    const sessionId = await SessionManager.getOrCreateSessionId(2, messages, "client_123");

    expect(sessionId).toBe("sess_collision_new");
    expect(redisStore.get("session:client_123:key")).toBe("1");
  });

  test("客户端 sessionId 未占用时允许复用并记录 owner", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    const messages = [{ content: "hi" }, { content: "x" }, { content: "y" }];
    const sessionId = await SessionManager.getOrCreateSessionId(7, messages, "client_ok");

    expect(sessionId).toBe("client_ok");
    expect(redisStore.get("session:client_ok:key")).toBe("7");
  });
});
