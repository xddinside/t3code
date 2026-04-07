import { Schema } from "effect";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export const Skill: Schema.Schema<Skill> = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  path: Schema.String,
});

export class SkillsListError extends Schema.TaggedErrorClass<SkillsListError>()("SkillsListError", {
  message: Schema.String,
}) {}

export const SkillsListInput = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.Literals(["codex", "claudeAgent", "opencode"])),
});

export const SkillsListResult = Schema.Array(Skill);
