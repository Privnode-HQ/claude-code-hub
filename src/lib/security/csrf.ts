/**
 * 简单的“同源/跨站”防御性校验（面向 Cookie 登录态相关接口）
 *
 * 目标：降低登录 CSRF（Login CSRF）与跨站触发登出等风险。
 * 原则：不引入复杂的 CSRF token 机制，仅基于浏览器提供的来源信号做最小化拦截。
 *
 * 说明：
 * - 该检查只适用于变更类请求（POST/PUT/PATCH/DELETE 等）
 * - 优先使用 `Sec-Fetch-Site`（现代浏览器普遍具备）拦截 `cross-site`
 * - 其次校验 `Origin` / `Referer` 是否与服务端视角的 origin 一致
 * - 若以上来源信号均缺失（常见于脚本/CLI），默认放行以兼容非浏览器调用
 */

export type MutatingRequestLike = {
  method: string;
  headers: Headers;
  /**
   * 服务端视角的目标 origin（例如 request.nextUrl.origin）
   */
  origin: string;
};

export type SameOriginCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "sec-fetch-site-cross-site"
        | "origin-mismatch"
        | "referer-mismatch"
        | "invalid-referer";
    };

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function checkSameOriginForMutatingRequest(req: MutatingRequestLike): SameOriginCheckResult {
  const method = req.method.toUpperCase();
  if (!MUTATING_METHODS.has(method)) {
    return { ok: true };
  }

  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite.toLowerCase() === "cross-site") {
    return { ok: false, reason: "sec-fetch-site-cross-site" };
  }

  const originHeader = req.headers.get("origin");
  if (originHeader && originHeader !== req.origin) {
    return { ok: false, reason: "origin-mismatch" };
  }

  const refererHeader = req.headers.get("referer");
  if (refererHeader) {
    try {
      const refererOrigin = new URL(refererHeader).origin;
      if (refererOrigin !== req.origin) {
        return { ok: false, reason: "referer-mismatch" };
      }
    } catch {
      return { ok: false, reason: "invalid-referer" };
    }
  }

  // 兼容：脚本/CLI 请求通常没有这些头，且不存在浏览器跨站上下文。
  return { ok: true };
}
