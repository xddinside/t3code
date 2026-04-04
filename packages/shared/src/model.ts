import {
  CLAUDE_CODE_EFFORT_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  OPENCODE_REASONING_EFFORT_OPTIONS,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type ClaudeCodeEffort,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type ModelCapabilities,
  type ModelSelection,
  type OpenCodeModelOptions,
  type OpenCodeReasoningEffort,
  type ProviderKind,
  type ProviderReasoningEffort,
} from "@t3tools/contracts";

const MODEL_SLUG_SET_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  claudeAgent: new Set(MODEL_OPTIONS_BY_PROVIDER.claudeAgent.map((option) => option.slug)),
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  opencode: new Set(MODEL_OPTIONS_BY_PROVIDER.opencode.map((option) => option.slug)),
};

function hasKnownModelSlug(provider: ProviderKind, slug: string): boolean {
  return (MODEL_SLUG_SET_BY_PROVIDER[provider] as ReadonlySet<string>).has(slug);
}

const CLAUDE_OPUS_4_6_MODEL = "claude-opus-4-6";
const CLAUDE_SONNET_4_6_MODEL = "claude-sonnet-4-6";
const CLAUDE_HAIKU_4_5_MODEL = "claude-haiku-4-5";

export interface SelectableModelOption {
  slug: string;
  name: string;
}

// ── Effort helpers ────────────────────────────────────────────────────

/** Check whether a capabilities object includes a given effort value. */
export function hasEffortLevel(caps: ModelCapabilities, value: string): boolean {
  return caps.reasoningEffortLevels.some((l) => l.value === value);
}

/** Return the default effort value for a capabilities object, or null if none. */
export function getDefaultEffort(caps: ModelCapabilities): string | null {
  return caps.reasoningEffortLevels.find((l) => l.isDefault)?.value ?? null;
}

/**
 * Resolve a raw effort option against capabilities.
 *
 * Returns the effective effort value — the explicit value if supported and not
 * prompt-injected, otherwise the model's default. Returns `undefined` only
 * when the model has no effort levels at all.
 *
 * Prompt-injected efforts (e.g. "ultrathink") are excluded because they are
 * applied via prompt text, not the effort API parameter.
 */
export function resolveEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultEffort(caps);
  const trimmed = typeof raw === "string" ? raw.trim() : null;
  if (
    trimmed &&
    !caps.promptInjectedEffortLevels.includes(trimmed) &&
    hasEffortLevel(caps, trimmed)
  ) {
    return trimmed;
  }
  return defaultValue ?? undefined;
}

// ── Context window helpers ───────────────────────────────────────────

/** Check whether a capabilities object includes a given context window value. */
export function hasContextWindowOption(caps: ModelCapabilities, value: string): boolean {
  return caps.contextWindowOptions.some((o) => o.value === value);
}

/** Return the default context window value, or `null` if none is defined. */
export function getDefaultContextWindow(caps: ModelCapabilities): string | null {
  return caps.contextWindowOptions.find((o) => o.isDefault)?.value ?? null;
}

/**
 * Resolve a raw `contextWindow` option against capabilities.
 *
 * Returns the effective context window value — the explicit value if supported,
 * otherwise the model's default. Returns `undefined` only when the model has
 * no context window options at all.
 *
 * Unlike effort levels (where the API has matching defaults), the context
 * window requires an explicit API suffix (e.g. `[1m]`), so we always preserve
 * the resolved value to avoid ambiguity between "user chose the default" and
 * "not specified".
 */
export function resolveContextWindow(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultContextWindow(caps);
  if (!raw) return defaultValue ?? undefined;
  return hasContextWindowOption(caps, raw) ? raw : (defaultValue ?? undefined);
}

export function normalizeCodexModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const reasoningEffort = resolveEffort(caps, modelOptions?.reasoningEffort);
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort
      ? { reasoningEffort: reasoningEffort as CodexModelOptions["reasoningEffort"] }
      : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const effort = resolveEffort(caps, modelOptions?.effort);
  const thinking = caps.supportsThinkingToggle ? modelOptions?.thinking : undefined;
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: ClaudeModelOptions = {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort ? { effort: effort as ClaudeModelOptions["effort"] } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, string>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

export function resolveSelectableModel(
  provider: ProviderKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

export function resolveModelSlug(model: string | null | undefined, provider: ProviderKind): string {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }
  return normalized;
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): string {
  return resolveModelSlug(model, provider);
}

/** Trim a string, returning null for empty/missing values. */
export function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

/**
 * Resolve the actual API model identifier from a model selection.
 *
 * Provider-aware: each provider can map `contextWindow` (or other options)
 * to whatever the API requires — a model-id suffix, a separate parameter, etc.
 * The canonical slug stored in the selection stays unchanged so the
 * capabilities system keeps working.
 *
 * Expects `contextWindow` to already be resolved (via `resolveContextWindow`)
 * to the effective value, not stripped to `undefined` for defaults.
 */
export function buildModelSelection(
  provider: "codex",
  model: string,
  options?: CodexModelOptions,
): Extract<ModelSelection, { provider: "codex" }>;
export function buildModelSelection(
  provider: "claudeAgent",
  model: string,
  options?: ClaudeModelOptions,
): Extract<ModelSelection, { provider: "claudeAgent" }>;
export function buildModelSelection(
  provider: "opencode",
  model: string,
  options?: OpenCodeModelOptions,
): Extract<ModelSelection, { provider: "opencode" }>;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: CodexModelOptions | ClaudeModelOptions | OpenCodeModelOptions,
): ModelSelection;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: CodexModelOptions | ClaudeModelOptions | OpenCodeModelOptions,
): ModelSelection {
  switch (provider) {
    case "codex":
      return options === undefined
        ? { provider, model }
        : { provider, model, options: options as CodexModelOptions };
    case "claudeAgent":
      return options === undefined
        ? { provider, model }
        : { provider, model, options: options as ClaudeModelOptions };
    case "opencode":
      return options === undefined
        ? { provider, model }
        : { provider, model, options: options as OpenCodeModelOptions };
  }
}

export function inferProviderForModel(
  model: string | null | undefined,
  fallback: ProviderKind = "codex",
): ProviderKind {
  const normalizedClaude = normalizeModelSlug(model, "claudeAgent");
  if (normalizedClaude && hasKnownModelSlug("claudeAgent", normalizedClaude)) {
    return "claudeAgent";
  }

  const normalizedCodex = normalizeModelSlug(model, "codex");
  if (normalizedCodex && hasKnownModelSlug("codex", normalizedCodex)) {
    return "codex";
  }

  const normalizedOpenCode = normalizeModelSlug(model, "opencode");
  if (normalizedOpenCode && hasKnownModelSlug("opencode", normalizedOpenCode)) {
    return "opencode";
  }

  if (typeof model === "string") {
    const trimmed = model.trim();
    if (trimmed.startsWith("claude-")) {
      return "claudeAgent";
    }
    if (
      trimmed === "big-pickle" ||
      trimmed === "gpt-5-nano" ||
      trimmed.startsWith("minimax-") ||
      trimmed.startsWith("mimo-") ||
      trimmed.startsWith("nemotron-") ||
      trimmed.startsWith("qwen")
    ) {
      return "opencode";
    }
  }

  return fallback;
}
export function resolveApiModelId(modelSelection: ModelSelection): string {
  switch (modelSelection.provider) {
    case "claudeAgent": {
      switch (modelSelection.options?.contextWindow) {
        case "1m":
          return `${modelSelection.model}[1m]`;
        default:
          return modelSelection.model;
      }
    }
    default: {
      return modelSelection.model;
    }
  }
}

export function supportsClaudeMaxEffort(model: string | null | undefined): boolean {
  const normalized = normalizeModelSlug(model, "claudeAgent");
  return normalized === CLAUDE_OPUS_4_6_MODEL;
}

export function supportsClaudeUltrathinkKeyword(model: string | null | undefined): boolean {
  const normalized = normalizeModelSlug(model, "claudeAgent");
  return normalized === CLAUDE_OPUS_4_6_MODEL || normalized === CLAUDE_SONNET_4_6_MODEL;
}

export function supportsClaudeThinkingToggle(model: string | null | undefined): boolean {
  const normalized = normalizeModelSlug(model, "claudeAgent");
  return normalized === CLAUDE_HAIKU_4_5_MODEL;
}

export function supportsClaudeFastMode(model: string | null | undefined): boolean {
  const normalized = normalizeModelSlug(model, "claudeAgent");
  return normalized === CLAUDE_OPUS_4_6_MODEL;
}

export function getReasoningEffortOptions(provider: "codex"): ReadonlyArray<CodexReasoningEffort>;
export function getReasoningEffortOptions(
  provider: "claudeAgent",
  model?: string | null | undefined,
): ReadonlyArray<ClaudeCodeEffort>;
export function getReasoningEffortOptions(
  provider: "opencode",
  model?: string | null | undefined,
): ReadonlyArray<OpenCodeReasoningEffort>;
export function getReasoningEffortOptions(
  provider?: ProviderKind,
  model?: string | null | undefined,
): ReadonlyArray<ProviderReasoningEffort>;
export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
  model?: string | null | undefined,
): ReadonlyArray<ProviderReasoningEffort> {
  if (provider === "claudeAgent" && supportsClaudeMaxEffort(model)) {
    return ["low", "medium", "high", "max", "ultrathink"];
  }
  return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: "claudeAgent"): ClaudeCodeEffort;
export function getDefaultReasoningEffort(provider: "opencode"): OpenCodeReasoningEffort;
export function getDefaultReasoningEffort(provider?: ProviderKind): ProviderReasoningEffort;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): ProviderReasoningEffort {
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider];
}

export function resolveReasoningEffortForProvider(
  provider: "codex",
  effort: string | null | undefined,
): CodexReasoningEffort | null;
export function resolveReasoningEffortForProvider(
  provider: "claudeAgent",
  effort: string | null | undefined,
): ClaudeCodeEffort | null;
export function resolveReasoningEffortForProvider(
  provider: "opencode",
  effort: string | null | undefined,
): OpenCodeReasoningEffort | null;
export function resolveReasoningEffortForProvider(
  provider: ProviderKind,
  effort: string | null | undefined,
): ProviderReasoningEffort | null;
export function resolveReasoningEffortForProvider(
  provider: ProviderKind,
  effort: string | null | undefined,
): ProviderReasoningEffort | null {
  if (typeof effort !== "string") {
    return null;
  }

  const trimmed = effort.trim();
  if (!trimmed) {
    return null;
  }

  const options = REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider] as ReadonlyArray<string>;
  return options.includes(trimmed) ? (trimmed as ProviderReasoningEffort) : null;
}

export function getEffectiveClaudeCodeEffort(
  effort: ClaudeCodeEffort | null | undefined,
): Exclude<ClaudeCodeEffort, "ultrathink"> | null {
  if (!effort) {
    return null;
  }
  return effort === "ultrathink" ? null : effort;
}

export function normalizeCodexModelOptions(
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const defaultReasoningEffort = getDefaultReasoningEffort("codex");
  const reasoningEffort =
    resolveReasoningEffortForProvider("codex", modelOptions?.reasoningEffort) ??
    defaultReasoningEffort;
  const fastModeEnabled = modelOptions?.fastMode === true;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort !== defaultReasoningEffort ? { reasoningEffort } : {}),
    ...(fastModeEnabled ? { fastMode: true } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptions(
  model: string | null | undefined,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const reasoningOptions = getReasoningEffortOptions("claudeAgent", model);
  const defaultReasoningEffort = getDefaultReasoningEffort("claudeAgent");
  const resolvedEffort = resolveReasoningEffortForProvider("claudeAgent", modelOptions?.effort);
  const effort =
    resolvedEffort &&
    resolvedEffort !== "ultrathink" &&
    reasoningOptions.includes(resolvedEffort) &&
    resolvedEffort !== defaultReasoningEffort
      ? resolvedEffort
      : undefined;
  const thinking =
    supportsClaudeThinkingToggle(model) && modelOptions?.thinking === false ? false : undefined;
  const fastMode =
    supportsClaudeFastMode(model) && modelOptions?.fastMode === true ? true : undefined;
  const nextOptions: ClaudeModelOptions = {
    ...(thinking === false ? { thinking: false } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode: true } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeOpenCodeModelOptions(
  modelOptions: OpenCodeModelOptions | null | undefined,
  allowedVariants?: ReadonlyArray<string> | null | undefined,
): OpenCodeModelOptions | undefined {
  const rawVariant = modelOptions?.variant;
  const resolvedVariant = typeof rawVariant === "string" ? rawVariant.trim() : undefined;
  if (!resolvedVariant) {
    return undefined;
  }

  if (
    allowedVariants &&
    allowedVariants.length > 0 &&
    !allowedVariants.some((variant) => variant.toLowerCase() === resolvedVariant.toLowerCase())
  ) {
    return undefined;
  }

  const defaultVariant = getDefaultReasoningEffort("opencode");
  if (resolvedVariant === defaultVariant) {
    return undefined;
  }

  return { variant: resolvedVariant };
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: ClaudeCodeEffort | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}

export {
  CLAUDE_CODE_EFFORT_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  OPENCODE_REASONING_EFFORT_OPTIONS,
};
