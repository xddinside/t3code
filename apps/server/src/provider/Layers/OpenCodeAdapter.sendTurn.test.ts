import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { makeOpenCodeAdapterLive } from "./OpenCodeAdapter.ts";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

function createFakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe("OpenCodeAdapter sendTurn", () => {
  it("refreshes the OpenCode provider snapshot after a session starts successfully", async () => {
    const originalFetch = globalThis.fetch;
    const child = createFakeChildProcess();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        child.stdout.write("http://127.0.0.1:4096/\n");
      }, 0);
      return child as never;
    });

    const refresh = vi.fn(() => Effect.succeed([]));

    globalThis.fetch = vi.fn(async (input, init) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl);

      if (url.pathname === "/event") {
        return new Response(
          new ReadableStream({
            start() {},
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }

      if (url.pathname === "/session" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "ses_test",
            time: {
              created: Date.now(),
              updated: Date.now(),
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unexpected fetch request: ${init?.method ?? "GET"} ${url.toString()}`);
    }) as unknown as typeof fetch;

    const layer = makeOpenCodeAdapterLive().pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderRegistry, {
          getProviders: Effect.succeed([]),
          refresh,
          streamChanges: Stream.empty,
        }),
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-refresh-" }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: {
            opencode: {
              enabled: true,
              binaryPath: "opencode",
            },
          },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* OpenCodeAdapter;

            yield* adapter.startSession({
              threadId: ThreadId.makeUnsafe("thread-opencode-provider-refresh"),
              provider: "opencode",
              runtimeMode: "full-access",
              cwd: process.cwd(),
            });
          }).pipe(Effect.provide(layer)),
        ),
      );

      expect(refresh).toHaveBeenCalledWith("opencode");
    } finally {
      globalThis.fetch = originalFetch;
      spawnMock.mockReset();
    }
  });

  it("does not wait for the long-lived message response before returning", async () => {
    const originalFetch = globalThis.fetch;
    const child = createFakeChildProcess();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        child.stdout.write("http://127.0.0.1:4096/\n");
      }, 0);
      return child as never;
    });

    let resolveMessageResponse: ((value: Response) => void) | undefined;
    let messageRequestStarted = false;

    globalThis.fetch = vi.fn(async (input, init) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl);

      if (url.pathname === "/event") {
        return new Response(
          new ReadableStream({
            start() {},
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }

      if (url.pathname === "/session" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "ses_test",
            time: {
              created: Date.now(),
              updated: Date.now(),
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.pathname === "/session/ses_test/message" && init?.method === "POST") {
        messageRequestStarted = true;
        return await new Promise<Response>((resolve) => {
          resolveMessageResponse = resolve;
        });
      }

      throw new Error(`Unexpected fetch request: ${init?.method ?? "GET"} ${url.toString()}`);
    }) as unknown as typeof fetch;

    const layer = makeOpenCodeAdapterLive().pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: {
            opencode: {
              enabled: true,
              binaryPath: "opencode",
            },
          },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* OpenCodeAdapter;
            const threadId = ThreadId.makeUnsafe("thread-opencode-send-turn");

            yield* adapter.startSession({
              threadId,
              provider: "opencode",
              runtimeMode: "full-access",
              cwd: process.cwd(),
            });

            const turn = yield* adapter.sendTurn({
              threadId,
              input: "ask me a question using the tool",
              interactionMode: "default",
            });
            yield* Effect.sleep("10 millis");

            expect(turn.threadId).toBe(threadId);
            expect(messageRequestStarted).toBe(true);
            expect(resolveMessageResponse).toBeDefined();
          }).pipe(Effect.provide(layer)),
        ),
      );
    } finally {
      resolveMessageResponse?.(
        new Response(JSON.stringify({ info: { id: "msg_1", role: "assistant" }, parts: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      globalThis.fetch = originalFetch;
      spawnMock.mockReset();
    }
  });
});
