import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import type { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];

export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max", "ultrathink"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];

export const OPENCODE_REASONING_EFFORT_OPTIONS = ["default", "low", "medium", "high"] as const;
export type OpenCodeReasoningEffort = (typeof OPENCODE_REASONING_EFFORT_OPTIONS)[number];

export type ProviderReasoningEffort =
  | CodexReasoningEffort
  | ClaudeCodeEffort
  | OpenCodeReasoningEffort;

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.String),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

const TrimmedVariant = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const OpenCodeModelOptions = Schema.Struct({
  variant: Schema.optional(TrimmedVariant),
});
export type OpenCodeModelOptions = typeof OpenCodeModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
  opencode: Schema.optional(OpenCodeModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export const EffortOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type EffortOption = typeof EffortOption.Type;

export const ContextWindowOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type ContextWindowOption = typeof ContextWindowOption.Type;

export interface ModelOption {
  readonly slug: string;
  readonly name: string;
}

export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { slug: "gpt-5.2", name: "GPT-5.2" },
  ],
  claudeAgent: [
    { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  opencode: [
    { slug: "glm-5.1", name: "GLM-5.1" },
    { slug: "kimi-k2.5", name: "Kimi K2.5" },
    { slug: "mimo-v2-omni", name: "MiMo V2 Omni" },
    { slug: "mimo-v2-pro", name: "MiMo V2 Pro" },
    { slug: "minimax-m2.5", name: "MiniMax M2.5" },
    { slug: "minimax-m2.7", name: "MiniMax M2.7" },
    { slug: "minimax-m2.5-free", name: "MiniMax M2.5 Free" },
  ],
} as const satisfies Record<ProviderKind, readonly ModelOption[]>;

export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;
export type ModelSlug = ModelOptionsByProvider[ProviderKind][number]["slug"];

export const ModelCapabilities = Schema.Struct({
  reasoningEffortLevels: Schema.Array(EffortOption),
  supportsFastMode: Schema.Boolean,
  supportsThinkingToggle: Schema.Boolean,
  contextWindowOptions: Schema.Array(ContextWindowOption),
  promptInjectedEffortLevels: Schema.Array(TrimmedNonEmptyString),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.4",
  claudeAgent: "claude-sonnet-4-6",
  opencode: "minimax-m2.7",
};

export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.4-mini",
  claudeAgent: "claude-haiku-4-5",
  opencode: "minimax-m2.7",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, string>> = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeAgent: {
    opus: "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
  opencode: {
    "glm 5.1": "glm-5.1",
    "kimi k2.5": "kimi-k2.5",
    "kimi-k2.5": "kimi-k2.5",
    "mimo v2 omni": "mimo-v2-omni",
    "mimo-v2-omni": "mimo-v2-omni",
    "mimo v2 pro": "mimo-v2-pro",
    "mimo-v2-pro": "mimo-v2-pro",
    "minimax m2.5": "minimax-m2.5",
    "minimax-m2.5": "minimax-m2.5",
    "minimax m2.7": "minimax-m2.7",
    "minimax-m2.7": "minimax-m2.7",
    "minimax m2.5 free": "minimax-m2.5-free",
    "minimax-m2.5-free": "minimax-m2.5-free",
  },
};

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  claudeAgent: CLAUDE_CODE_EFFORT_OPTIONS,
  opencode: OPENCODE_REASONING_EFFORT_OPTIONS,
} as const satisfies Record<ProviderKind, readonly ProviderReasoningEffort[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "high",
  claudeAgent: "high",
  opencode: "default",
} as const satisfies Record<ProviderKind, ProviderReasoningEffort>;

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  opencode: "OpenCode",
};
