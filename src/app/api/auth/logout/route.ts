import { type NextRequest, NextResponse } from "next/server";
import { clearAuthCookie } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { checkSameOriginForMutatingRequest } from "@/lib/security/csrf";

export async function POST(request: NextRequest) {
  const sameOrigin = checkSameOriginForMutatingRequest({
    method: request.method,
    headers: request.headers,
    origin: request.nextUrl.origin,
  });
  if (!sameOrigin.ok) {
    logger.warn("[Auth] Blocked cross-site logout attempt", {
      reason: sameOrigin.reason,
      origin: request.headers.get("origin"),
      referer: request.headers.get("referer"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    });
    return NextResponse.json({ ok: false, error: "非法请求来源" }, { status: 403 });
  }

  await clearAuthCookie();
  return NextResponse.json({ ok: true });
}
