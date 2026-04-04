import { describe, expect, it } from "vitest";
import { containsMarkdownTable, normalizeMarkdownTables } from "./chatMarkdown";

describe("chatMarkdown", () => {
  it("inserts a blank line before a pipe table that immediately follows prose", () => {
    const input = [
      "All 5 landing pages are complete and verified:",
      "|Route|Theme|Style|",
      "|---|---|---|",
      "|/1|Metrics|Dark blue gradient|",
    ].join("\n");

    expect(normalizeMarkdownTables(input)).toBe(
      [
        "All 5 landing pages are complete and verified:",
        "",
        "|Route|Theme|Style|",
        "|---|---|---|",
        "|/1|Metrics|Dark blue gradient|",
      ].join("\n"),
    );
  });

  it("inserts a blank line after a table when prose continues immediately after it", () => {
    const input = [
      "|Route|Theme|Style|",
      "|---|---|---|",
      "|/1|Metrics|Dark blue gradient|",
      "Each page has distinct colors and personality.",
    ].join("\n");

    expect(normalizeMarkdownTables(input)).toBe(
      [
        "|Route|Theme|Style|",
        "|---|---|---|",
        "|/1|Metrics|Dark blue gradient|",
        "",
        "Each page has distinct colors and personality.",
      ].join("\n"),
    );
  });

  it("does not treat pipe characters inside fenced code blocks as markdown tables", () => {
    const input = ["```md", "|not|a|table|", "|---|---|---|", "```"].join("\n");

    expect(containsMarkdownTable(input)).toBe(false);
    expect(normalizeMarkdownTables(input)).toBe(input);
  });

  it("detects a valid markdown table block", () => {
    const input = ["|a|b|", "|---|---|", "|1|2|"].join("\n");
    expect(containsMarkdownTable(input)).toBe(true);
  });
});
