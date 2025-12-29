import type { Readable } from "node:stream";
import { createGunzip, constants as zlibConstants } from "node:zlib";
import type { Dispatcher } from "undici";
import { Agent, request as undiciRequest } from "undici";
import {
  getCircuitState,
  getProviderHealthInfo,
  recordFailure,
  recordSuccess,
} from "@/lib/circuit-breaker";
import { isHttp2Enabled } from "@/lib/config";
import { getEnvConfig } from "@/lib/config/env.schema";
import { PROVIDER_DEFAULTS, PROVIDER_LIMITS } from "@/lib/constants/provider.constants";
import { logger } from "@/lib/logger";
import { createProxyAgentForProvider } from "@/lib/proxy-agent";
import { SessionManager } from "@/lib/session-manager";
import { CONTEXT_1M_BETA_HEADER, shouldApplyContext1m } from "@/lib/special-attributes";
import type { CacheTtlPreference, CacheTtlResolved } from "@/types/cache";
import { isOfficialCodexClient, sanitizeCodexRequest } from "../codex/utils/request-sanitizer";
import { defaultRegistry } from "../converters";
import type { Format } from "../converters/types";
import { GeminiAuth } from "../gemini/auth";
import { GEMINI_PROTOCOL } from "../gemini/protocol";
import { HeaderProcessor } from "../headers";
import { buildProxyUrl } from "../url";
import {
  buildRequestDetails,
  categorizeErrorAsync,
  EmptyResponseError,
  ErrorCategory,
  getErrorDetectionResultAsync,
  isClientAbortError,
  isEmptyResponseError,
  isHttp2Error,
  ProxyError,
  sanitizeUrl,
} from "./errors";
import { mapClientFormatToTransformer, mapProviderTypeToTransformer } from "./format-mapper";
import { ModelRedirector } from "./model-redirector";
import { ProxyProviderResolver } from "./provider-selector";
import type { ProxySession } from "./session";

const STANDARD_ENDPOINTS = [
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/responses",
  "/v1/chat/completions",
  "/v1/models",
];

const RETRY_LIMITS = PROVIDER_LIMITS.MAX_RETRY_ATTEMPTS;
const MAX_PROVIDER_SWITCHES = 20; // 保险栓：最多切换 20 次供应商（防止无限循环）

type CacheTtlOption = CacheTtlPreference | null | undefined;

function resolveCacheTtlPreference(
  keyPref: CacheTtlOption,
  providerPref: CacheTtlOption
): CacheTtlResolved | null {
  const normalize = (value: CacheTtlOption): CacheTtlResolved | null => {
    if (!value || value === "inherit") return null;
    return value;
  };

  return normalize(keyPref) ?? normalize(providerPref) ?? null;
}

function applyCacheTtlOverrideToMessage(
  message: Record<string, unknown>,
  ttl: CacheTtlResolved
): boolean {
  let applied = false;
  const messages = (message as Record<string, unknown>).messages;

  if (!Array.isArray(messages)) {
    return applied;
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;
    const content = msgObj.content;

    if (!Array.isArray(content)) continue;

    msgObj.content = content.map((item) => {
      if (!item || typeof item !== "object") return item;
      const itemObj = item as Record<string, unknown>;
      const cacheControl = itemObj.cache_control;

      if (cacheControl && typeof cacheControl === "object") {
        const ccObj = cacheControl as Record<string, unknown>;
        if (ccObj.type === "ephemeral") {
          applied = true;
          return {
            ...itemObj,
            cache_control: {
              ...ccObj,
              ttl: ttl === "1h" ? "1h" : "5m",
            },
          };
        }
      }
      return item;
    });
  }

  return applied;
}

function clampRetryAttempts(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return RETRY_LIMITS.MIN;
  return Math.min(Math.max(numeric, RETRY_LIMITS.MIN), RETRY_LIMITS.MAX);
}

function resolveMaxAttemptsForProvider(
  provider: ProxySession["provider"],
  envDefault: number
): number {
  const baseDefault = clampRetryAttempts(envDefault ?? PROVIDER_DEFAULTS.MAX_RETRY_ATTEMPTS);
  if (!provider || provider.maxRetryAttempts === null || provider.maxRetryAttempts === undefined) {
    return baseDefault;
  }
  return clampRetryAttempts(provider.maxRetryAttempts);
}

/**
 * undici request 超时配置（毫秒）
 *
 * 背景：undiciRequest() 在使用非 undici 原生 dispatcher（如 SocksProxyAgent）时，
 * 不会继承全局 Agent 的超时配置，需要显式传递超时参数。
 *
 * 这里与全局 undici Agent 使用同一套环境变量配置（FETCH_HEADERS_TIMEOUT / FETCH_BODY_TIMEOUT）。
 */
// 注意：undici.request 的 headersTimeout/bodyTimeout 属于 RequestOptions；
// connectTimeout 属于 Dispatcher/Client 配置（已在全局 Agent / ProxyAgent 里处理）。

/**
 * 过滤私有参数（下划线前缀）
 *
 * 目的：防止私有参数（下划线前缀）泄露到上游供应商导致 "Unsupported parameter" 错误
 *
 * @param obj - 原始请求对象
 * @returns 过滤后的请求对象
 */
function filterPrivateParameters(obj: unknown): unknown {
  // 非对象类型直接返回
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  // 数组类型递归处理
  if (Array.isArray(obj)) {
    return obj.map((item) => filterPrivateParameters(item));
  }

  // 对象类型：过滤下划线前缀的键
  const filtered: Record<string, unknown> = {};
  const removedKeys: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("_")) {
      // 私有参数：跳过
      removedKeys.push(key);
    } else {
      // 公开参数：递归过滤值
      filtered[key] = filterPrivateParameters(value);
    }
  }

  // 记录被过滤的参数（debug 级别）
  if (removedKeys.length > 0) {
    logger.debug("[ProxyForwarder] Filtered private parameters from request", {
      removedKeys,
      reason: "Private parameters (underscore-prefixed) should not be sent to upstream providers",
    });
  }

  return filtered;
}

export class ProxyForwarder {
  static async send(session: ProxySession): Promise<Response> {
    if (!session.provider || !session.authState?.success) {
      throw new Error("代理上下文缺少供应商或鉴权信息");
    }

    const env = getEnvConfig();
    const envDefaultMaxAttempts = clampRetryAttempts(env.MAX_RETRY_ATTEMPTS_DEFAULT);

    let lastError: Error | null = null;
    let currentProvider = session.provider;
    const failedProviderIds: number[] = []; // 记录已失败的供应商ID
    let totalProvidersAttempted = 0; // 已尝试的供应商数量（用于日志）

    // ========== 外层循环：供应商切换（最多 MAX_PROVIDER_SWITCHES 次）==========
    while (totalProvidersAttempted < MAX_PROVIDER_SWITCHES) {
      totalProvidersAttempted++;
      let attemptCount = 0; // 当前供应商的尝试次数

      const maxAttemptsPerProvider = resolveMaxAttemptsForProvider(
        currentProvider,
        envDefaultMaxAttempts
      );

      logger.info("ProxyForwarder: Trying provider", {
        providerId: currentProvider.id,
        providerName: currentProvider.name,
        totalProvidersAttempted,
        maxRetryAttempts: maxAttemptsPerProvider,
      });

      // ========== 内层循环：重试当前供应商（根据配置最多尝试 maxAttemptsPerProvider 次）==========
      while (attemptCount < maxAttemptsPerProvider) {
        attemptCount++;

        try {
          const response = await ProxyForwarder.doForward(session, currentProvider);

          // ========== 空响应检测（仅非流式）==========
          const contentType = response.headers.get("content-type") || "";
          const isSSE = contentType.includes("text/event-stream");

          if (!isSSE) {
            // 非流式响应：检测空响应
            const contentLength = response.headers.get("content-length");

            // 检测 Content-Length: 0 的情况
            if (contentLength === "0") {
              throw new EmptyResponseError(currentProvider.id, currentProvider.name, "empty_body");
            }

            // 对于没有 Content-Length 的情况，需要 clone 并检查响应体
            // 注意：这会增加一定的性能开销，但对于非流式响应是可接受的
            if (!contentLength) {
              const clonedResponse = response.clone();
              const responseText = await clonedResponse.text();

              if (!responseText || responseText.trim() === "") {
                throw new EmptyResponseError(
                  currentProvider.id,
                  currentProvider.name,
                  "empty_body"
                );
              }

              // 尝试解析 JSON 并检查是否有输出内容
              try {
                const responseJson = JSON.parse(responseText) as Record<string, unknown>;

                // 检测 Claude 格式的空响应
                if (responseJson.type === "message") {
                  const content = responseJson.content as unknown[];
                  if (!content || content.length === 0) {
                    throw new EmptyResponseError(
                      currentProvider.id,
                      currentProvider.name,
                      "missing_content"
                    );
                  }
                }

                // 检测 OpenAI 格式的空响应
                if (responseJson.choices !== undefined) {
                  const choices = responseJson.choices as unknown[];
                  if (!choices || choices.length === 0) {
                    throw new EmptyResponseError(
                      currentProvider.id,
                      currentProvider.name,
                      "missing_content"
                    );
                  }
                }

                // 检测 usage 中的 output_tokens
                const usage = responseJson.usage as Record<string, unknown> | undefined;
                if (usage) {
                  const outputTokens =
                    (usage.output_tokens as number) || (usage.completion_tokens as number) || 0;

                  if (outputTokens === 0) {
                    // 输出 token 为 0，可能是空响应
                    logger.warn("ProxyForwarder: Response has zero output tokens", {
                      providerId: currentProvider.id,
                      providerName: currentProvider.name,
                      usage,
                    });
                    // 注意：不抛出错误，因为某些请求（如 count_tokens）可能合法地返回 0 output tokens
                  }
                }
              } catch (_parseError) {
                // JSON 解析失败但响应体不为空，不视为空响应错误
                logger.debug("ProxyForwarder: Non-JSON response body, skipping content check", {
                  providerId: currentProvider.id,
                  contentType,
                });
              }
            }
          }

          // ========== 成功分支 ==========
          recordSuccess(currentProvider.id);

          // ⭐ 成功后绑定 session 到供应商（智能绑定策略）
          if (session.sessionId) {
            // 使用智能绑定策略（故障转移优先 + 稳定性优化）
            const result = await SessionManager.updateSessionBindingSmart(
              session.sessionId,
              currentProvider.id,
              currentProvider.priority || 0,
              totalProvidersAttempted === 1 && attemptCount === 1, // isFirstAttempt
              totalProvidersAttempted > 1 // isFailoverSuccess: 切换过供应商
            );

            if (result.updated) {
              logger.info("ProxyForwarder: Session binding updated", {
                sessionId: session.sessionId,
                providerId: currentProvider.id,
                providerName: currentProvider.name,
                priority: currentProvider.priority,
                groupTag: currentProvider.groupTag,
                reason: result.reason,
                details: result.details,
                attemptNumber: attemptCount,
                totalProvidersAttempted,
              });
            } else {
              logger.debug("ProxyForwarder: Session binding not updated", {
                sessionId: session.sessionId,
                providerId: currentProvider.id,
                providerName: currentProvider.name,
                priority: currentProvider.priority,
                reason: result.reason,
                details: result.details,
              });
            }

            // ⭐ 统一更新两个数据源（确保监控数据一致）
            // session:provider (真实绑定) 已在 updateSessionBindingSmart 中更新
            // session:info (监控信息) 在此更新
            void SessionManager.updateSessionProvider(session.sessionId, {
              providerId: currentProvider.id,
              providerName: currentProvider.name,
            }).catch((error) => {
              logger.error("ProxyForwarder: Failed to update session provider info", { error });
            });
          }

          // 记录到决策链
          session.addProviderToChain(currentProvider, {
            reason:
              totalProvidersAttempted === 1 && attemptCount === 1
                ? "request_success"
                : "retry_success",
            attemptNumber: attemptCount,
            statusCode: response.status,
            circuitState: getCircuitState(currentProvider.id),
          });

          logger.info("ProxyForwarder: Request successful", {
            providerId: currentProvider.id,
            providerName: currentProvider.name,
            attemptNumber: attemptCount,
            totalProvidersAttempted,
            statusCode: response.status,
          });

          return response; // ⭐ 成功：立即返回，结束所有循环
        } catch (error) {
          lastError = error as Error;

          // ⭐ 1. 分类错误（供应商错误 vs 系统错误 vs 客户端中断）
          // 使用异步版本确保错误规则已加载
          const errorCategory = await categorizeErrorAsync(lastError);
          const errorMessage =
            lastError instanceof ProxyError
              ? lastError.getDetailedErrorMessage()
              : lastError.message;

          // ⭐ 2. 客户端中断处理（不计入熔断器，不重试，立即返回）
          if (errorCategory === ErrorCategory.CLIENT_ABORT) {
            logger.warn("ProxyForwarder: Client aborted, stopping immediately", {
              providerId: currentProvider.id,
              providerName: currentProvider.name,
              attemptNumber: attemptCount,
              totalProvidersAttempted,
            });

            // 记录到决策链（标记为客户端中断）
            session.addProviderToChain(currentProvider, {
              reason: "system_error", // 使用 system_error 作为客户端中断的原因
              circuitState: getCircuitState(currentProvider.id),
              attemptNumber: attemptCount,
              errorMessage: "Client aborted request",
              errorDetails: {
                system: {
                  errorType: "ClientAbort",
                  errorName: lastError.name,
                  errorMessage: lastError.message || "Client aborted request",
                  errorCode: "CLIENT_ABORT",
                  errorStack: lastError.stack?.split("\n").slice(0, 3).join("\n"),
                },
                request: buildRequestDetails(session),
              },
            });

            // 立即抛出错误，不重试
            throw lastError;
          }

          // ⭐ 3. 不可重试的客户端输入错误处理（不计入熔断器，不重试，立即返回）
          if (errorCategory === ErrorCategory.NON_RETRYABLE_CLIENT_ERROR) {
            const proxyError = lastError as ProxyError;
            const statusCode = proxyError.statusCode;
            const detectionResult = await getErrorDetectionResultAsync(lastError);
            const matchedRule =
              detectionResult.matched &&
              detectionResult.ruleId !== undefined &&
              detectionResult.pattern !== undefined &&
              detectionResult.matchType !== undefined &&
              detectionResult.category !== undefined
                ? {
                    ruleId: detectionResult.ruleId,
                    pattern: detectionResult.pattern,
                    matchType: detectionResult.matchType,
                    category: detectionResult.category,
                    description: detectionResult.description,
                    hasOverrideResponse: detectionResult.overrideResponse !== undefined,
                    hasOverrideStatusCode: detectionResult.overrideStatusCode !== undefined,
                  }
                : undefined;

            logger.warn("ProxyForwarder: Non-retryable client error, stopping immediately", {
              providerId: currentProvider.id,
              providerName: currentProvider.name,
              statusCode: statusCode,
              error: errorMessage,
              attemptNumber: attemptCount,
              totalProvidersAttempted,
              reason:
                "White-listed client error (prompt length, content filter, PDF limit, or thinking format)",
            });

            // 记录到决策链（标记为不可重试的客户端错误）
            // 注意：不调用 recordFailure()，因为这不是供应商的问题，是客户端输入问题
            session.addProviderToChain(currentProvider, {
              reason: "client_error_non_retryable", // 新增的 reason 值
              circuitState: getCircuitState(currentProvider.id),
              attemptNumber: attemptCount,
              errorMessage: errorMessage,
              statusCode: statusCode,
              errorDetails: {
                provider: {
                  id: currentProvider.id,
                  name: currentProvider.name,
                  statusCode: statusCode,
                  statusText: proxyError.message,
                  upstreamBody: proxyError.upstreamError?.body,
                  upstreamParsed: proxyError.upstreamError?.parsed,
                },
                clientError: proxyError.getDetailedErrorMessage(),
                matchedRule,
                request: buildRequestDetails(session),
              },
            });

            // 立即抛出错误，不重试，不切换供应商
            // 白名单错误不计入熔断器，因为是客户端输入问题，不是供应商故障
            throw lastError;
          }

          // ⭐ 4. 系统错误处理（不计入熔断器，先重试1次当前供应商）
          if (errorCategory === ErrorCategory.SYSTEM_ERROR) {
            const err = lastError as Error & {
              code?: string;
              syscall?: string;
            };

            logger.warn("ProxyForwarder: System/network error occurred", {
              providerId: currentProvider.id,
              providerName: currentProvider.name,
              error: errorMessage,
              attemptNumber: attemptCount,
              totalProvidersAttempted,
              willRetry: attemptCount < maxAttemptsPerProvider,
            });

            // 记录到决策链（不计入 failedProviderIds）
            session.addProviderToChain(currentProvider, {
              reason: "system_error",
              circuitState: getCircuitState(currentProvider.id),
              attemptNumber: attemptCount,
              errorMessage: errorMessage,
              errorDetails: {
                system: {
                  errorType: err.constructor.name,
                  errorName: err.name,
                  errorMessage: err.message || err.name || "Unknown error",
                  errorCode: err.code,
                  errorSyscall: err.syscall,
                  errorStack: err.stack?.split("\n").slice(0, 3).join("\n"),
                },
                request: buildRequestDetails(session),
              },
            });

            // 第1次失败：等待100ms后重试当前供应商
            if (attemptCount < maxAttemptsPerProvider) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue; // ⭐ 继续内层循环（重试当前供应商）
            }

            // 第2次失败：跳出内层循环，切换供应商
            logger.warn("ProxyForwarder: System error persists, will switch provider", {
              providerId: currentProvider.id,
              providerName: currentProvider.name,
              totalProvidersAttempted,
            });

            // ⭐ 检查是否启用了网络错误计入熔断器
            const env = getEnvConfig();

            // 无论是否计入熔断器，都要加入 failedProviderIds（避免重复选择同一供应商）
            failedProviderIds.push(currentProvider.id);

            if (env.ENABLE_CIRCUIT_BREAKER_ON_NETWORK_ERRORS) {
              logger.warn(
                "ProxyForwarder: Network error will be counted towards circuit breaker (enabled by config)",
                {
                  providerId: currentProvider.id,
                  providerName: currentProvider.name,
                  errorType: err.constructor.name,
                  errorCode: err.code,
                }
              );

              // 计入熔断器
              await recordFailure(currentProvider.id, lastError);
            } else {
              logger.debug(
                "ProxyForwarder: Network error not counted towards circuit breaker (disabled by default)",
                {
                  providerId: currentProvider.id,
                  providerName: currentProvider.name,
                }
              );
            }

            break; // ⭐ 跳出内层循环，进入供应商切换逻辑
          }

          // ⭐ 5. 上游 404 错误处理（不计入熔断器，先重试当前供应商，重试耗尽后切换）
          if (errorCategory === ErrorCategory.RESOURCE_NOT_FOUND) {
            const proxyError = lastError as ProxyError;
            const willRetry = attemptCount < maxAttemptsPerProvider;

            logger.warn("ProxyForwarder: Upstream 404 error", {
              providerId: currentProvider.id,
              providerName: currentProvider.name,
              statusCode: 404,
              error: errorMessage,
              attemptNumber: attemptCount,
              totalProvidersAttempted,
              willRetry,
            });

            // 记录到决策链（标记为 resource_not_found，不计入熔断）
            session.addProviderToChain(currentProvider, {
              reason: "resource_not_found",
              circuitState: getCircuitState(currentProvider.id),
              attemptNumber: attemptCount,
              errorMessage: errorMessage,
              statusCode: 404,
              errorDetails: {
                provider: {
                  id: currentProvider.id,
                  name: currentProvider.name,
                  statusCode: 404,
                  statusText: proxyError.message,
                  upstreamBody: proxyError.upstreamError?.body,
                  upstreamParsed: proxyError.upstreamError?.parsed,
                },
                request: buildRequestDetails(session),
              },
            });

            // 不调用 recordFailure()，不计入熔断器

            // 未耗尽重试次数：等待 100ms 后继续重试当前供应商
            if (willRetry) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }

            // 重试耗尽：加入失败列表并切换供应商
            failedProviderIds.push(currentProvider.id);
            break; // ⭐ 跳出内层循环，进入供应商切换逻辑
          }

          // ⭐ 6. 供应商错误处理（所有 4xx/5xx HTTP 错误 + 空响应错误，计入熔断器，重试耗尽后切换）
          if (errorCategory === ErrorCategory.PROVIDER_ERROR) {
            // 🆕 空响应错误特殊处理（EmptyResponseError 不是 ProxyError）
            if (isEmptyResponseError(lastError)) {
              const emptyError = lastError as EmptyResponseError;
              const willRetry = attemptCount < maxAttemptsPerProvider;

              logger.warn("ProxyForwarder: Empty response detected", {
                providerId: currentProvider.id,
                providerName: currentProvider.name,
                reason: emptyError.reason,
                error: emptyError.message,
                attemptNumber: attemptCount,
                totalProvidersAttempted,
                willRetry,
              });

              // 获取熔断器健康信息
              const { health, config } = await getProviderHealthInfo(currentProvider.id);

              // 记录到决策链
              session.addProviderToChain(currentProvider, {
                reason: "retry_failed",
                circuitState: getCircuitState(currentProvider.id),
                attemptNumber: attemptCount,
                errorMessage: emptyError.message,
                circuitFailureCount: health.failureCount + 1,
                circuitFailureThreshold: config.failureThreshold,
                statusCode: 520, // Web Server Returned an Unknown Error
                errorDetails: {
                  provider: {
                    id: currentProvider.id,
                    name: currentProvider.name,
                    statusCode: 520,
                    statusText: `Empty response: ${emptyError.reason}`,
                  },
                  request: buildRequestDetails(session),
                },
              });

              // 未耗尽重试次数：等待 100ms 后继续重试当前供应商
              if (willRetry) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
              }

              // 重试耗尽：计入熔断器并切换供应商
              if (!session.isProbeRequest()) {
                await recordFailure(currentProvider.id, lastError);
              }

              failedProviderIds.push(currentProvider.id);
              break; // 跳出内层循环，进入供应商切换逻辑
            }

            // 常规 ProxyError 处理
            const proxyError = lastError as ProxyError;
            const statusCode = proxyError.statusCode;
            const willRetry = attemptCount < maxAttemptsPerProvider;

            // 🆕 count_tokens 请求特殊处理：不计入熔断，不触发供应商切换
            if (session.isCountTokensRequest()) {
              logger.debug(
                "ProxyForwarder: count_tokens request error, skipping circuit breaker and provider switch",
                {
                  providerId: currentProvider.id,
                  providerName: currentProvider.name,
                  statusCode,
                  error: proxyError.message,
                }
              );
              // 直接抛出错误，不重试，不切换供应商
              throw lastError;
            }

            logger.warn("ProxyForwarder: Provider error occurred", {
              providerId: currentProvider.id,
              providerName: currentProvider.name,
              statusCode: statusCode,
              error: errorMessage,
              attemptNumber: attemptCount,
              totalProvidersAttempted,
              willRetry,
            });

            // 获取熔断器健康信息（用于决策链显示）
            const { health, config } = await getProviderHealthInfo(currentProvider.id);

            // 记录到决策链
            session.addProviderToChain(currentProvider, {
              reason: "retry_failed",
              circuitState: getCircuitState(currentProvider.id),
              attemptNumber: attemptCount,
              errorMessage: errorMessage,
              circuitFailureCount: health.failureCount + 1, // 包含本次失败
              circuitFailureThreshold: config.failureThreshold,
              statusCode: statusCode,
              errorDetails: {
                provider: {
                  id: currentProvider.id,
                  name: currentProvider.name,
                  statusCode: statusCode,
                  statusText: proxyError.message,
                  upstreamBody: proxyError.upstreamError?.body,
                  upstreamParsed: proxyError.upstreamError?.parsed,
                },
                request: buildRequestDetails(session),
              },
            });

            // 未耗尽重试次数：等待 100ms 后继续重试当前供应商
            if (willRetry) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }

            // ⭐ 重试耗尽：只有非探测请求才计入熔断器
            if (session.isProbeRequest()) {
              logger.debug("ProxyForwarder: Probe request error, skipping circuit breaker", {
                providerId: currentProvider.id,
                providerName: currentProvider.name,
                messagesCount: session.getMessagesLength(),
              });
            } else {
              await recordFailure(currentProvider.id, lastError);
            }

            // 加入失败列表并切换供应商
            failedProviderIds.push(currentProvider.id);
            break; // ⭐ 跳出内层循环，进入供应商切换逻辑
          }
        }
      } // ========== 内层循环结束 ==========

      // ========== 供应商切换逻辑 ==========
      const alternativeProvider = await ProxyForwarder.selectAlternative(
        session,
        failedProviderIds
      );

      if (!alternativeProvider) {
        // ⭐ 无可用供应商：所有供应商都失败了
        logger.error("ProxyForwarder: All providers failed", {
          totalProvidersAttempted,
          failedProviderCount: failedProviderIds.length,
          // 不记录详细供应商列表（安全考虑）
        });
        break; // 退出外层循环
      }

      // 切换到新供应商
      currentProvider = alternativeProvider;
      session.setProvider(currentProvider);

      logger.info("ProxyForwarder: Switched to alternative provider", {
        totalProvidersAttempted,
        newProviderId: currentProvider.id,
        newProviderName: currentProvider.name,
      });

      // ⭐ 继续外层循环（尝试新供应商）
    } // ========== 外层循环结束 ==========

    // ========== 所有供应商都失败：抛出简化错误 ==========
    // ⭐ 检查是否达到保险栓上限
    if (totalProvidersAttempted >= MAX_PROVIDER_SWITCHES) {
      logger.error("ProxyForwarder: Exceeded max provider switches (safety limit)", {
        totalProvidersAttempted,
        maxSwitches: MAX_PROVIDER_SWITCHES,
        failedProviderCount: failedProviderIds.length,
      });
    }

    // ⭐ 不暴露供应商详情，仅返回简单错误
    throw new ProxyError("所有供应商暂时不可用，请稍后重试", 503); // Service Unavailable
  }

  /**
   * 实际转发请求
   */
  private static async doForward(
    session: ProxySession,
    provider: typeof session.provider
  ): Promise<Response> {
    if (!provider) {
      throw new Error("Provider is required");
    }

    const resolvedCacheTtl = resolveCacheTtlPreference(
      session.authState?.key?.cacheTtlPreference,
      provider.cacheTtlPreference
    );
    session.setCacheTtlResolved(resolvedCacheTtl);

    // 解析 1M 上下文是否应用
    // 注意：此时模型重定向尚未发生，getCurrentModel() 返回原始模型
    // 1M 功能仅对 Anthropic 类型供应商有效
    const isAnthropicProvider =
      provider.providerType === "claude" || provider.providerType === "claude-auth";
    if (isAnthropicProvider) {
      const currentModel = session.getCurrentModel() || "";
      const clientRequests1m = session.clientRequestsContext1m();
      // W-007: 添加类型验证，避免类型断言
      const validPreferences = ["inherit", "force_enable", "disabled", null] as const;
      type Context1mPref = (typeof validPreferences)[number];
      const rawPref = provider.context1mPreference;
      const context1mPref: Context1mPref = validPreferences.includes(rawPref as Context1mPref)
        ? (rawPref as Context1mPref)
        : null;
      const context1mApplied = shouldApplyContext1m(context1mPref, currentModel, clientRequests1m);
      session.setContext1mApplied(context1mApplied);
    }

    // 应用模型重定向（如果配置了）
    const wasRedirected = ModelRedirector.apply(session, provider);
    if (wasRedirected) {
      logger.debug("ProxyForwarder: Model redirected", {
        providerId: provider.id,
      });
    }

    let proxyUrl: string;
    let processedHeaders: Headers;
    let requestBody: BodyInit | undefined;
    let isStreaming = false;

    // --- GEMINI HANDLING ---
    if (provider.providerType === "gemini" || provider.providerType === "gemini-cli") {
      // 1. 直接透传请求体（不转换）
      const bodyString = JSON.stringify(session.request.message);
      requestBody = bodyString;

      // 检测流式请求：Gemini 支持两种方式
      // 1. URL 路径检测（官方 Gemini API）: /v1beta/models/xxx:streamGenerateContent?alt=sse
      // 2. 请求体 stream 字段（某些兼容 API）: { stream: true }
      const geminiPathname = session.requestUrl.pathname || "";
      const geminiSearchParams = session.requestUrl.searchParams;
      const originalBody = session.request.message as Record<string, unknown>;
      isStreaming =
        geminiPathname.includes("streamGenerateContent") ||
        geminiSearchParams.get("alt") === "sse" ||
        originalBody?.stream === true;

      // 2. 准备认证和 Headers
      const accessToken = await GeminiAuth.getAccessToken(provider.key);
      const isApiKey = GeminiAuth.isApiKey(provider.key);

      const headers = new Headers();
      headers.set("Content-Type", "application/json");

      // ⭐ 统一禁用 gzip 压缩（不仅限于流式请求）
      // 原因：undici（Node.js fetch）在连接提前关闭时会对不完整的 gzip 流抛出 "TypeError: terminated"
      // Bun 的 fetch 实现更宽松，不会报错，这导致 bun dev 正常但 Docker 构建后失败
      // 参考：Gunzip.emit → emitErrorNT → emitErrorCloseNT 错误链
      headers.set("accept-encoding", "identity");

      if (isApiKey) {
        headers.set(GEMINI_PROTOCOL.HEADERS.API_KEY, accessToken);
      } else {
        headers.set("Authorization", `Bearer ${accessToken}`);
      }

      // CLI specific headers
      if (provider.providerType === "gemini-cli") {
        headers.set(GEMINI_PROTOCOL.HEADERS.API_CLIENT, "GeminiCLI/1.0");
      }

      // 3. 直接透传：使用 buildProxyUrl() 拼接原始路径和查询参数
      // 注意：Gemini CLI 支持用 `?key=` 携带 Hub API Key（用于鉴权到本服务）。
      // 转发到上游时必须移除该参数，避免把 Hub Key 透传给第三方/上游日志/代理链路。
      const baseUrl =
        provider.url ||
        (provider.providerType === "gemini"
          ? GEMINI_PROTOCOL.OFFICIAL_ENDPOINT
          : GEMINI_PROTOCOL.CLI_ENDPOINT);

      const upstreamRequestUrl = new URL(session.requestUrl.href);
      upstreamRequestUrl.searchParams.delete("key");

      proxyUrl = buildProxyUrl(baseUrl, upstreamRequestUrl);
      processedHeaders = headers;

      if (session.sessionId) {
        void SessionManager.storeSessionRequestHeaders(
          session.sessionId,
          processedHeaders,
          session.requestSequence
        ).catch((err) => logger.error("Failed to store request headers:", err));
      }

      logger.debug("ProxyForwarder: Gemini request passthrough", {
        providerId: provider.id,
        type: provider.providerType,
        url: sanitizeUrl(proxyUrl),
        originalPath: session.requestUrl.pathname,
        isStreaming,
        isApiKey,
      });
    } else {
      // --- STANDARD HANDLING ---
      // 请求格式转换（基于 client 格式和 provider 类型）
      const fromFormat: Format = mapClientFormatToTransformer(session.originalFormat);
      const toFormat: Format | null = provider.providerType
        ? mapProviderTypeToTransformer(provider.providerType)
        : null;

      if (fromFormat !== toFormat && fromFormat && toFormat) {
        try {
          const transformed = defaultRegistry.transformRequest(
            fromFormat,
            toFormat,
            session.request.model || "",
            session.request.message,
            true // 假设所有请求都是流式的
          );

          logger.debug("ProxyForwarder: Request format transformed", {
            from: fromFormat,
            to: toFormat,
            model: session.request.model,
          });

          // 更新 session 中的请求体
          session.request.message = transformed;
        } catch (error) {
          logger.error("ProxyForwarder: Request transformation failed", {
            from: fromFormat,
            to: toFormat,
            error,
          });
          // 转换失败时继续使用原始请求
        }
      }

      if (
        resolvedCacheTtl &&
        (provider.providerType === "claude" || provider.providerType === "claude-auth")
      ) {
        const applied = applyCacheTtlOverrideToMessage(session.request.message, resolvedCacheTtl);
        if (applied) {
          logger.info("ProxyForwarder: Applied cache TTL override to request", {
            providerId: provider.id,
            providerName: provider.name,
            cacheTtl: resolvedCacheTtl,
          });
        }
      }

      // Codex 请求清洗（即使格式相同也要执行，除非是官方客户端）
      if (toFormat === "codex") {
        const isOfficialClient = isOfficialCodexClient(session.userAgent);
        const log = isOfficialClient ? logger.debug.bind(logger) : logger.info.bind(logger);

        log("[ProxyForwarder] Normalizing Codex request for upstream compatibility", {
          userAgent: session.userAgent || "N/A",
          providerId: provider.id,
          providerName: provider.name,
          officialClient: isOfficialClient,
        });

        if (isOfficialClient) {
          logger.debug("[ProxyForwarder] Bypassing sanitizer for official Codex CLI client", {
            providerId: provider.id,
            providerName: provider.name,
          });
        } else {
          try {
            const sanitized = await sanitizeCodexRequest(
              session.request.message as Record<string, unknown>,
              session.request.model || "gpt-5-codex",
              undefined,
              undefined,
              { isOfficialClient }
            );

            const instructionsLength =
              typeof sanitized.instructions === "string" ? sanitized.instructions.length : 0;

            if (!instructionsLength) {
              logger.debug("[ProxyForwarder] Codex request has no instructions (passthrough)", {
                providerId: provider.id,
                officialClient: isOfficialClient,
              });
            }

            session.request.message = sanitized;

            logger.debug("[ProxyForwarder] Codex request sanitized", {
              instructionsLength,
              hasParallelToolCalls: sanitized.parallel_tool_calls,
              hasStoreFlag: sanitized.store,
            });
          } catch (error) {
            logger.error("[ProxyForwarder] Failed to sanitize Codex request, using original", {
              error,
              providerId: provider.id,
            });
          }
        }
      }

      if (
        resolvedCacheTtl &&
        (provider.providerType === "claude" || provider.providerType === "claude-auth")
      ) {
        const applied = applyCacheTtlOverrideToMessage(session.request.message, resolvedCacheTtl);
        if (applied) {
          logger.debug("ProxyForwarder: Applied cache TTL override to request", {
            providerId: provider.id,
            ttl: resolvedCacheTtl,
          });
        }
      }

      processedHeaders = ProxyForwarder.buildHeaders(session, provider);

      if (session.sessionId) {
        void SessionManager.storeSessionRequestHeaders(
          session.sessionId,
          processedHeaders,
          session.requestSequence
        ).catch((err) => logger.error("Failed to store request headers:", err));
      }

      if (process.env.NODE_ENV === "development") {
        logger.trace("ProxyForwarder: Final request headers", {
          provider: provider.name,
          providerType: provider.providerType,
          headers: Object.fromEntries(processedHeaders.entries()),
        });
      }

      // ⭐ MCP 透传处理：检测是否为 MCP 请求，并使用相应的 URL
      let effectiveBaseUrl = provider.url;

      // 检测是否为 MCP 请求（非标准 Claude/Codex/OpenAI 端点）
      const requestPath = session.requestUrl.pathname;
      // pathname does not include query params, so exact match is sufficient
      const isStandardRequest = STANDARD_ENDPOINTS.includes(requestPath);
      const isMcpRequest = !isStandardRequest;

      if (isMcpRequest && provider.mcpPassthroughType && provider.mcpPassthroughType !== "none") {
        // MCP 透传已启用，且当前是 MCP 请求
        if (provider.mcpPassthroughUrl) {
          // 使用配置的 MCP URL
          effectiveBaseUrl = provider.mcpPassthroughUrl;
          logger.debug("ProxyForwarder: Using configured MCP passthrough URL", {
            providerId: provider.id,
            providerName: provider.name,
            mcpType: provider.mcpPassthroughType,
            configuredUrl: provider.mcpPassthroughUrl,
            requestPath,
          });
        } else {
          // 自动从 provider.url 提取基础域名（去掉路径部分）
          // 例如：https://api.minimaxi.com/anthropic -> https://api.minimaxi.com
          try {
            const baseUrlObj = new URL(provider.url);
            effectiveBaseUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}`;
            logger.debug("ProxyForwarder: Extracted base domain for MCP passthrough", {
              providerId: provider.id,
              providerName: provider.name,
              mcpType: provider.mcpPassthroughType,
              originalUrl: provider.url,
              extractedBaseDomain: effectiveBaseUrl,
              requestPath,
            });
          } catch (error) {
            logger.error("ProxyForwarder: Invalid provider URL for MCP passthrough", {
              providerId: provider.id,
              providerUrl: provider.url,
              error,
            });
            throw new ProxyError("Internal configuration error", 500);
          }
        }
      } else if (
        isMcpRequest &&
        (!provider.mcpPassthroughType || provider.mcpPassthroughType === "none")
      ) {
        // MCP 请求但未启用 MCP 透传
        logger.debug(
          "ProxyForwarder: MCP request but passthrough not enabled, using provider URL",
          {
            providerId: provider.id,
            providerName: provider.name,
            requestPath,
          }
        );
      }

      // ⭐ 直接使用原始请求路径，让 buildProxyUrl() 智能处理路径拼接
      // 移除了强制 /v1/responses 路径重写，解决 Issue #139
      // buildProxyUrl() 会检测 base_url 是否已包含完整路径，避免重复拼接
      proxyUrl = buildProxyUrl(effectiveBaseUrl, session.requestUrl);

      logger.debug("ProxyForwarder: Final proxy URL", {
        url: sanitizeUrl(proxyUrl),
        originalPath: session.requestUrl.pathname,
        providerType: provider.providerType,
        mcpPassthroughType: provider.mcpPassthroughType,
        usedBaseUrl: sanitizeUrl(effectiveBaseUrl),
      });

      const hasBody = session.method !== "GET" && session.method !== "HEAD";

      if (hasBody) {
        const filteredMessage = filterPrivateParameters(session.request.message);
        const bodyString = JSON.stringify(filteredMessage);
        requestBody = bodyString;

        try {
          const parsed = JSON.parse(bodyString);
          isStreaming = parsed.stream === true;
        } catch {
          isStreaming = false;
        }

        if (process.env.NODE_ENV === "development") {
          logger.trace("ProxyForwarder: Forwarding request", {
            provider: provider.name,
            providerId: provider.id,
            proxyUrl: sanitizeUrl(proxyUrl),
            format: session.originalFormat,
            method: session.method,
            bodyLength: bodyString.length,
            bodyPreview: bodyString.slice(0, 1000),
            isStreaming,
          });
        }
      }
    }

    // ⭐ 扩展 RequestInit 类型以支持 undici dispatcher
    interface UndiciFetchOptions extends RequestInit {
      dispatcher?: Dispatcher;
    }

    // ⭐ 双路超时控制（first-byte / total）
    // 注意：由于 undici fetch API 的限制，无法精确分离 DNS/TCP/TLS 连接阶段和响应头接收阶段
    // 参考：https://github.com/nodejs/undici/discussions/1313
    // 1. 首包/总响应超时：根据请求类型选择
    const responseController = new AbortController();
    let responseTimeoutMs: number;
    let responseTimeoutType: string;

    if (isStreaming) {
      // 流式请求：使用首字节超时（快速失败）
      responseTimeoutMs =
        provider.firstByteTimeoutStreamingMs > 0 ? provider.firstByteTimeoutStreamingMs : 0;
      responseTimeoutType = "streaming_first_byte";
    } else {
      // 非流式请求：使用总超时（防止无限挂起）
      responseTimeoutMs =
        provider.requestTimeoutNonStreamingMs > 0 ? provider.requestTimeoutNonStreamingMs : 0;
      responseTimeoutType = "non_streaming_total";
    }

    let responseTimeoutId: NodeJS.Timeout | null = null;
    if (responseTimeoutMs > 0) {
      responseTimeoutId = setTimeout(() => {
        responseController.abort();
        logger.warn("ProxyForwarder: Response timeout", {
          providerId: provider.id,
          providerName: provider.name,
          responseTimeoutMs,
          responseTimeoutType,
          isStreaming,
        });
      }, responseTimeoutMs);
    } else {
      logger.debug("ProxyForwarder: Response timeout disabled", {
        providerId: provider.id,
        providerName: provider.name,
        responseTimeoutType,
      });
    }

    // 2. 组合双路信号：response + client
    let combinedSignal: AbortSignal | undefined;
    const signals = [responseController.signal];
    if (session.clientAbortSignal) {
      signals.push(session.clientAbortSignal);
    }

    // ⭐ AbortSignal.any 实现（兼容所有环境）
    // 原因：Next.js standalone 可能覆盖全局 AbortSignal，导致原生 any 方法不可用
    if ("any" in AbortSignal && typeof AbortSignal.any === "function") {
      // 优先使用原生实现（Node.js 20.3+）
      combinedSignal = AbortSignal.any(signals);
      logger.debug("ProxyForwarder: Using native AbortSignal.any", {
        signalCount: signals.length,
      });
    } else {
      // Polyfill: 手动实现多信号组合逻辑
      logger.debug("ProxyForwarder: Using AbortSignal.any polyfill", {
        signalCount: signals.length,
        reason: "Native AbortSignal.any not available",
      });

      const combinedController = new AbortController();
      const cleanupHandlers: Array<() => void> = [];

      // 为每个信号添加监听器
      for (const signal of signals) {
        // 如果已经有信号中断，立即中断组合信号
        if (signal.aborted) {
          combinedController.abort();
          break;
        }

        // 监听信号中断事件
        const abortHandler = () => {
          // 中断组合信号
          combinedController.abort();
          // 清理所有监听器（避免内存泄漏）
          cleanupHandlers.forEach((cleanup) => cleanup());
        };

        signal.addEventListener("abort", abortHandler, { once: true });

        // 记录清理函数
        cleanupHandlers.push(() => {
          signal.removeEventListener("abort", abortHandler);
        });
      }

      combinedSignal = combinedController.signal;
    }

    const init: UndiciFetchOptions = {
      method: session.method,
      headers: processedHeaders,
      signal: combinedSignal, // 使用组合信号
      ...(requestBody ? { body: requestBody } : {}),
    };

    // ⭐ 获取 HTTP/2 全局开关设置
    const enableHttp2 = await isHttp2Enabled();

    // ⭐ 应用代理配置（如果配置了）
    const proxyConfig = createProxyAgentForProvider(provider, proxyUrl, enableHttp2);
    if (proxyConfig) {
      init.dispatcher = proxyConfig.agent;
      logger.info("ProxyForwarder: Using proxy", {
        providerId: provider.id,
        providerName: provider.name,
        proxyUrl: sanitizeUrl(proxyConfig.proxyUrl),
        fallbackToDirect: proxyConfig.fallbackToDirect,
        targetUrl: new URL(proxyUrl).origin,
        http2Enabled: proxyConfig.http2Enabled,
      });
    } else if (enableHttp2) {
      // 直连场景：创建支持 HTTP/2 的 Agent
      init.dispatcher = new Agent({ allowH2: true });
      logger.debug("ProxyForwarder: Using HTTP/2 Agent for direct connection", {
        providerId: provider.id,
        providerName: provider.name,
      });
    }

    (init as Record<string, unknown>).verbose = true;

    // ⭐ 始终使用容错流处理以减少 "TypeError: terminated" 错误
    // 背景：undici fetch 的自动解压在流被提前终止时会抛出 "TypeError: terminated"
    // 这个问题不仅影响 Gemini，也影响 Codex 和其他所有供应商
    // 使用 fetchWithoutAutoDecode 绕过 undici 的自动解压，手动处理 gzip
    // 并通过 nodeStreamToWebStreamSafe 实现容错流转换（捕获错误并优雅关闭）
    const useErrorTolerantFetch = true;

    let response: Response;
    const fetchStartTime = Date.now();
    try {
      // ⭐ 所有供应商使用 undici.request 绕过 fetch 的自动解压
      // 原因：undici fetch 无法关闭自动解压，上游可能无视 accept-encoding: identity 返回 gzip
      // 当 gzip 流被提前终止时（如连接关闭），undici Gunzip 会抛出 "TypeError: terminated"
      response = useErrorTolerantFetch
        ? await ProxyForwarder.fetchWithoutAutoDecode(
            proxyUrl,
            init,
            provider.id,
            provider.name,
            session
          )
        : await fetch(proxyUrl, init);
      // ⭐ fetch 成功：收到 HTTP 响应头，保留响应超时继续监控
      // 注意：undici 的 fetch 在收到 HTTP 响应头后就 resolve，但实际数据（SSE 首字节 / 完整 JSON）
      // 还没到达。responseTimeoutId 需要延续到 response-handler 中才能真正控制"首字节"或"总耗时"
      const headersDuration = Date.now() - fetchStartTime;
      logger.debug("ProxyForwarder: HTTP headers received", {
        providerId: provider.id,
        providerName: provider.name,
        headersReceivedMs: headersDuration,
        note: "Response timeout continues to monitor body reading",
      });
      // ⚠️ 不要清除 responseTimeoutId！让它继续监控响应体读取
    } catch (fetchError) {
      // ⭐ fetch 失败：清除所有超时定时器
      if (responseTimeoutId) {
        clearTimeout(responseTimeoutId);
      }

      // 捕获 fetch 原始错误（网络错误、DNS 解析失败、连接失败等）
      const err = fetchError as Error & {
        cause?: unknown;
        code?: string; // Node.js 错误码：如 'ENOTFOUND'、'ECONNREFUSED'、'ETIMEDOUT'、'ECONNRESET'
        errno?: number;
        syscall?: string; // 系统调用：如 'getaddrinfo'、'connect'、'read'、'write'
      };

      // ⭐ 超时错误检测（优先级：response > client）

      if (responseController.signal.aborted && !session.clientAbortSignal?.aborted) {
        // 响应超时：HTTP 首包未在规定时间内到达
        // 修复：首字节超时应归类为供应商问题，计入熔断器并直接切换
        logger.error("ProxyForwarder: Response timeout (provider quality issue, will switch)", {
          providerId: provider.id,
          providerName: provider.name,
          responseTimeoutMs,
          responseTimeoutType,
          isStreaming,
          errorName: err.name,
          errorMessage: err.message || "(empty message)",
          reason:
            "First-byte timeout indicates slow provider response, should count towards circuit breaker",
        });

        // 抛出 ProxyError 并设置特殊状态码 524（Cloudflare: A Timeout Occurred）
        // 这样会被归类为 PROVIDER_ERROR，计入熔断器并直接切换供应商
        throw new ProxyError(
          `${responseTimeoutType === "streaming_first_byte" ? "供应商首字节响应超时" : "供应商响应超时"}: ${responseTimeoutMs}ms 内未收到数据`,
          524, // 524 = A Timeout Occurred (Cloudflare standard)
          {
            body: JSON.stringify({
              error: {
                type: "timeout_error",
                message: `Provider failed to respond within ${responseTimeoutMs}ms`,
                timeout_type: responseTimeoutType,
                timeout_ms: responseTimeoutMs,
              },
            }),
            parsed: {
              error: {
                type: "timeout_error",
                message: `Provider failed to respond within ${responseTimeoutMs}ms`,
                timeout_type: responseTimeoutType,
                timeout_ms: responseTimeoutMs,
              },
            },
            providerId: provider.id,
            providerName: provider.name,
          }
        );
      }

      // ⭐ 检测流式静默期超时（streaming_idle）
      if (err.message?.includes("streaming_idle") && !session.clientAbortSignal?.aborted) {
        // 流式静默期超时：首字节之后的连续静默窗口超时
        // 修复：静默期超时也是供应商问题，应计入熔断器
        logger.error(
          "ProxyForwarder: Streaming idle timeout (provider quality issue, will switch)",
          {
            providerId: provider.id,
            providerName: provider.name,
            idleTimeoutMs: provider.streamingIdleTimeoutMs,
            errorName: err.name,
            errorMessage: err.message || "(empty message)",
            errorCode: err.code || "N/A",
            reason:
              "Idle timeout indicates provider stopped sending data, should count towards circuit breaker",
          }
        );

        // 抛出 ProxyError（归类为 PROVIDER_ERROR）
        throw new ProxyError(
          `供应商流式响应静默超时: ${provider.streamingIdleTimeoutMs}ms 内未收到新数据`,
          524, // 524 = A Timeout Occurred
          {
            body: JSON.stringify({
              error: {
                type: "streaming_idle_timeout",
                message: `Provider stopped sending data for ${provider.streamingIdleTimeoutMs}ms`,
                timeout_ms: provider.streamingIdleTimeoutMs,
              },
            }),
            parsed: {
              error: {
                type: "streaming_idle_timeout",
                message: `Provider stopped sending data for ${provider.streamingIdleTimeoutMs}ms`,
                timeout_ms: provider.streamingIdleTimeoutMs,
              },
            },
            providerId: provider.id,
            providerName: provider.name,
          }
        );
      }

      // ⭐ 检测客户端主动中断（使用统一的精确检测函数）
      if (isClientAbortError(err)) {
        logger.warn("ProxyForwarder: Request/response aborted", {
          providerId: provider.id,
          providerName: provider.name,
          proxyUrl: new URL(proxyUrl).origin,
          errorName: err.name,
          errorMessage: err.message || "(empty message)",
          errorCode: err.code || "N/A",
        });

        // 客户端中断不应计入熔断器，也不重试，直接抛出错误
        throw new ProxyError(
          err.name === "ResponseAborted"
            ? "Response transmission aborted"
            : "Request aborted by client",
          499 // Nginx 使用的 "Client Closed Request" 状态码
        );
      }

      // ⭐ HTTP/2 协议错误检测与透明回退
      // 场景：HTTP/2 连接失败（GOAWAY、RST_STREAM、PROTOCOL_ERROR 等）
      // 策略：透明回退到 HTTP/1.1，不触发供应商切换或熔断器
      if (enableHttp2 && isHttp2Error(err)) {
        logger.warn("ProxyForwarder: HTTP/2 protocol error detected, falling back to HTTP/1.1", {
          providerId: provider.id,
          providerName: provider.name,
          errorName: err.name,
          errorMessage: err.message || "(empty message)",
          errorCode: err.code || "N/A",
        });

        // 记录到决策链（标记为 HTTP/2 回退）
        session.addProviderToChain(provider, {
          reason: "http2_fallback",
          circuitState: getCircuitState(provider.id),
          attemptNumber: 1,
          errorMessage: `HTTP/2 error: ${err.message}`,
          errorDetails: {
            system: {
              errorType: "Http2Error",
              errorName: err.name,
              errorMessage: err.message || err.name || "HTTP/2 protocol error",
              errorCode: err.code,
              errorStack: err.stack?.split("\n").slice(0, 3).join("\n"),
            },
            // W-011: 添加 request 字段以保持与其他错误处理一致
            request: buildRequestDetails(session),
          },
        });

        // 创建 HTTP/1.1 回退配置（移除 HTTP/2 Agent）
        const http1FallbackInit = { ...init };
        delete http1FallbackInit.dispatcher;

        // 如果使用了代理，创建不支持 HTTP/2 的代理 Agent
        if (proxyConfig) {
          const http1ProxyConfig = createProxyAgentForProvider(provider, proxyUrl, false);
          if (http1ProxyConfig) {
            http1FallbackInit.dispatcher = http1ProxyConfig.agent;
          }
        }

        try {
          // 使用 HTTP/1.1 重试
          response = useErrorTolerantFetch
            ? await ProxyForwarder.fetchWithoutAutoDecode(
                proxyUrl,
                http1FallbackInit,
                provider.id,
                provider.name,
                session
              )
            : await fetch(proxyUrl, http1FallbackInit);

          logger.info("ProxyForwarder: HTTP/1.1 fallback succeeded", {
            providerId: provider.id,
            providerName: provider.name,
          });

          // 重新启动响应超时计时器（如果之前有配置超时时间）
          // 注意：responseTimeoutId 在 catch 块开头已被清除，这里只需检查 responseTimeoutMs
          if (responseTimeoutMs > 0) {
            responseTimeoutId = setTimeout(() => {
              responseController.abort();
              logger.warn("ProxyForwarder: Response timeout after HTTP/1.1 fallback", {
                providerId: provider.id,
                providerName: provider.name,
                responseTimeoutMs,
              });
            }, responseTimeoutMs);
          }

          // 成功后跳过 throw，继续执行后续逻辑（不计入熔断器）
        } catch (http1Error) {
          // HTTP/1.1 也失败，记录并抛出原始错误
          logger.error("ProxyForwarder: HTTP/1.1 fallback also failed", {
            providerId: provider.id,
            providerName: provider.name,
            http1Error: http1Error instanceof Error ? http1Error.message : String(http1Error),
          });

          // 抛出 HTTP/1.1 错误，让正常的错误处理流程处理
          throw http1Error;
        }
      } else if (proxyConfig) {
        const isProxyError =
          err.message.includes("proxy") ||
          err.message.includes("ECONNREFUSED") ||
          err.message.includes("ENOTFOUND") ||
          err.message.includes("ETIMEDOUT");

        if (isProxyError) {
          logger.error("ProxyForwarder: Proxy connection failed", {
            providerId: provider.id,
            providerName: provider.name,
            proxyUrl: sanitizeUrl(proxyConfig.proxyUrl),
            fallbackToDirect: proxyConfig.fallbackToDirect,
            errorType: err.constructor.name,
            errorMessage: err.message,
            errorCode: err.code,
          });

          // 如果配置了降级到直连，尝试不使用代理
          if (proxyConfig.fallbackToDirect) {
            logger.warn("ProxyForwarder: Falling back to direct connection", {
              providerId: provider.id,
              providerName: provider.name,
            });

            // 创建新的配置对象，不包含 dispatcher
            const fallbackInit = { ...init };
            delete fallbackInit.dispatcher;
            try {
              response = await fetch(proxyUrl, fallbackInit);
              logger.info("ProxyForwarder: Direct connection succeeded after proxy failure", {
                providerId: provider.id,
                providerName: provider.name,
              });
              // 成功后跳过 throw，继续执行后续逻辑
            } catch (directError) {
              // 直连也失败，抛出原始错误
              logger.error("ProxyForwarder: Direct connection also failed", {
                providerId: provider.id,
                error: directError,
              });
              throw fetchError; // 抛出原始代理错误
            }
          } else {
            // 不降级，直接抛出代理错误
            throw new ProxyError("Service temporarily unavailable", 503);
          }
        } else {
          // 非代理相关错误，记录详细信息后抛出
          logger.error("ProxyForwarder: Fetch failed (with proxy configured)", {
            providerId: provider.id,
            providerName: provider.name,
            proxyUrl: new URL(proxyUrl).origin, // 只记录域名，隐藏查询参数和 API Key

            errorType: err.constructor.name,
            errorName: err.name,
            errorMessage: err.message,
            errorCode: err.code, // ⭐ 如 'ENOTFOUND'（DNS失败）、'ECONNREFUSED'（连接拒绝）、'ETIMEDOUT'（超时）、'ECONNRESET'（连接重置）
            errorSyscall: err.syscall, // ⭐ 如 'getaddrinfo'（DNS查询）、'connect'（TCP连接）
            errorErrno: err.errno,
            errorCause: err.cause,
            // ⭐ 增强诊断：undici 参数验证错误的具体说明
            errorCauseMessage: (err.cause as Error | undefined)?.message,
            errorCauseStack: (err.cause as Error | undefined)?.stack
              ?.split("\n")
              .slice(0, 2)
              .join("\n"),
            errorStack: err.stack?.split("\n").slice(0, 3).join("\n"), // 前3行堆栈

            targetUrl: sanitizeUrl(proxyUrl), // 脱敏后的完整目标 URL（用于调试）
            headerKeys: Array.from(processedHeaders.keys()),
            headerCount: Array.from(processedHeaders.keys()).length,
            invalidHeaders: Array.from(processedHeaders.entries())
              .filter(([_, v]) => v === undefined || v === null || v === "")
              .map(([k]) => k),

            // 请求上下文
            method: session.method,
            hasBody: !!requestBody,
            bodySize: requestBody ? JSON.stringify(requestBody).length : 0,
          });

          throw fetchError;
        }
      } else {
        // 未使用代理，原有错误处理逻辑
        logger.error("ProxyForwarder: Fetch failed", {
          providerId: provider.id,
          providerName: provider.name,
          proxyUrl: new URL(proxyUrl).origin, // 只记录域名，隐藏查询参数和 API Key

          // ⭐ 详细错误信息（关键诊断字段）
          errorType: err.constructor.name,
          errorName: err.name,
          errorMessage: err.message,
          errorCode: err.code, // ⭐ 如 'ENOTFOUND'（DNS失败）、'ECONNREFUSED'（连接拒绝）、'ETIMEDOUT'（超时）、'ECONNRESET'（连接重置）
          errorSyscall: err.syscall, // ⭐ 如 'getaddrinfo'（DNS查询）、'connect'（TCP连接）
          errorErrno: err.errno,
          errorCause: err.cause,
          // ⭐ 增强诊断：undici 参数验证错误的具体说明
          errorCauseMessage: (err.cause as Error | undefined)?.message,
          errorCauseStack: (err.cause as Error | undefined)?.stack
            ?.split("\n")
            .slice(0, 2)
            .join("\n"),
          errorStack: err.stack?.split("\n").slice(0, 3).join("\n"), // 前3行堆栈

          targetUrl: sanitizeUrl(proxyUrl), // 脱敏后的完整目标 URL（用于调试）
          headerKeys: Array.from(processedHeaders.keys()),
          headerCount: Array.from(processedHeaders.keys()).length,
          invalidHeaders: Array.from(processedHeaders.entries())
            .filter(([_, v]) => v === undefined || v === null || v === "")
            .map(([k]) => k),

          // 请求上下文
          method: session.method,
          hasBody: !!requestBody,
          bodySize: requestBody ? JSON.stringify(requestBody).length : 0,
        });

        throw fetchError;
      }
    }

    // 检查 HTTP 错误状态（4xx/5xx 均视为失败，触发重试）
    // 注意：用户要求所有 4xx 都重试，包括 401、403、429 等
    if (!response.ok) {
      // HTTP 错误：清除响应超时定时器
      if (responseTimeoutId) {
        clearTimeout(responseTimeoutId);
      }
      throw await ProxyError.fromUpstreamResponse(response, {
        id: provider.id,
        name: provider.name,
      });
    }

    // 将响应超时清理函数和 controller 引用附加到 session，供 response-handler 使用
    // response-handler 会在读到首字节（流式）或完整响应（非流式）后调用此函数
    const sessionWithTimeout = session as ProxySession & {
      clearResponseTimeout?: () => void;
      responseController?: AbortController;
    };

    sessionWithTimeout.clearResponseTimeout = () => {
      if (responseTimeoutId) {
        clearTimeout(responseTimeoutId);
      }
      logger.debug("ProxyForwarder: Response timeout cleared by response-handler", {
        providerId: provider.id,
        responseTimeoutMs,
        responseTimeoutType,
      });
    };

    // 传递 responseController 引用，让 response-handler 能区分超时和客户端中断
    sessionWithTimeout.responseController = responseController;

    return response;
  }

  /**
   * 选择替代供应商（排除所有已失败的供应商）
   */
  private static async selectAlternative(
    session: ProxySession,
    excludeProviderIds: number[] // 改为数组，排除所有失败的供应商
  ): Promise<typeof session.provider | null> {
    // 使用公开的选择方法，传入排除列表
    const alternativeProvider = await ProxyProviderResolver.pickRandomProviderWithExclusion(
      session,
      excludeProviderIds
    );

    if (!alternativeProvider) {
      logger.warn("ProxyForwarder: No alternative provider available", {
        excludedProviders: excludeProviderIds,
      });
      return null;
    }

    // 确保不是已失败的供应商之一
    if (excludeProviderIds.includes(alternativeProvider.id)) {
      logger.error("ProxyForwarder: Selector returned excluded provider", {
        providerId: alternativeProvider.id,
        message: "This should not happen",
      });
      return null;
    }

    return alternativeProvider;
  }

  private static buildHeaders(
    session: ProxySession,
    provider: NonNullable<typeof session.provider>
  ): Headers {
    const outboundKey = provider.key;
    const preserveClientIp = provider.preserveClientIp ?? false;
    const { clientIp, xForwardedFor } = ProxyForwarder.resolveClientIp(session.headers);

    // 构建请求头覆盖规则
    const overrides: Record<string, string> = {
      host: HeaderProcessor.extractHost(provider.url),
      authorization: `Bearer ${outboundKey}`,
      "x-api-key": outboundKey,
      "content-type": "application/json", // 确保 Content-Type
      "accept-encoding": "identity", // 禁用压缩：避免 undici ZlibError（代理应透传原始数据）
    };

    // claude-auth: 移除 x-api-key（避免中转服务冲突）
    if (provider.providerType === "claude-auth") {
      delete overrides["x-api-key"];
    }

    // Codex 特殊处理：优先使用过滤器修改的 User-Agent
    if (provider.providerType === "codex") {
      const filteredUA = session.headers.get("user-agent");
      const originalUA = session.userAgent;
      const wasModified = session.isHeaderModified("user-agent");

      // 优先级说明：
      // 1. 如果过滤器修改了 user-agent（wasModified=true），使用过滤后的值
      // 2. 如果过滤器删除了 user-agent（wasModified=true 但 filteredUA=null），回退到原始 UA
      // 3. 如果原始 UA 也不存在，使用硬编码兜底值
      // 注意：使用 ?? 而非 || 以确保空字符串 UA 能被正确保留
      let resolvedUA: string;
      if (wasModified) {
        resolvedUA =
          filteredUA ?? originalUA ?? "codex_cli_rs/0.55.0 (Mac OS 26.1.0; arm64) vscode/2.0.64";
      } else {
        resolvedUA = originalUA ?? "codex_cli_rs/0.55.0 (Mac OS 26.1.0; arm64) vscode/2.0.64";
      }
      overrides["user-agent"] = resolvedUA;

      logger.debug("ProxyForwarder: Codex provider User-Agent resolution", {
        wasModified,
        hasFilteredUA: !!filteredUA,
        hasOriginalUA: !!originalUA,
        finalValueLength: resolvedUA.length,
      });
    }

    if (preserveClientIp) {
      if (xForwardedFor) {
        overrides["x-forwarded-for"] = xForwardedFor;
      }
      if (clientIp) {
        overrides["x-real-ip"] = clientIp;
      }
    }

    // 针对 1h 缓存 TTL，补充 Anthropic beta header（避免客户端遗漏）
    if (session.getCacheTtlResolved && session.getCacheTtlResolved() === "1h") {
      const existingBeta = session.headers.get("anthropic-beta") || "";
      const betaFlags = new Set(
        existingBeta
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      betaFlags.add("extended-cache-ttl-2025-04-11");
      // 确保包含基础的 prompt-caching 标记
      if (betaFlags.size === 1) {
        betaFlags.add("prompt-caching-2024-07-31");
      }
      overrides["anthropic-beta"] = Array.from(betaFlags).join(", ");
    }

    // 针对 1M 上下文，补充 Anthropic beta header
    // 逻辑：根据供应商 context1mPreference 决定是否应用 1M 上下文
    // - 'disabled': 不应用（已在调度阶段被过滤）
    // - 'force_enable': 强制应用（仅对支持的模型）
    // - 'inherit' 或 null: 遵循客户端请求
    if (session.getContext1mApplied?.()) {
      const existingBeta =
        overrides["anthropic-beta"] || session.headers.get("anthropic-beta") || "";
      const betaFlags = new Set(
        existingBeta
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      betaFlags.add(CONTEXT_1M_BETA_HEADER);
      overrides["anthropic-beta"] = Array.from(betaFlags).join(", ");
    }

    const headerProcessor = HeaderProcessor.createForProxy({
      blacklist: ["content-length", "connection"], // 删除 content-length（动态计算）和 connection（undici 自动管理）
      preserveClientIpHeaders: preserveClientIp,
      overrides,
    });

    return headerProcessor.process(session.headers);
  }

  private static resolveClientIp(headers: Headers): {
    clientIp: string | null;
    xForwardedFor: string | null;
  } {
    const xffRaw = headers.get("x-forwarded-for");
    const xffParts =
      xffRaw
        ?.split(",")
        .map((ip) => ip.trim())
        .filter(Boolean) ?? [];

    const candidateIps = [
      ...xffParts,
      headers.get("x-real-ip")?.trim(),
      headers.get("x-client-ip")?.trim(),
      headers.get("x-originating-ip")?.trim(),
      headers.get("x-remote-ip")?.trim(),
      headers.get("x-remote-addr")?.trim(),
    ].filter((ip): ip is string => !!ip);

    const clientIp = candidateIps[0] ?? null;
    const xForwardedFor = xffParts.length > 0 ? xffParts.join(", ") : clientIp;

    return { clientIp, xForwardedFor: xForwardedFor ?? null };
  }

  /**
   * 使用 undici.request 绕过 fetch 的自动解压
   *
   * 原因：Node/undici 的 fetch 会自动根据 Content-Encoding 解压响应，且无法关闭。
   * 当上游服务器忽略 accept-encoding: identity 仍返回 gzip 时，如果 gzip 流被提前终止
   * （如连接关闭），undici 的 Gunzip 会抛出 "TypeError: terminated" 错误。
   *
   * 解决方案：使用 undici.request 获取未自动解压的原始流，手动用容错方式处理 gzip。
   */
  private static async fetchWithoutAutoDecode(
    url: string,
    init: RequestInit & { dispatcher?: Dispatcher },
    providerId: number,
    providerName: string,
    session?: ProxySession
  ): Promise<Response> {
    const { FETCH_HEADERS_TIMEOUT: headersTimeout, FETCH_BODY_TIMEOUT: bodyTimeout } =
      getEnvConfig();

    logger.debug("ProxyForwarder: Using undici.request to bypass auto-decompression", {
      providerId,
      providerName,
      url: new URL(url).origin, // 只记录域名，隐藏路径和参数
      method: init.method,
      reason: "Using manual gzip handling to avoid terminated error",
    });

    // 将 Headers 对象转换为 Record<string, string>
    const headersObj: Record<string, string> = {};
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headersObj[key] = value;
      });
    } else if (init.headers && typeof init.headers === "object") {
      Object.assign(headersObj, init.headers);
    }

    // 使用 undici.request 获取未自动解压的响应
    // ⭐ 显式配置超时：确保使用非 undici 原生 dispatcher（如 SocksProxyAgent）时也能正确应用超时
    const undiciRes = await undiciRequest(url, {
      method: init.method as string,
      headers: headersObj,
      body: init.body as string | Buffer | undefined,
      signal: init.signal,
      dispatcher: init.dispatcher,
      bodyTimeout,
      headersTimeout,
    });

    // ⭐ 立即为 undici body 添加错误处理，防止 uncaughtException
    // 必须在任何其他操作之前设置，否则 ECONNRESET 等错误会导致 uncaughtException
    const rawBody = undiciRes.body as Readable;
    rawBody.on("error", (err) => {
      logger.warn("ProxyForwarder: undici body stream error (caught early)", {
        providerId,
        providerName,
        error: err.message,
        errorCode: (err as NodeJS.ErrnoException).code,
      });
    });

    // 构建响应头
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(undiciRes.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        value.forEach((v) => responseHeaders.append(key, v));
      } else {
        responseHeaders.append(key, value);
      }
    }

    if (session?.sessionId) {
      void SessionManager.storeSessionResponseHeaders(
        session.sessionId,
        responseHeaders,
        session.requestSequence
      ).catch((err) => logger.error("Failed to store response headers:", err));
    }

    // 检测响应是否为 gzip 压缩
    const encoding = responseHeaders.get("content-encoding")?.toLowerCase() || "";
    let bodyStream: ReadableStream<Uint8Array>;

    if (encoding.includes("gzip")) {
      logger.debug("ProxyForwarder: Response is gzip encoded, decompressing manually", {
        providerId,
        providerName,
        contentEncoding: encoding,
      });

      // 创建容错 Gunzip 解压器
      const gunzip = createGunzip({
        flush: zlibConstants.Z_SYNC_FLUSH,
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
      });

      // 捕获 Gunzip 错误但不抛出（容错处理）
      gunzip.on("error", (err) => {
        logger.warn("ProxyForwarder: Gunzip decompression error (ignored)", {
          providerId,
          providerName,
          error: err.message,
          note: "Partial data may be returned, but no crash",
        });
        // 尝试结束流，避免挂起
        try {
          gunzip.end();
        } catch {
          // ignore
        }
      });

      // 将 undici body (Node Readable) pipe 到 Gunzip
      // 注意：使用前面已添加错误处理器的 rawBody
      rawBody.pipe(gunzip);

      // 将 Gunzip 流转换为 Web 流（容错版本）
      bodyStream = ProxyForwarder.nodeStreamToWebStreamSafe(gunzip, providerId, providerName);

      // 移�� content-encoding 和 content-length（避免下游再解压或使用错误长度）
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
    } else {
      // 非 gzip：直接转换 Node 流为 Web 流
      logger.debug("ProxyForwarder: Response is not gzip encoded, passing through", {
        providerId,
        providerName,
        contentEncoding: encoding || "(none)",
      });
      // 注意：使用前面已添加错误处理器的 rawBody
      bodyStream = ProxyForwarder.nodeStreamToWebStreamSafe(rawBody, providerId, providerName);
    }

    logger.debug("ProxyForwarder: undici.request completed, returning wrapped response", {
      providerId,
      providerName,
      statusCode: undiciRes.statusCode,
      hasGzip: encoding.includes("gzip"),
    });

    return new Response(bodyStream, {
      status: undiciRes.statusCode,
      statusText: String(undiciRes.statusCode),
      headers: responseHeaders,
    });
  }

  /**
   * 将 Node.js Readable 流转换为 Web ReadableStream（容错版本）
   *
   * 关键特性：吞掉上游流的错误事件，避免 "terminated" 错误冒泡到调用者
   */
  private static nodeStreamToWebStreamSafe(
    nodeStream: Readable,
    providerId: number,
    providerName: string
  ): ReadableStream<Uint8Array> {
    let chunkCount = 0;
    let totalBytes = 0;

    return new ReadableStream<Uint8Array>({
      start(controller) {
        logger.debug("ProxyForwarder: Starting Node-to-Web stream conversion", {
          providerId,
          providerName,
        });

        nodeStream.on("data", (chunk: Buffer | Uint8Array) => {
          chunkCount++;
          totalBytes += chunk.length;
          try {
            const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            controller.enqueue(buf);
          } catch {
            // 如果 controller 已关闭，忽略
          }
        });

        nodeStream.on("end", () => {
          logger.debug("ProxyForwarder: Node stream ended normally", {
            providerId,
            providerName,
            chunkCount,
            totalBytes,
          });
          try {
            controller.close();
          } catch {
            // 如果已关闭，忽略
          }
        });

        nodeStream.on("close", () => {
          logger.debug("ProxyForwarder: Node stream closed", {
            providerId,
            providerName,
            chunkCount,
            totalBytes,
          });
          try {
            controller.close();
          } catch {
            // 如果已关闭，忽略
          }
        });

        // ⭐ 关键：吞掉错误事件，避免 "terminated" 冒泡
        nodeStream.on("error", (err) => {
          logger.warn("ProxyForwarder: Upstream stream error (gracefully closed)", {
            providerId,
            providerName,
            error: err.message,
            errorName: err.name,
          });
          try {
            controller.close();
          } catch {
            // 如果已关闭，忽略
          }
        });
      },

      cancel(reason) {
        try {
          nodeStream.destroy(
            reason instanceof Error ? reason : reason ? new Error(String(reason)) : undefined
          );
        } catch {
          // ignore
        }
      },
    });
  }
}
