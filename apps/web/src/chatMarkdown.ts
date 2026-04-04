function isFenceDelimiter(trimmedLine: string): boolean {
  return /^(```|~~~)/.test(trimmedLine);
}

function isTableDividerLine(trimmedLine: string): boolean {
  const normalized = trimmedLine.replace(/^\||\|$/g, "").trim();
  if (!normalized.includes("|")) {
    return false;
  }

  return normalized
    .split("|")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .every((segment) => /^:?-{3,}:?$/.test(segment));
}

function isTableRowLine(trimmedLine: string): boolean {
  if (!trimmedLine.includes("|") || isTableDividerLine(trimmedLine)) {
    return false;
  }
  const pipeCount = (trimmedLine.match(/\|/g) ?? []).length;
  return pipeCount >= 2 || /^\|.*\|$/.test(trimmedLine);
}

interface MarkdownTableBlock {
  readonly startLineIndex: number;
  readonly endLineIndex: number;
}

function findMarkdownTableBlocks(lines: readonly string[]): MarkdownTableBlock[] {
  const blocks: MarkdownTableBlock[] = [];
  let insideFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index];
    const trimmedCurrentLine = currentLine?.trim() ?? "";
    if (isFenceDelimiter(trimmedCurrentLine)) {
      insideFence = !insideFence;
      continue;
    }

    if (insideFence || !isTableRowLine(trimmedCurrentLine)) {
      continue;
    }

    const dividerLine = lines[index + 1]?.trim() ?? "";
    if (!isTableDividerLine(dividerLine)) {
      continue;
    }

    let endLineIndex = index + 1;
    while (endLineIndex + 1 < lines.length) {
      const nextTrimmedLine = lines[endLineIndex + 1]?.trim() ?? "";
      if (!isTableRowLine(nextTrimmedLine)) {
        break;
      }
      endLineIndex += 1;
    }

    blocks.push({ startLineIndex: index, endLineIndex });
    index = endLineIndex;
  }

  return blocks;
}

export function containsMarkdownTable(text: string): boolean {
  return findMarkdownTableBlocks(text.split("\n")).length > 0;
}

export function normalizeMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const blocks = findMarkdownTableBlocks(lines);
  if (blocks.length === 0) {
    return text;
  }

  const normalizedLines: string[] = [];
  let currentBlockIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const activeBlock = blocks[currentBlockIndex];
    if (!activeBlock || index < activeBlock.startLineIndex || index > activeBlock.endLineIndex) {
      normalizedLines.push(lines[index] ?? "");
      continue;
    }

    if (index === activeBlock.startLineIndex) {
      const previousNormalizedLine = normalizedLines.at(-1)?.trim() ?? "";
      if (previousNormalizedLine.length > 0) {
        normalizedLines.push("");
      }
    }

    normalizedLines.push(lines[index] ?? "");

    if (index === activeBlock.endLineIndex) {
      const nextTrimmedLine = lines[index + 1]?.trim() ?? "";
      if (nextTrimmedLine.length > 0) {
        normalizedLines.push("");
      }
      currentBlockIndex += 1;
    }
  }

  return normalizedLines.join("\n");
}
