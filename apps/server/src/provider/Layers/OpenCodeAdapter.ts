/**
 * OpenCodeAdapterLive - Scoped live implementation for the OpenCode provider adapter.
 *
 * Wraps `opencode serve` and the OpenCode HTTP/SSE API behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module OpenCodeAdapterLive
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Option, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "opencode" as const;
const GO_PROVIDER = "opencode-go" as const;
const DEFAULT_SERVER_HOST = "127.0.0.1";

const GO_MODEL_SLUGS = new Set([
  "glm-5",
  "kimi-k2.5",
  "mimo-v2-omni",
  "mimo-v2-pro",
  "minimax-m2.5",
  "minimax-m2.7",
]);

function getProviderIdForModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return GO_MODEL_SLUGS.has(model) ? GO_PROVIDER : PROVIDER;
}

type OpenCodeRuntimeMode = ProviderSession["runtimeMode"];

type OpenCodeSessionInfo = {
  readonly id: string;
  readonly title?: string;
  readonly time?: {
    readonly created?: number;
    readonly updated?: number;
  };
};

type OpenCodeMessageListEntry = {
  readonly info: {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly modelID?: string;
    readonly providerID?: string;
  };
  readonly parts: ReadonlyArray<Record<string, unknown>>;
};

type OpenCodeSendMessageResponse = {
  readonly info?: {
    readonly id?: string;
    readonly role?: string;
  };
  readonly parts?: ReadonlyArray<Record<string, unknown>>;
};

type OpenCodeTurnState = {
  readonly id: TurnId;
  userMessageId?: string;
  assistantMessageId?: string;
  previousAssistantMessageId?: string;
  assistantItemId?: string;
  assistantItemStarted?: boolean;
  assistantItemCompleted?: boolean;
  sawAssistantTextDelta?: boolean;
  sawStreamingActivity?: boolean;
  readonly items: Array<unknown>;
};

type OpenCodeContext = {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly cwd?: string | undefined;
  readonly runtimeMode: OpenCodeRuntimeMode;
  readonly createdAt: string;
  updatedAt: string;
  model?: string | undefined;
  variant?: string | undefined;
  activeTurnId?: TurnId | undefined;
  readonly turns: Array<OpenCodeTurnState>;
};

type OpenCodeAssistantItemState = Pick<
  OpenCodeTurnState,
  "assistantItemId" | "assistantItemStarted" | "assistantItemCompleted"
>;

type PendingQuestionState = {
  readonly questionIds: ReadonlyArray<string>;
  readonly questions: ReadonlyArray<UserInputQuestion>;
};

type OpenCodeEvent = Record<string, unknown>;

export interface OpenCodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function isoNow(): string {
  return new Date().toISOString();
}

function toIsoFromMillis(value: unknown, fallback = isoNow()): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function transitionOpenCodeAssistantTextItem(
  state: OpenCodeAssistantItemState | undefined,
  nextItemId: string,
): string | undefined {
  if (!state) {
    return undefined;
  }

  if (state.assistantItemStarted && state.assistantItemId === nextItemId) {
    return undefined;
  }

  const previousItemId =
    state.assistantItemId && !state.assistantItemCompleted ? state.assistantItemId : undefined;
  state.assistantItemId = nextItemId;
  state.assistantItemStarted = true;
  state.assistantItemCompleted = false;
  return previousItemId && previousItemId !== nextItemId ? previousItemId : undefined;
}

export function asContentString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function findLatestAssistantMessage(messages: ReadonlyArray<OpenCodeMessageListEntry>) {
  const latestEntry = messages.at(-1);
  return latestEntry?.info.role === "assistant" ? latestEntry : undefined;
}

function buildResponseFromMessageListEntry(
  entry: OpenCodeMessageListEntry,
): OpenCodeSendMessageResponse {
  return {
    info: {
      id: entry.info.id,
      role: entry.info.role,
    },
    parts: entry.parts,
  };
}

export function normalizeOpenCodeUserInputQuestions(input: {
  requestId: string;
  questions: ReadonlyArray<unknown>;
}): UserInputQuestion[] {
  const normalizedQuestions: UserInputQuestion[] = [];

  for (const [index, entry] of input.questions.entries()) {
    const question = asRecord(entry);
    if (!question) {
      continue;
    }

    const prompt = asString(question.question);
    if (!prompt) {
      continue;
    }

    const options: Array<{ label: string; description: string }> = [];
    for (const optionEntry of asArray(question.options) ?? []) {
      const option = asRecord(optionEntry);
      const label = asString(option?.label);
      const description = asString(option?.description);
      if (!label || !description) {
        continue;
      }
      options.push({ label, description });
    }

    if (options.length === 0) {
      continue;
    }

    normalizedQuestions.push({
      id: `opencode-${input.requestId}-${index + 1}`,
      header: asString(question.header) ?? `Question ${index + 1}`,
      question: prompt,
      options,
      multiSelect: question.multiple === true,
    });
  }

  return normalizedQuestions;
}

function normalizeOpenCodeTokenUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asRecord(value);
  if (!usage) {
    return undefined;
  }

  const cache = asRecord(usage.cache);
  const usedTokens = asNumber(usage.total);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const inputTokens = asNumber(usage.input);
  const cachedInputTokens =
    (asNumber(cache?.read) ?? 0) + (asNumber(cache?.write) ?? 0) || undefined;
  const outputTokens = asNumber(usage.output);
  const reasoningOutputTokens = asNumber(usage.reasoning);

  return {
    usedTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
  };
}

export function buildOpenCodeResolvedUserInputAnswers(input: {
  state: PendingQuestionState | undefined;
  rawAnswers: unknown;
}): Record<string, string | string[]> {
  const state = input.state;
  const answerGroups = asArray(input.rawAnswers);
  if (!state || !answerGroups) {
    return {};
  }

  const resolved: Record<string, string | string[]> = {};
  for (const [index, question] of state.questions.entries()) {
    const rawAnswerGroup = asArray(answerGroups[index]) ?? [];
    const answers = rawAnswerGroup
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (answers.length === 0) {
      continue;
    }

    resolved[question.id] = question.multiSelect ? answers : answers[0]!;
  }

  return resolved;
}

export function buildOpenCodeOrderedUserInputAnswers(input: {
  state: PendingQuestionState;
  answers: Record<string, unknown>;
}): string[][] {
  return input.state.questionIds.map((questionId) => {
    const answer = input.answers[questionId];
    if (typeof answer === "string") {
      return answer.trim().length > 0 ? [answer.trim()] : [];
    }
    if (Array.isArray(answer)) {
      return answer.filter((entry): entry is string => typeof entry === "string");
    }
    if (answer && typeof answer === "object") {
      const nested = asArray((answer as Record<string, unknown>).answers);
      return nested?.filter((entry): entry is string => typeof entry === "string") ?? [];
    }
    return [];
  });
}

export function listOpenCodePendingQuestionRequestIds(raw: unknown): string[] {
  const entries = asArray(raw) ?? [];
  const requestIds: string[] = [];

  for (const entry of entries) {
    const request = asRecord(entry);
    const requestId = asString(request?.id);
    if (requestId) {
      requestIds.push(requestId);
    }
  }

  return requestIds;
}

function makeRequestError(method: string, detail: string, cause?: unknown): ProviderAdapterError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function makeSessionNotFound(threadId: ThreadId, cause?: unknown): ProviderAdapterError {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toProviderSession(input: {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly runtimeMode: OpenCodeRuntimeMode;
  readonly cwd?: string | undefined;
  readonly model?: string | undefined;
  readonly variant?: string | undefined;
  readonly activeTurnId?: TurnId | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly status?: ProviderSession["status"] | undefined;
  readonly lastError?: string | undefined;
}): ProviderSession {
  return {
    provider: PROVIDER,
    status: input.status ?? "ready",
    runtimeMode: input.runtimeMode,
    threadId: input.threadId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.model ? { model: input.model } : {}),
    resumeCursor: {
      sessionId: input.sessionId,
      cwd: input.cwd ?? null,
      model: input.model ?? null,
      variant: input.variant ?? null,
    },
    ...(input.activeTurnId ? { activeTurnId: input.activeTurnId } : {}),
    createdAt: input.createdAt ?? isoNow(),
    updatedAt: input.updatedAt ?? input.createdAt ?? isoNow(),
    ...(input.lastError ? { lastError: input.lastError } : {}),
  };
}

function normalizeRequestType(
  permission: string | undefined,
): "command_execution_approval" | "file_change_approval" | "file_read_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "edit":
      return "file_change_approval";
    case "read":
    case "glob":
    case "grep":
    case "list":
    case "lsp":
      return "file_read_approval";
    default:
      return "unknown";
  }
}

function normalizeApprovalDecision(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

function normalizeToolItemType(
  toolName: string | undefined,
): "command_execution" | "file_change" | "mcp_tool_call" | "web_search" | "dynamic_tool_call" {
  const normalized = toolName?.toLowerCase() ?? "";
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("exec")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("file")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (
    normalized.includes("web") ||
    normalized.includes("search") ||
    normalized.includes("browser")
  ) {
    return "web_search";
  }
  return "dynamic_tool_call";
}

function permissionRulesForRuntimeMode(runtimeMode: OpenCodeRuntimeMode) {
  if (runtimeMode === "full-access") {
    return [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
      { permission: "lsp", pattern: "*", action: "allow" },
    ];
  }

  return [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
  ];
}

function isDefaultOpenCodeSessionTitle(threadId: ThreadId, title: string | undefined): boolean {
  if (!title) {
    return false;
  }
  return title.trim() === `T3 Code ${String(threadId)}`;
}

async function readEventStream(
  response: Response,
  onEvent: (event: OpenCodeEvent) => Promise<void>,
): Promise<void> {
  if (!response.body) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) {
        break;
      }

      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0);

      if (dataLines.length === 0) {
        continue;
      }

      const parsed = JSON.parse(dataLines.join("\n"));
      const record = asRecord(parsed);
      if (record) {
        await onEvent(record);
      }
    }
  }
}

function buildAuthHeaders(serverPassword?: string): Record<string, string> | undefined {
  if (!serverPassword) {
    return undefined;
  }

  return {
    Authorization: `Basic ${Buffer.from(`:${serverPassword}`).toString("base64")}`,
  };
}

export const makeOpenCodeAdapterLive = (options?: OpenCodeAdapterLiveOptions) => {
  const make = Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const providerRegistryOption = yield* Effect.serviceOption(ProviderRegistry);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);

    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const contextsByThreadId = new Map<ThreadId, OpenCodeContext>();
    const threadIdBySessionId = new Map<string, ThreadId>();
    const pendingQuestions = new Map<string, PendingQuestionState>();
    const partKinds = new Map<string, "text" | "reasoning" | "tool" | "patch" | "unknown">();

    let serverBaseUrl: string | undefined;
    const serverPassword: string | undefined = undefined;
    let child: ChildProcess | undefined;
    const activeEventLoopDirectories = new Set<string>();

    const refreshProviderStatusFromRuntimeSuccess = () =>
      Option.match(providerRegistryOption, {
        onNone: () => Effect.void,
        onSome: (providerRegistry) =>
          providerRegistry.refresh(PROVIDER).pipe(Effect.asVoid, Effect.ignoreCause({ log: true })),
      });

    const emit = (event: ProviderRuntimeEvent) =>
      Effect.gen(function* () {
        if (nativeEventLogger) {
          yield* nativeEventLogger.write(event, null);
        }
        yield* Queue.offer(runtimeEvents, event);
      });

    const emitThreadWarning = (threadId: ThreadId, message: string, detail?: unknown) =>
      emit({
        type: "runtime.warning",
        eventId: EventId.makeUnsafe(randomUUID()),
        provider: PROVIDER,
        threadId,
        createdAt: isoNow(),
        raw: {
          source: "opencode.server.event",
          payload: {
            message,
            ...(detail !== undefined ? { detail } : {}),
          },
        },
        payload: {
          message,
          ...(detail !== undefined ? { detail } : {}),
        },
      });

    const emitThreadError = (threadId: ThreadId, message: string, detail?: unknown) =>
      emit({
        type: "runtime.error",
        eventId: EventId.makeUnsafe(randomUUID()),
        provider: PROVIDER,
        threadId,
        createdAt: isoNow(),
        raw: {
          source: "opencode.server.event",
          payload: {
            message,
            ...(detail !== undefined ? { detail } : {}),
          },
        },
        payload: {
          message,
          class: "provider_error",
          ...(detail !== undefined ? { detail } : {}),
        },
      });

    const getContextForThread = (
      threadId: ThreadId,
    ): Effect.Effect<OpenCodeContext, ProviderAdapterError> => {
      const context = contextsByThreadId.get(threadId);
      return context ? Effect.succeed(context) : Effect.fail(makeSessionNotFound(threadId));
    };

    const emitAssistantResponseFromMessage = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly response: OpenCodeSendMessageResponse | undefined;
      readonly mode?: "fallback" | "completion-only";
    }) =>
      Effect.gen(function* () {
        const mode = input.mode ?? "fallback";
        const responseInfo = asRecord(input.response?.info);
        const assistantMessageId = asString(responseInfo?.id);
        const responseParts = input.response?.parts ?? [];
        const createdAt = isoNow();
        const context = contextsByThreadId.get(input.threadId);
        const turnState = context?.turns.find((entry) => entry.id === input.turnId);

        const ensureAssistantItemStarted = (assistantItemId: string) =>
          Effect.gen(function* () {
            if (turnState?.assistantItemStarted && turnState.assistantItemId === assistantItemId) {
              return;
            }

            const previousAssistantItemId = transitionOpenCodeAssistantTextItem(
              turnState,
              assistantItemId,
            );

            if (previousAssistantItemId) {
              yield* emit({
                type: "item.completed",
                eventId: EventId.makeUnsafe(randomUUID()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: input.turnId,
                itemId: RuntimeItemId.makeUnsafe(previousAssistantItemId),
                createdAt,
                raw: {
                  source: "opencode.server.event",
                  messageType: "message.response",
                  payload: input.response,
                },
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  title: "Assistant message",
                },
              });
            }

            yield* emit({
              type: "item.started",
              eventId: EventId.makeUnsafe(randomUUID()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: input.turnId,
              itemId: RuntimeItemId.makeUnsafe(assistantItemId),
              createdAt,
              raw: {
                source: "opencode.server.event",
                messageType: "message.response",
                payload: input.response,
              },
              payload: {
                itemType: "assistant_message",
                title: "Assistant message",
              },
            });
          });

        if (assistantMessageId && turnState) {
          turnState.assistantMessageId = assistantMessageId;
        }

        for (const part of responseParts) {
          const partId = asString(part.id);
          const partType = asString(part.type) ?? "unknown";
          if (!partId) {
            continue;
          }

          if (partType === "reasoning") {
            partKinds.set(partId, "reasoning");
            const reasoningText = asContentString(part.text);
            if (reasoningText && mode === "fallback") {
              yield* emit({
                type: "content.delta",
                eventId: EventId.makeUnsafe(randomUUID()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: input.turnId,
                itemId: RuntimeItemId.makeUnsafe(partId),
                createdAt,
                raw: {
                  source: "opencode.server.event",
                  messageType: "message.response",
                  payload: part,
                },
                payload: {
                  streamKind: "reasoning_text",
                  delta: reasoningText,
                },
              });
            }
            continue;
          }

          if (partType === "text") {
            partKinds.set(partId, "text");
            const text = asContentString(part.text);
            yield* ensureAssistantItemStarted(partId);
            if (text && mode === "fallback") {
              yield* emit({
                type: "content.delta",
                eventId: EventId.makeUnsafe(randomUUID()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: input.turnId,
                itemId: RuntimeItemId.makeUnsafe(partId),
                createdAt,
                raw: {
                  source: "opencode.server.event",
                  messageType: "message.response",
                  payload: part,
                },
                payload: {
                  streamKind: "assistant_text",
                  delta: text,
                },
              });
            }
            continue;
          }

          if (partType === "step-start") {
            yield* emit({
              type: "task.started",
              eventId: EventId.makeUnsafe(randomUUID()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: input.turnId,
              itemId: RuntimeItemId.makeUnsafe(partId),
              createdAt,
              raw: {
                source: "opencode.server.event",
                messageType: "message.response",
                payload: part,
              },
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(partId),
              },
            });
            continue;
          }

          if (partType === "step-finish") {
            const tokenUsage = normalizeOpenCodeTokenUsage(part.tokens);
            if (tokenUsage) {
              yield* emit({
                type: "thread.token-usage.updated",
                eventId: EventId.makeUnsafe(randomUUID()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: input.turnId,
                itemId: RuntimeItemId.makeUnsafe(partId),
                createdAt,
                raw: {
                  source: "opencode.server.event",
                  messageType: "message.response",
                  payload: part,
                },
                payload: {
                  usage: tokenUsage,
                },
              });
            }

            yield* emit({
              type: "task.completed",
              eventId: EventId.makeUnsafe(randomUUID()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: input.turnId,
              itemId: RuntimeItemId.makeUnsafe(partId),
              createdAt,
              raw: {
                source: "opencode.server.event",
                messageType: "message.response",
                payload: part,
              },
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(partId),
                status: "completed",
                ...(part.tokens !== undefined ? { usage: part.tokens } : {}),
              },
            });
          }
        }

        const assistantCompletionItemId =
          turnState?.assistantItemId ??
          responseParts.reduce<string | undefined>((found, entry) => {
            if (found) {
              return found;
            }
            return asString(entry.type) === "text" ? asString(entry.id) : undefined;
          }, undefined);

        if (assistantCompletionItemId && !(turnState?.assistantItemCompleted ?? false)) {
          yield* ensureAssistantItemStarted(assistantCompletionItemId);
          yield* emit({
            type: "item.completed",
            eventId: EventId.makeUnsafe(randomUUID()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: input.turnId,
            itemId: RuntimeItemId.makeUnsafe(assistantCompletionItemId),
            createdAt,
            raw: {
              source: "opencode.server.event",
              messageType: "message.response",
              payload: input.response,
            },
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
            },
          });

          if (turnState) {
            turnState.assistantItemCompleted = true;
          }
        }

        yield* emit({
          type: "turn.completed",
          eventId: EventId.makeUnsafe(randomUUID()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId: input.turnId,
          createdAt,
          raw: {
            source: "opencode.server.event",
            messageType: "message.response",
            payload: input.response,
          },
          payload: { state: "completed" },
        });

        yield* emit({
          type: "session.state.changed",
          eventId: EventId.makeUnsafe(randomUUID()),
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          raw: {
            source: "opencode.server.event",
            messageType: "message.response",
            payload: input.response,
          },
          payload: { state: "ready" },
        });

        if (context && context.activeTurnId === input.turnId) {
          context.activeTurnId = undefined;
        }
      });

    const buildUrl = (path: string, cwd?: string) => {
      if (!serverBaseUrl) {
        throw new Error("OpenCode server is not started.");
      }

      const url = new URL(path, serverBaseUrl);
      if (cwd && cwd.length > 0) {
        url.searchParams.set("directory", cwd);
      }
      return url;
    };

    const requestJson = <T>(input: {
      readonly method: string;
      readonly path: string;
      readonly cwd?: string | undefined;
      readonly body?: unknown;
      readonly responseMode?: "json" | "status-only" | undefined;
    }): Effect.Effect<T, ProviderAdapterError> =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(buildUrl(input.path, input.cwd), {
            method: input.method,
            headers: {
              ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
              ...buildAuthHeaders(serverPassword),
            },
            ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
          });

          if (!response.ok) {
            const detail = await response.text().catch(() => response.statusText);
            throw makeRequestError(
              `${input.method} ${input.path}`,
              detail || response.statusText || "Request failed.",
            );
          }

          if (input.responseMode === "status-only") {
            // Some OpenCode endpoints acknowledge with a response body that can
            // outlive the actual state change we care about. Drain it in the
            // background so the caller can continue once the request is accepted.
            void response.arrayBuffer().catch(() => undefined);
            return undefined as T;
          }

          const text = await response.text();
          if (text.trim().length === 0) {
            return undefined as T;
          }
          return JSON.parse(text) as T;
        },
        catch: (cause) =>
          makeRequestError(
            `${input.method} ${input.path}`,
            cause instanceof Error ? cause.message : "Request failed.",
            cause,
          ),
      });

    const isQuestionStillPending = (input: {
      readonly requestId: string;
      readonly cwd?: string | undefined;
    }): Effect.Effect<boolean, ProviderAdapterError> =>
      requestJson<unknown>({
        method: "GET",
        path: "/question",
        cwd: input.cwd,
      }).pipe(
        Effect.map((response) =>
          listOpenCodePendingQuestionRequestIds(response).includes(input.requestId),
        ),
      );

    const finalizeSendTurnFromLatestMessage = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly mode?: "fallback" | "completion-only";
    }) =>
      Effect.gen(function* () {
        const context = contextsByThreadId.get(input.threadId);
        if (!context) {
          return;
        }
        const turnState = context.turns.find((entry) => entry.id === input.turnId);

        const messages = yield* requestJson<ReadonlyArray<OpenCodeMessageListEntry>>({
          method: "GET",
          path: `/session/${context.sessionId}/message`,
          cwd: context.cwd,
        }).pipe(Effect.orElseSucceed(() => []));
        const latestAssistantMessage = findLatestAssistantMessage(messages);
        if (!latestAssistantMessage) {
          return;
        }
        if (
          !turnState?.assistantMessageId &&
          latestAssistantMessage.info.id === turnState?.previousAssistantMessageId
        ) {
          return;
        }

        yield* emitAssistantResponseFromMessage({
          threadId: input.threadId,
          turnId: input.turnId,
          response: buildResponseFromMessageListEntry(latestAssistantMessage),
          ...(input.mode ? { mode: input.mode } : {}),
        });
      });

    const finalizeSendTurnResponse = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
    }) =>
      Effect.gen(function* () {
        const context = contextsByThreadId.get(input.threadId);
        const turnState = context?.turns.find((entry) => entry.id === input.turnId);

        for (let attempt = 0; attempt < 8; attempt += 1) {
          yield* Effect.sleep("150 millis");

          if (!turnState?.sawStreamingActivity) {
            yield* finalizeSendTurnFromLatestMessage({
              threadId: input.threadId,
              turnId: input.turnId,
              mode: "fallback",
            });
            if (turnState?.assistantItemCompleted) {
              return;
            }
          }

          if (
            turnState?.sawStreamingActivity &&
            !turnState.assistantItemCompleted &&
            context?.activeTurnId === input.turnId
          ) {
            yield* finalizeSendTurnFromLatestMessage({
              threadId: input.threadId,
              turnId: input.turnId,
              mode: "completion-only",
            });
            if (turnState.assistantItemCompleted) {
              return;
            }
          }

          if (
            turnState?.assistantItemCompleted ||
            (turnState?.sawStreamingActivity && context?.activeTurnId !== input.turnId)
          ) {
            return;
          }
        }
      });

    const handleSendTurnRequestFailure = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly requestPayload: Record<string, unknown>;
      readonly cause: Cause.Cause<ProviderAdapterError>;
    }) =>
      Effect.gen(function* () {
        const context = contextsByThreadId.get(input.threadId);
        const turnState = context?.turns.find((entry) => entry.id === input.turnId);
        const detail = Cause.pretty(input.cause);
        const requestAlreadyProgressed =
          context?.activeTurnId !== input.turnId ||
          turnState?.sawStreamingActivity === true ||
          turnState?.assistantItemCompleted === true;

        if (requestAlreadyProgressed) {
          yield* Effect.logWarning(
            "OpenCode sendTurn request failed after runtime activity had already started",
            {
              threadId: String(input.threadId),
              turnId: String(input.turnId),
              detail,
            },
          );
          return;
        }

        if (context && context.activeTurnId === input.turnId) {
          context.activeTurnId = undefined;
          context.updatedAt = isoNow();
        }

        yield* emitThreadError(input.threadId, "OpenCode turn request failed", detail);
        yield* emit({
          type: "turn.completed",
          eventId: EventId.makeUnsafe(randomUUID()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId: input.turnId,
          createdAt: isoNow(),
          raw: {
            source: "opencode.server.event",
            messageType: "sendTurn",
            payload: input.requestPayload,
          },
          payload: {
            state: "failed",
            errorMessage: detail,
          },
        });
        yield* emit({
          type: "session.state.changed",
          eventId: EventId.makeUnsafe(randomUUID()),
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt: isoNow(),
          raw: {
            source: "opencode.server.event",
            messageType: "sendTurn",
            payload: input.requestPayload,
          },
          payload: {
            state: "error",
            reason: "OpenCode turn request failed",
            detail,
          },
        });
      });

    const ensureEventLoop = (cwd?: string) =>
      Effect.gen(function* () {
        if (!serverBaseUrl) {
          return;
        }

        const eventDirectory = cwd && cwd.length > 0 ? cwd : serverConfig.cwd;
        if (activeEventLoopDirectories.has(eventDirectory)) {
          return;
        }

        activeEventLoopDirectories.add(eventDirectory);

        const openEventStreamOnce = Effect.tryPromise({
          try: async () => {
            const response = await fetch(buildUrl("/event", eventDirectory), {
              headers: {
                Accept: "text/event-stream",
                ...buildAuthHeaders(serverPassword),
              },
            });

            if (!response.ok) {
              throw new Error(`OpenCode event stream failed with ${response.status}.`);
            }

            await readEventStream(response, async (event) => {
              const type = asString(event.type);
              const props = asRecord(event.properties);
              if (!type || !props) {
                return;
              }

              const sessionId =
                asString(props.sessionID) ??
                asString(asRecord(props.info)?.sessionID) ??
                asString(asRecord(props.part)?.sessionID) ??
                asString(asRecord(props.info)?.id);
              if (!sessionId) {
                return;
              }

              const threadId = threadIdBySessionId.get(sessionId);
              if (!threadId) {
                return;
              }

              const context = contextsByThreadId.get(threadId);
              if (!context) {
                return;
              }

              const createdAt = isoNow();
              const raw = {
                source: type.startsWith("permission.")
                  ? "opencode.server.permission"
                  : type.startsWith("question.")
                    ? "opencode.server.question"
                    : "opencode.server.event",
                messageType: type,
                payload: event,
              } as const;

              switch (type) {
                case "session.created":
                  await Effect.runPromise(
                    emit({
                      type: "session.started",
                      eventId: EventId.makeUnsafe(randomUUID()),
                      provider: PROVIDER,
                      threadId,
                      createdAt,
                      raw,
                      payload: {
                        message: "OpenCode session started",
                        resume: { sessionId: context.sessionId },
                      },
                    }),
                  );
                  break;

                case "session.updated": {
                  const title = asString(props.title) ?? asString(asRecord(props.info)?.title);
                  if (!title || isDefaultOpenCodeSessionTitle(threadId, title)) {
                    break;
                  }

                  await Effect.runPromise(
                    emit({
                      type: "thread.metadata.updated",
                      eventId: EventId.makeUnsafe(randomUUID()),
                      provider: PROVIDER,
                      threadId,
                      createdAt,
                      raw,
                      payload: { name: title },
                    }),
                  );
                  break;
                }

                case "session.status": {
                  const status = asString(asRecord(props.status)?.type) ?? asString(props.status);
                  if (status === "busy") {
                    await Effect.runPromise(
                      emit({
                        type: "session.state.changed",
                        eventId: EventId.makeUnsafe(randomUUID()),
                        provider: PROVIDER,
                        threadId,
                        createdAt,
                        raw,
                        payload: { state: "running" },
                      }),
                    );
                  } else if (status === "idle") {
                    await Effect.runPromise(
                      emit({
                        type: "session.state.changed",
                        eventId: EventId.makeUnsafe(randomUUID()),
                        provider: PROVIDER,
                        threadId,
                        createdAt,
                        raw,
                        payload: { state: "ready" },
                      }),
                    );
                  } else if (status === "retry") {
                    await Effect.runPromise(
                      emitThreadWarning(
                        threadId,
                        asString(props.message) ?? "OpenCode reported a retryable session state.",
                        event,
                      ),
                    );
                  }
                  break;
                }

                case "session.idle":
                  if (context.activeTurnId) {
                    const currentTurn = context.turns.find(
                      (entry) => entry.id === context.activeTurnId,
                    );
                    if (currentTurn?.assistantItemId && !currentTurn.assistantItemCompleted) {
                      currentTurn.assistantItemCompleted = true;
                      await Effect.runPromise(
                        emit({
                          type: "item.completed",
                          eventId: EventId.makeUnsafe(randomUUID()),
                          provider: PROVIDER,
                          threadId,
                          turnId: context.activeTurnId,
                          itemId: RuntimeItemId.makeUnsafe(currentTurn.assistantItemId),
                          createdAt,
                          raw,
                          payload: {
                            itemType: "assistant_message",
                            status: "completed",
                            title: "Assistant message",
                          },
                        }),
                      );
                    }
                    await Effect.runPromise(
                      emit({
                        type: "turn.completed",
                        eventId: EventId.makeUnsafe(randomUUID()),
                        provider: PROVIDER,
                        threadId,
                        turnId: context.activeTurnId,
                        createdAt,
                        raw,
                        payload: { state: "completed" },
                      }),
                    );
                    context.activeTurnId = undefined;
                  }
                  break;

                case "session.error": {
                  const message =
                    asString(props.error) ??
                    asString(asRecord(props.error)?.message) ??
                    "OpenCode session error";
                  await Effect.runPromise(emitThreadError(threadId, message, event));
                  await Effect.runPromise(
                    emit({
                      type: "session.state.changed",
                      eventId: EventId.makeUnsafe(randomUUID()),
                      provider: PROVIDER,
                      threadId,
                      createdAt,
                      raw,
                      payload: {
                        state: "error",
                        reason: message,
                        detail: event,
                      },
                    }),
                  );
                  break;
                }

                case "permission.asked": {
                  const requestId = asString(props.id);
                  if (!requestId) {
                    break;
                  }

                  await Effect.runPromise(
                    emit({
                      type: "request.opened",
                      eventId: EventId.makeUnsafe(randomUUID()),
                      provider: PROVIDER,
                      threadId,
                      requestId: RuntimeRequestId.makeUnsafe(requestId),
                      createdAt,
                      raw,
                      payload: {
                        requestType: normalizeRequestType(asString(props.permission)),
                        ...(asArray(props.patterns)?.length
                          ? { detail: asArray(props.patterns)?.join(", ") }
                          : {}),
                      },
                    }),
                  );
                  break;
                }

                case "permission.replied": {
                  const requestId = asString(props.requestID);
                  if (!requestId) {
                    break;
                  }

                  await Effect.runPromise(
                    emit({
                      type: "request.resolved",
                      eventId: EventId.makeUnsafe(randomUUID()),
                      provider: PROVIDER,
                      threadId,
                      requestId: RuntimeRequestId.makeUnsafe(requestId),
                      createdAt,
                      raw,
                      payload: {
                        requestType: "unknown",
                        ...(asString(props.reply) ? { decision: asString(props.reply) } : {}),
                      },
                    }),
                  );
                  break;
                }

                case "question.asked": {
                  const requestId = asString(props.id);
                  const rawQuestions = asArray(props.questions);
                  if (!requestId || !rawQuestions) {
                    break;
                  }

                  const normalizedQuestions = normalizeOpenCodeUserInputQuestions({
                    requestId,
                    questions: rawQuestions,
                  });
                  if (normalizedQuestions.length === 0) {
                    break;
                  }

                  pendingQuestions.set(requestId, {
                    questionIds: normalizedQuestions.map((question) => question.id),
                    questions: normalizedQuestions,
                  });

                  await Effect.runPromise(
                    emit({
                      type: "user-input.requested",
                      eventId: EventId.makeUnsafe(randomUUID()),
                      provider: PROVIDER,
                      threadId,
                      requestId: RuntimeRequestId.makeUnsafe(requestId),
                      createdAt,
                      raw,
                      payload: {
                        questions: normalizedQuestions,
                      },
                    }),
                  );
                  break;
                }

                case "question.replied":
                case "question.rejected": {
                  const requestId = asString(props.requestID);
                  if (!requestId) {
                    break;
                  }

                  const pendingState = pendingQuestions.get(requestId);
                  if (!pendingState) {
                    break;
                  }
                  const resolvedAnswers =
                    type === "question.replied"
                      ? buildOpenCodeResolvedUserInputAnswers({
                          state: pendingState,
                          rawAnswers: props.answers,
                        })
                      : {};
                  pendingQuestions.delete(requestId);
                  await Effect.runPromise(
                    emit({
                      type: "user-input.resolved",
                      eventId: EventId.makeUnsafe(randomUUID()),
                      provider: PROVIDER,
                      threadId,
                      requestId: RuntimeRequestId.makeUnsafe(requestId),
                      createdAt,
                      raw,
                      payload: { answers: resolvedAnswers },
                    }),
                  );
                  break;
                }

                case "todo.updated":
                  if (!context.activeTurnId) {
                    break;
                  }

                  await Effect.runPromise(
                    emit({
                      type: "turn.plan.updated",
                      eventId: EventId.makeUnsafe(randomUUID()),
                      provider: PROVIDER,
                      threadId,
                      turnId: context.activeTurnId,
                      createdAt,
                      raw,
                      payload: {
                        plan: (asArray(props.todos) ?? []).flatMap((entry) => {
                          const todo = asRecord(entry);
                          const step = asString(todo?.content);
                          if (!step) {
                            return [];
                          }
                          const status = asString(todo?.status);
                          return [
                            {
                              step,
                              status:
                                status === "in_progress"
                                  ? ("inProgress" as const)
                                  : status === "completed"
                                    ? ("completed" as const)
                                    : ("pending" as const),
                            },
                          ];
                        }),
                      },
                    }),
                  );
                  break;

                case "message.updated": {
                  const info = asRecord(props.info);
                  const messageId = asString(info?.id);
                  const role = asString(info?.role);
                  if (!messageId || !role || !context.activeTurnId) {
                    break;
                  }

                  const currentTurn = context.turns.at(-1);
                  if (role === "user") {
                    currentTurn?.items.push(props);
                    break;
                  }

                  if (role === "assistant" && currentTurn) {
                    currentTurn.assistantMessageId = messageId;
                    currentTurn.sawStreamingActivity = true;
                  }
                  break;
                }

                case "message.part.delta": {
                  if (!context.activeTurnId) {
                    break;
                  }

                  const partId = asString(props.partID);
                  const delta = asContentString(props.delta) ?? "";
                  if (!partId || delta.length === 0) {
                    break;
                  }

                  const currentTurn = context.turns.at(-1);
                  if (currentTurn) {
                    currentTurn.sawStreamingActivity = true;
                    if (partKinds.get(partId) !== "reasoning") {
                      currentTurn.sawAssistantTextDelta = true;
                    }
                  }

                  await Effect.runPromise(
                    emit({
                      type: "content.delta",
                      eventId: EventId.makeUnsafe(randomUUID()),
                      provider: PROVIDER,
                      threadId,
                      turnId: context.activeTurnId,
                      itemId: RuntimeItemId.makeUnsafe(partId),
                      createdAt,
                      raw,
                      payload: {
                        streamKind:
                          partKinds.get(partId) === "reasoning"
                            ? "reasoning_text"
                            : "assistant_text",
                        delta,
                      },
                    }),
                  );
                  break;
                }

                case "message.part.updated": {
                  if (!context.activeTurnId) {
                    break;
                  }

                  const part = asRecord(props.part);
                  const partId = asString(part?.id);
                  const partType = asString(part?.type) ?? "unknown";
                  if (!part || !partId) {
                    break;
                  }

                  const currentTurn = context.turns.at(-1);
                  if (currentTurn) {
                    currentTurn.sawStreamingActivity = true;
                  }

                  if (partType === "text") {
                    partKinds.set(partId, "text");
                    const wasActiveAssistantItem =
                      currentTurn?.assistantItemStarted && currentTurn.assistantItemId === partId;
                    const previousAssistantItemId = transitionOpenCodeAssistantTextItem(
                      currentTurn,
                      partId,
                    );
                    if (previousAssistantItemId) {
                      await Effect.runPromise(
                        emit({
                          type: "item.completed",
                          eventId: EventId.makeUnsafe(randomUUID()),
                          provider: PROVIDER,
                          threadId,
                          turnId: context.activeTurnId,
                          itemId: RuntimeItemId.makeUnsafe(previousAssistantItemId),
                          createdAt,
                          raw,
                          payload: {
                            itemType: "assistant_message",
                            status: "completed",
                            title: "Assistant message",
                          },
                        }),
                      );
                    }
                    if (wasActiveAssistantItem) {
                      break;
                    }
                    if (currentTurn) {
                      await Effect.runPromise(
                        emit({
                          type: "item.started",
                          eventId: EventId.makeUnsafe(randomUUID()),
                          provider: PROVIDER,
                          threadId,
                          turnId: context.activeTurnId,
                          itemId: RuntimeItemId.makeUnsafe(partId),
                          createdAt,
                          raw,
                          payload: {
                            itemType: "assistant_message",
                            title: "Assistant message",
                          },
                        }),
                      );
                    }
                  } else if (partType === "reasoning") {
                    partKinds.set(partId, "reasoning");
                  } else if (partType === "tool") {
                    partKinds.set(partId, "tool");
                  } else if (partType === "patch") {
                    partKinds.set(partId, "patch");
                  } else {
                    partKinds.set(partId, "unknown");
                  }

                  if (partType === "tool") {
                    const toolName =
                      asString(part.tool) ??
                      asString(part.name) ??
                      asString(asRecord(part.toolCall)?.name);
                    const state = asRecord(part.state);
                    const status = asString(state?.status);
                    const itemType = normalizeToolItemType(toolName);

                    await Effect.runPromise(
                      emit({
                        type:
                          status === "completed" || status === "error"
                            ? "item.completed"
                            : status === "running"
                              ? "item.updated"
                              : "item.started",
                        eventId: EventId.makeUnsafe(randomUUID()),
                        provider: PROVIDER,
                        threadId,
                        turnId: context.activeTurnId,
                        itemId: RuntimeItemId.makeUnsafe(partId),
                        createdAt,
                        raw,
                        payload: {
                          itemType,
                          title: toolName ?? "Tool call",
                          ...(status === "completed"
                            ? { status: "completed" as const }
                            : status === "error"
                              ? { status: "failed" as const }
                              : status === "running"
                                ? { status: "inProgress" as const }
                                : {}),
                          ...(asString(state?.title) ||
                          asString(state?.output) ||
                          asString(state?.error)
                            ? {
                                detail:
                                  asString(state?.title) ??
                                  asString(state?.output) ??
                                  asString(state?.error),
                              }
                            : {}),
                        },
                      }),
                    );
                  } else if (partType === "patch") {
                    const unifiedDiff =
                      asContentString(part.diff) ??
                      asContentString(part.patch) ??
                      JSON.stringify(asArray(part.files) ?? []);

                    await Effect.runPromise(
                      emit({
                        type: "turn.diff.updated",
                        eventId: EventId.makeUnsafe(randomUUID()),
                        provider: PROVIDER,
                        threadId,
                        turnId: context.activeTurnId,
                        createdAt,
                        raw,
                        payload: { unifiedDiff },
                      }),
                    );
                  } else if (partType === "step-start") {
                    await Effect.runPromise(
                      emit({
                        type: "task.started",
                        eventId: EventId.makeUnsafe(randomUUID()),
                        provider: PROVIDER,
                        threadId,
                        turnId: context.activeTurnId,
                        itemId: RuntimeItemId.makeUnsafe(partId),
                        createdAt,
                        raw,
                        payload: {
                          taskId: RuntimeTaskId.makeUnsafe(partId),
                          ...(asString(part.title) ? { description: asString(part.title) } : {}),
                          ...(asString(part.kind) ? { taskType: asString(part.kind) } : {}),
                        },
                      }),
                    );
                  } else if (partType === "step-finish") {
                    const tokenUsage = normalizeOpenCodeTokenUsage(part.tokens);
                    if (tokenUsage) {
                      await Effect.runPromise(
                        emit({
                          type: "thread.token-usage.updated",
                          eventId: EventId.makeUnsafe(randomUUID()),
                          provider: PROVIDER,
                          threadId,
                          turnId: context.activeTurnId,
                          itemId: RuntimeItemId.makeUnsafe(partId),
                          createdAt,
                          raw,
                          payload: {
                            usage: tokenUsage,
                          },
                        }),
                      );
                    }

                    await Effect.runPromise(
                      emit({
                        type: "task.completed",
                        eventId: EventId.makeUnsafe(randomUUID()),
                        provider: PROVIDER,
                        threadId,
                        turnId: context.activeTurnId,
                        itemId: RuntimeItemId.makeUnsafe(partId),
                        createdAt,
                        raw,
                        payload: {
                          taskId: RuntimeTaskId.makeUnsafe(partId),
                          status: asString(part.status) === "error" ? "failed" : "completed",
                          ...(asString(part.summary) ? { summary: asString(part.summary) } : {}),
                          ...(part.tokens !== undefined ? { usage: part.tokens } : {}),
                        },
                      }),
                    );
                  } else if (partType === "compaction") {
                    await Effect.runPromise(
                      emit({
                        type: "item.completed",
                        eventId: EventId.makeUnsafe(randomUUID()),
                        provider: PROVIDER,
                        threadId,
                        turnId: context.activeTurnId,
                        itemId: RuntimeItemId.makeUnsafe(partId),
                        createdAt,
                        raw,
                        payload: {
                          itemType: "context_compaction",
                          status: "completed",
                        },
                      }),
                    );
                  }
                  break;
                }

                default:
                  break;
              }
            });
          },
          catch: (cause) =>
            makeRequestError(
              "GET /event",
              cause instanceof Error ? cause.message : "OpenCode event stream failed.",
              cause,
            ),
        });

        const openEventStream: Effect.Effect<void, never, never> = Effect.gen(function* () {
          const exit = yield* Effect.exit(openEventStreamOnce);
          if (Exit.isFailure(exit)) {
            const error = exit.cause;
            for (const threadId of contextsByThreadId.keys()) {
              yield* emitThreadWarning(
                threadId,
                "OpenCode event stream disconnected; retrying.",
                error,
              );
            }
            yield* Effect.sleep("500 millis");
          }
        });

        yield* Effect.sync(() => {
          void Effect.runFork(Effect.forever(openEventStream));
        });
      });

    const ensureServer = (cwd?: string) =>
      Effect.gen(function* () {
        if (serverBaseUrl) {
          yield* ensureEventLoop(cwd);
          return serverBaseUrl;
        }
        const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
        const binaryPath = settings.providers.opencode.binaryPath || "opencode";

        child = yield* Effect.try({
          try: () =>
            spawn(binaryPath, ["serve", "--hostname", DEFAULT_SERVER_HOST, "--port", "0"], {
              cwd: serverConfig.cwd,
              env: {
                ...process.env,
              },
              stdio: ["ignore", "pipe", "pipe"],
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ThreadId.makeUnsafe("opencode-adapter"),
              detail: cause instanceof Error ? cause.message : "Unable to spawn opencode serve.",
              cause,
            }),
        });

        serverBaseUrl = yield* Effect.tryPromise({
          try: () =>
            new Promise<string>((resolve, reject) => {
              if (!child?.stdout || !child.stderr) {
                reject(new Error("OpenCode server process streams are unavailable."));
                return;
              }

              let settled = false;
              const finish = (handler: () => void) => {
                if (settled) {
                  return;
                }
                settled = true;
                child?.stdout?.off("data", onData);
                child?.stderr?.off("data", onData);
                child?.off("exit", onExit);
                handler();
              };

              const onData = (chunk: Buffer) => {
                const text = chunk.toString("utf8");
                const match = text.match(/(https?:\/\/[^\s]+)/);
                if (!match?.[1]) {
                  return;
                }

                const baseUrl = match[1].endsWith("/") ? match[1] : `${match[1]}/`;
                finish(() => resolve(baseUrl));
              };

              const onExit = () => {
                finish(() => reject(new Error("OpenCode server exited before reporting its URL.")));
              };

              child.stdout.on("data", onData);
              child.stderr.on("data", onData);
              child.once("exit", onExit);
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ThreadId.makeUnsafe("opencode-adapter"),
              detail:
                cause instanceof Error
                  ? cause.message
                  : "OpenCode server exited before reporting its URL.",
              cause,
            }),
        });

        yield* ensureEventLoop(cwd);
        return serverBaseUrl;
      });

    const adapter: OpenCodeAdapterShape = {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
      },

      startSession: (input) =>
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }

          yield* ensureServer(input.cwd);
          const modelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;

          const resumeCursor = asRecord(input.resumeCursor);
          const resumedSessionId = asString(resumeCursor?.sessionId);
          let sessionInfo: OpenCodeSessionInfo | undefined;

          if (resumedSessionId) {
            sessionInfo = yield* requestJson<OpenCodeSessionInfo>({
              method: "GET",
              path: `/session/${resumedSessionId}`,
              cwd: input.cwd,
            }).pipe(Effect.orElseSucceed(() => undefined));
          }

          if (!sessionInfo) {
            sessionInfo = yield* requestJson<OpenCodeSessionInfo>({
              method: "POST",
              path: "/session",
              cwd: input.cwd,
              body: {
                title: `T3 Code ${String(input.threadId)}`,
                permission: permissionRulesForRuntimeMode(input.runtimeMode),
              },
            });
          }

          const createdAt = toIsoFromMillis(sessionInfo.time?.created);
          const updatedAt = toIsoFromMillis(sessionInfo.time?.updated, createdAt);
          const variant = asString(modelSelection?.options?.variant);
          const context: OpenCodeContext = {
            threadId: input.threadId,
            sessionId: sessionInfo.id,
            cwd: input.cwd,
            runtimeMode: input.runtimeMode,
            createdAt,
            updatedAt,
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(variant ? { variant } : {}),
            turns: [],
          };

          contextsByThreadId.set(input.threadId, context);
          threadIdBySessionId.set(sessionInfo.id, input.threadId);
          yield* refreshProviderStatusFromRuntimeSuccess();

          return toProviderSession({
            threadId: input.threadId,
            sessionId: sessionInfo.id,
            cwd: input.cwd,
            runtimeMode: input.runtimeMode,
            model: modelSelection?.model,
            variant,
            createdAt,
            updatedAt,
          });
        }),

      sendTurn: (input) =>
        Effect.gen(function* () {
          const context = yield* getContextForThread(input.threadId);
          const turnId = TurnId.makeUnsafe(`turn-${randomUUID()}`);
          const modelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const variant = asString(modelSelection?.options?.variant) ?? context.variant;
          const model = asString(modelSelection?.model) ?? context.model;

          const parts: Array<Record<string, unknown>> = [];
          if (input.input) {
            parts.push({ type: "text", text: input.input });
          }

          for (const attachment of input.attachments ?? []) {
            if (attachment.type !== "image") {
              continue;
            }

            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Invalid attachment id '${attachment.id}'.`,
              });
            }

            parts.push({
              type: "file",
              mime: attachment.mimeType,
              filename: attachment.name,
              url: pathToFileURL(attachmentPath).toString(),
            });
          }

          if (parts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Expected input text or at least one attachment.",
            });
          }

          context.activeTurnId = turnId;
          context.updatedAt = isoNow();
          context.model = model;
          context.variant = variant;
          const previousAssistantMessageId = context.turns
            .toReversed()
            .find((entry) => entry.assistantMessageId)?.assistantMessageId;
          const turnState: OpenCodeTurnState = {
            id: turnId,
            items: [],
            ...(previousAssistantMessageId ? { previousAssistantMessageId } : {}),
          };
          context.turns.push(turnState);

          yield* emit({
            type: "session.state.changed",
            eventId: EventId.makeUnsafe(randomUUID()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: isoNow(),
            raw: {
              source: "opencode.server.event",
              messageType: "sendTurn",
              payload: { parts },
            },
            payload: { state: "running" },
          });

          yield* emit({
            type: "turn.started",
            eventId: EventId.makeUnsafe(randomUUID()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            createdAt: isoNow(),
            raw: {
              source: "opencode.server.event",
              messageType: "sendTurn",
              payload: { parts },
            },
            payload: {
              ...(model ? { model } : {}),
              ...(variant ? { effort: variant } : {}),
            },
          });

          const requestPayload = {
            parts,
            ...(model ? { model: { providerID: getProviderIdForModel(model), modelID: model } } : {}),
            ...(variant ? { variant } : {}),
            agent: input.interactionMode === "plan" ? "plan" : "build",
          } satisfies Record<string, unknown>;

          yield* Effect.sync(() => {
            void Effect.runFork(
              requestJson<unknown>({
                responseMode: "status-only",
                method: "POST",
                path: `/session/${context.sessionId}/message`,
                cwd: context.cwd,
                body: requestPayload,
              }).pipe(
                Effect.flatMap(() =>
                  finalizeSendTurnResponse({
                    threadId: input.threadId,
                    turnId,
                  }),
                ),
                Effect.catchCause((cause) =>
                  handleSendTurnRequestFailure({
                    threadId: input.threadId,
                    turnId,
                    requestPayload,
                    cause,
                  }),
                ),
              ),
            );
          });

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: {
              sessionId: context.sessionId,
              cwd: context.cwd ?? null,
              model: model ?? null,
              variant: variant ?? null,
            },
          };
        }),

      interruptTurn: (threadId) =>
        Effect.gen(function* () {
          const context = yield* getContextForThread(threadId);
          yield* requestJson<unknown>({
            method: "POST",
            path: `/session/${context.sessionId}/abort`,
            cwd: context.cwd,
          }).pipe(Effect.orElseSucceed(() => undefined));
        }),

      respondToRequest: (threadId, requestId, decision) =>
        Effect.gen(function* () {
          const context = yield* getContextForThread(threadId);
          yield* requestJson<unknown>({
            method: "POST",
            path: `/permission/${requestId}/reply`,
            cwd: context.cwd,
            body: { reply: normalizeApprovalDecision(decision) },
          });
        }),

      respondToUserInput: (threadId, requestId, answers) =>
        Effect.gen(function* () {
          const context = yield* getContextForThread(threadId);
          const state = pendingQuestions.get(String(requestId));
          if (!state) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToUserInput",
              issue: `Unknown pending user-input request '${requestId}'.`,
            });
          }

          const orderedAnswers = buildOpenCodeOrderedUserInputAnswers({
            state,
            answers,
          });

          yield* requestJson<unknown>({
            method: "POST",
            path: `/question/${requestId}/reply`,
            cwd: context.cwd,
            body: { answers: orderedAnswers },
            responseMode: "status-only",
          });

          let questionStillPending = true;
          for (let attempt = 0; attempt < 6; attempt += 1) {
            questionStillPending = yield* isQuestionStillPending({
              requestId: String(requestId),
              cwd: context.cwd,
            }).pipe(Effect.orElseSucceed(() => true));
            if (!questionStillPending) {
              break;
            }
            if (attempt < 5) {
              yield* Effect.sleep("150 millis");
            }
          }

          if (questionStillPending) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToUserInput",
              issue: `OpenCode did not accept pending user-input request '${requestId}'.`,
            });
          }

          if (!pendingQuestions.has(String(requestId))) {
            return;
          }

          pendingQuestions.delete(String(requestId));
          const createdAt = isoNow();
          yield* emit({
            type: "user-input.resolved",
            eventId: EventId.makeUnsafe(randomUUID()),
            provider: PROVIDER,
            threadId,
            requestId: RuntimeRequestId.makeUnsafe(String(requestId)),
            createdAt,
            raw: {
              source: "opencode.server.question",
              messageType: "question.replied",
              payload: {
                type: "question.replied",
                properties: {
                  sessionID: context.sessionId,
                  requestID: String(requestId),
                  answers: orderedAnswers,
                },
              },
            },
            payload: {
              answers: buildOpenCodeResolvedUserInputAnswers({
                state,
                rawAnswers: orderedAnswers,
              }),
            },
          });
        }),

      stopSession: (threadId) =>
        Effect.sync(() => {
          const context = contextsByThreadId.get(threadId);
          if (!context) {
            return;
          }

          threadIdBySessionId.delete(context.sessionId);
          contextsByThreadId.delete(threadId);
        }),

      listSessions: () =>
        Effect.sync(() =>
          Array.from(contextsByThreadId.values()).map((context) =>
            toProviderSession({
              threadId: context.threadId,
              sessionId: context.sessionId,
              cwd: context.cwd,
              runtimeMode: context.runtimeMode,
              model: context.model,
              variant: context.variant,
              activeTurnId: context.activeTurnId,
              createdAt: context.createdAt,
              updatedAt: context.updatedAt,
              status: context.activeTurnId ? "running" : "ready",
            }),
          ),
        ),

      hasSession: (threadId) => Effect.succeed(contextsByThreadId.has(threadId)),

      readThread: (threadId) =>
        Effect.gen(function* () {
          const context = yield* getContextForThread(threadId);
          const messages = yield* requestJson<ReadonlyArray<OpenCodeMessageListEntry>>({
            method: "GET",
            path: `/session/${context.sessionId}/message`,
            cwd: context.cwd,
          });

          const turns: Array<{ id: TurnId; items: ReadonlyArray<unknown> }> = [];
          let currentTurn: { id: TurnId; items: Array<unknown> } | undefined;

          for (const entry of messages) {
            if (entry.info.role === "user") {
              currentTurn = {
                id: TurnId.makeUnsafe(`turn-${entry.info.id}`),
                items: [...entry.parts],
              };
              turns.push(currentTurn);
              continue;
            }

            if (!currentTurn) {
              currentTurn = {
                id: TurnId.makeUnsafe(`turn-${entry.info.id}`),
                items: [],
              };
              turns.push(currentTurn);
            }

            currentTurn.items.push(...entry.parts);
          }

          return {
            threadId,
            turns,
          };
        }),

      rollbackThread: (threadId, numTurns) =>
        Effect.gen(function* () {
          const context = yield* getContextForThread(threadId);
          const messages = yield* requestJson<ReadonlyArray<OpenCodeMessageListEntry>>({
            method: "GET",
            path: `/session/${context.sessionId}/message`,
            cwd: context.cwd,
          });

          const userMessages = messages.filter((entry) => entry.info.role === "user");
          const target = userMessages.at(Math.max(0, userMessages.length - numTurns - 1));
          if (target) {
            yield* requestJson<unknown>({
              method: "POST",
              path: `/session/${context.sessionId}/revert`,
              cwd: context.cwd,
              body: { messageID: target.info.id },
            });
          }

          return yield* adapter.readThread(threadId);
        }),

      stopAll: () =>
        Effect.sync(() => {
          contextsByThreadId.clear();
          threadIdBySessionId.clear();
          pendingQuestions.clear();
          partKinds.clear();
        }),

      streamEvents: Stream.fromQueue(runtimeEvents),
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        child?.kill();
      }),
    );

    return adapter;
  });

  return Layer.effect(OpenCodeAdapter, make);
};
