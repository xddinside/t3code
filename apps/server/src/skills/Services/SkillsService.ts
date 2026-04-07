import readline from "node:readline";
import { spawn } from "node:child_process";
import { Effect, FileSystem, Layer, ServiceMap } from "effect";

import { Skill, SkillsListError, type SkillsListInput } from "@t3tools/contracts";

import { buildCodexInitializeParams, killCodexChildProcess } from "../../provider/codexAppServer";
import { ServerSettingsService } from "../../serverSettings";

interface CodexSkillsListResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly message?: unknown;
  };
}

function readCodexErrorMessage(response: CodexSkillsListResponse): string | undefined {
  return typeof response.error?.message === "string" ? response.error.message : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function mapCodexSkill(raw: unknown): Skill | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const enabled = record.enabled;
  if (enabled === false) {
    return null;
  }

  const name = asString(record.name)?.trim();
  const path = asString(record.path)?.trim();
  const description =
    asString(record.description)?.trim() ??
    asString(asRecord(record.interface)?.shortDescription)?.trim() ??
    "";

  if (!name || !path) {
    return null;
  }

  return { name, description, path };
}

async function probeCodexSkills(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): Promise<Array<Skill>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, ["app-server"], {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const output = readline.createInterface({ input: child.stdout });

    let completed = false;

    const cleanup = () => {
      output.removeAllListeners();
      output.close();
      child.removeAllListeners();
      if (!child.killed) {
        killCodexChildProcess(child);
      }
    };

    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      cleanup();
      callback();
    };

    const fail = (error: unknown) =>
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error(`Codex skill discovery failed: ${String(error)}.`),
        ),
      );

    const writeMessage = (message: unknown) => {
      if (!child.stdin.writable) {
        fail(new Error("Cannot write to codex app-server stdin."));
        return;
      }

      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(new Error("Received invalid JSON from codex app-server during skill discovery."));
        return;
      }

      const response = parsed as CodexSkillsListResponse;
      if (response.id === 1) {
        const errorMessage = readCodexErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`initialize failed: ${errorMessage}`));
          return;
        }

        writeMessage({ method: "initialized" });
        writeMessage({ id: 2, method: "skills/list", params: {} });
        return;
      }

      if (response.id === 2) {
        const errorMessage = readCodexErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`skills/list failed: ${errorMessage}`));
          return;
        }

        const result = asRecord(response.result);
        const groups = asArray(result?.data);
        const skills = groups.flatMap((group) =>
          asArray(asRecord(group)?.skills)
            .map(mapCodexSkill)
            .filter((skill) => skill !== null),
        );
        finish(() => resolve(skills));
      }
    });

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (completed) return;
      fail(
        new Error(
          `codex app-server exited before skill discovery completed (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });

    writeMessage({
      id: 1,
      method: "initialize",
      params: buildCodexInitializeParams(),
    });
  });
}

function readSkillDescription(content: string): string {
  const descriptionMatch = /^description:\s*(.+)$/m.exec(content);
  return descriptionMatch?.[1]?.trim() ?? "";
}

function readSkillName(content: string, skillPath: string): string {
  const nameMatch = /^name:\s*(.+)$/m.exec(content);
  return nameMatch?.[1]?.trim() ?? skillPath.split("/").pop() ?? "unknown";
}

function readSkillMeta(skillDirectoryPath: string): Effect.Effect<Skill | null, SkillsListError> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const skillMetaPath = `${skillDirectoryPath}/SKILL.md`;
    const skillMetaStat = yield* fs
      .stat(skillMetaPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (skillMetaStat?.type !== "File") {
      return null;
    }

    const content = yield* fs.readFileString(skillMetaPath).pipe(
      Effect.mapError(
        (cause) =>
          new SkillsListError({
            message: `Failed to read skill file: ${cause}`,
          }),
      ),
    );

    return {
      name: readSkillName(content, skillDirectoryPath),
      description: readSkillDescription(content),
      path: skillMetaPath,
    } satisfies Skill;
  });
}

function collectSkillDirectoryCandidates(cwd: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  let current = cwd;
  while (true) {
    const candidate = `${current}/.agents/skills`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }

    const lastSlashIndex = current.lastIndexOf("/");
    const next = lastSlashIndex <= 0 ? "/" : current.slice(0, lastSlashIndex);
    if (next === current) {
      break;
    }
    current = next;
  }

  const homeDirectory = process.env.HOME;
  if (homeDirectory) {
    const candidate = `${homeDirectory}/.agents/skills`;
    if (!seen.has(candidate)) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function scanSkillsInDirectory(dirPath: string): Effect.Effect<Array<Skill>, SkillsListError> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const exists = yield* fs.exists(dirPath).pipe(
      Effect.mapError(
        (cause) =>
          new SkillsListError({
            message: `Failed to check skills directory: ${cause}`,
          }),
      ),
    );
    if (!exists) {
      return [];
    }

    const entries = yield* fs.readDirectory(dirPath, { recursive: false }).pipe(
      Effect.mapError(
        (cause) =>
          new SkillsListError({
            message: `Failed to read skills directory: ${cause}`,
          }),
      ),
    );

    const skills: Array<Skill> = [];
    for (const entryName of entries) {
      const entryPath = `${dirPath}/${entryName}`;
      const stat = yield* fs.stat(entryPath).pipe(Effect.catch(() => Effect.succeed(null)));
      if (stat?.type !== "Directory") {
        continue;
      }

      const skill = yield* readSkillMeta(entryPath);
      if (skill) {
        skills.push(skill);
      }
    }

    return skills;
  });
}

function scanFilesystemSkills(cwd: string): Effect.Effect<Array<Skill>, SkillsListError> {
  return Effect.gen(function* () {
    const allSkills: Array<Skill> = [];
    const seenSkillPaths = new Set<string>();

    for (const skillsPath of collectSkillDirectoryCandidates(cwd)) {
      const skills = yield* scanSkillsInDirectory(skillsPath);
      for (const skill of skills) {
        if (seenSkillPaths.has(skill.path)) {
          continue;
        }
        seenSkillPaths.add(skill.path);
        allSkills.push(skill);
      }
    }

    return allSkills;
  });
}

export interface SkillsServiceShape {
  listSkills(input?: typeof SkillsListInput.Type): Effect.Effect<Array<Skill>, SkillsListError>;
}

export class SkillsService extends ServiceMap.Service<SkillsService, SkillsServiceShape>()(
  "t3/server/Services/SkillsService",
) {}

export const makeSkillsService = (): SkillsServiceShape => ({
  listSkills: (input): Effect.Effect<Array<Skill>, SkillsListError> =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new SkillsListError({
              message: `Failed to read server settings: ${cause}`,
            }),
        ),
      );

      const targetCwd = input?.cwd ?? process.cwd();

      if (input?.provider === "codex") {
        const codexSettings = settings.providers.codex;
        const codexSkills = yield* Effect.tryPromise({
          try: () =>
            probeCodexSkills({
              binaryPath: codexSettings.binaryPath || "codex",
              cwd: targetCwd,
              ...(codexSettings.homePath ? { homePath: codexSettings.homePath } : {}),
            }),
          catch: (cause) =>
            new SkillsListError({
              message:
                cause instanceof Error
                  ? cause.message
                  : `Codex skill discovery failed: ${String(cause)}`,
            }),
        }).pipe(Effect.catch(() => scanFilesystemSkills(targetCwd)));

        return codexSkills;
      }

      return yield* scanFilesystemSkills(targetCwd);
    }),
});

export const SkillsServiceLive = Layer.effect(SkillsService, Effect.succeed(makeSkillsService()));
