import type {
  ModelCapabilities,
  OpenCodeSettings,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { Effect, Equal, Layer, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  collectStreamAsString,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type CommandResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { OpenCodeProvider } from "../Services/OpenCodeProvider";
import { ServerSettingsError, ServerSettingsService } from "../../serverSettings";

const PROVIDER = "opencode" as const;

// OpenCode docs describe variants generically, but do not provide a reliable
// per-model capability feed we can consume here. Keep this list explicit and
// only advertise selectable reasoning levels for models we have verified.
const OPENCODE_REASONING_EFFORT_LEVELS_BY_MODEL: Partial<
  Record<string, ModelCapabilities["reasoningEffortLevels"]>
> = {
  "mimo-v2-omni": [
    { value: "default", label: "Default", isDefault: true },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  "mimo-v2-pro": [
    { value: "default", label: "Default", isDefault: true },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "glm-5.1",
    name: "GLM-5.1",
    isCustom: false,
    contextLimitTokens: 204_800,
    capabilities: {
      reasoningEffortLevels: OPENCODE_REASONING_EFFORT_LEVELS_BY_MODEL["glm-5.1"] ?? [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "kimi-k2.5",
    name: "Kimi K2.5",
    isCustom: false,
    contextLimitTokens: 262_144,
    capabilities: {
      reasoningEffortLevels: OPENCODE_REASONING_EFFORT_LEVELS_BY_MODEL["kimi-k2.5"] ?? [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "mimo-v2-omni",
    name: "MiMo V2 Omni",
    isCustom: false,
    contextLimitTokens: 262_144,
    capabilities: {
      reasoningEffortLevels: OPENCODE_REASONING_EFFORT_LEVELS_BY_MODEL["mimo-v2-omni"] ?? [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "mimo-v2-pro",
    name: "MiMo V2 Pro",
    isCustom: false,
    contextLimitTokens: 1_048_576,
    capabilities: {
      reasoningEffortLevels: OPENCODE_REASONING_EFFORT_LEVELS_BY_MODEL["mimo-v2-pro"] ?? [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "minimax-m2.5",
    name: "MiniMax M2.5",
    isCustom: false,
    contextLimitTokens: 204_800,
    capabilities: {
      reasoningEffortLevels: OPENCODE_REASONING_EFFORT_LEVELS_BY_MODEL["minimax-m2.5"] ?? [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "minimax-m2.7",
    name: "MiniMax M2.7",
    isCustom: false,
    contextLimitTokens: 204_800,
    capabilities: {
      reasoningEffortLevels: OPENCODE_REASONING_EFFORT_LEVELS_BY_MODEL["minimax-m2.7"] ?? [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "minimax-m2.5-free",
    name: "MiniMax M2.5 Free",
    isCustom: false,
    contextLimitTokens: 204_800,
    capabilities: {
      reasoningEffortLevels: OPENCODE_REASONING_EFFORT_LEVELS_BY_MODEL["minimax-m2.5-free"] ?? [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
];

const runOpenCodeCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const openCodeSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.opencode),
    );
    const command = ChildProcess.make(openCodeSettings.binaryPath, [...args], {
      shell: process.platform === "win32",
      env: {
        ...process.env,
      },
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const openCodeSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.opencode),
    );
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      openCodeSettings.customModels,
    );

    if (!openCodeSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "unknown" },
        },
      });
    }

    const versionProbe = yield* runOpenCodeCommand(["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: openCodeSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "OpenCode CLI (`opencode`) is not installed or not on PATH."
            : `Failed to execute OpenCode CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (versionProbe.success._tag === "None") {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: openCodeSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenCode CLI is installed but did not respond before the health-check timeout.",
        },
      });
    }

    const versionResult = versionProbe.success.value;
    const parsedVersion = parseGenericCliVersion(
      `${versionResult.stdout}\n${versionResult.stderr}`,
    );
    if (versionResult.code !== 0) {
      const detail = detailFromResult(versionResult);
      return buildServerProvider({
        provider: PROVIDER,
        enabled: openCodeSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "warning",
          auth: { status: "unknown" },
          message: detail
            ? `OpenCode CLI is installed but failed to run. ${detail}`
            : "OpenCode CLI is installed but failed to run.",
        },
      });
    }

    return buildServerProvider({
      provider: PROVIDER,
      enabled: openCodeSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "ready",
        auth: { status: "unknown" },
        message: "OpenCode CLI is installed and reachable.",
      },
    });
  },
);

export const OpenCodeProviderLive = Layer.effect(
  OpenCodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkOpenCodeProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<OpenCodeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.opencode),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.opencode),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
