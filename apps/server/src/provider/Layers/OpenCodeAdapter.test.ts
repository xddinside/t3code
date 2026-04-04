import { describe, expect, it } from "vitest";

import {
  buildOpenCodeOrderedUserInputAnswers,
  buildOpenCodeResolvedUserInputAnswers,
  listOpenCodePendingQuestionRequestIds,
  normalizeOpenCodeUserInputQuestions,
} from "./OpenCodeAdapter";

describe("OpenCodeAdapter helpers", () => {
  it("normalizes OpenCode question metadata including multi-select support", () => {
    expect(
      normalizeOpenCodeUserInputQuestions({
        requestId: "que_123",
        questions: [
          {
            header: "Mobile issues",
            question: "What matters most?",
            multiple: true,
            options: [
              { label: "Layout", description: "Improve responsive layout" },
              { label: "Input", description: "Improve touch input" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "opencode-que_123-1",
        header: "Mobile issues",
        question: "What matters most?",
        options: [
          { label: "Layout", description: "Improve responsive layout" },
          { label: "Input", description: "Improve touch input" },
        ],
        multiSelect: true,
      },
    ]);
  });

  it("maps replied OpenCode answers back onto normalized question ids", () => {
    const questions = normalizeOpenCodeUserInputQuestions({
      requestId: "que_123",
      questions: [
        {
          header: "Mobile issues",
          question: "What matters most?",
          options: [
            { label: "Layout", description: "Improve responsive layout" },
            { label: "Input", description: "Improve touch input" },
          ],
        },
        {
          header: "Scope",
          question: "Which areas?",
          multiple: true,
          options: [
            { label: "Sidebar", description: "Sidebar work" },
            { label: "Composer", description: "Composer work" },
          ],
        },
      ],
    });

    expect(
      buildOpenCodeResolvedUserInputAnswers({
        state: {
          questionIds: questions.map((question) => question.id),
          questions,
        },
        rawAnswers: [["Layout"], ["Sidebar", "Composer"]],
      }),
    ).toEqual({
      "opencode-que_123-1": "Layout",
      "opencode-que_123-2": ["Sidebar", "Composer"],
    });
  });

  it("orders submitted answers to match OpenCode question positions", () => {
    const questions = normalizeOpenCodeUserInputQuestions({
      requestId: "que_123",
      questions: [
        {
          header: "Mobile issues",
          question: "What matters most?",
          options: [
            { label: "Layout", description: "Improve responsive layout" },
            { label: "Input", description: "Improve touch input" },
          ],
        },
        {
          header: "Scope",
          question: "Which areas?",
          multiple: true,
          options: [
            { label: "Sidebar", description: "Sidebar work" },
            { label: "Composer", description: "Composer work" },
          ],
        },
      ],
    });

    expect(
      buildOpenCodeOrderedUserInputAnswers({
        state: {
          questionIds: questions.map((question) => question.id),
          questions,
        },
        answers: {
          "opencode-que_123-2": ["Sidebar", "Composer"],
          "opencode-que_123-1": "Layout",
        },
      }),
    ).toEqual([["Layout"], ["Sidebar", "Composer"]]);
  });

  it("extracts pending OpenCode question request ids from list responses", () => {
    expect(
      listOpenCodePendingQuestionRequestIds([
        { id: "que_123", sessionID: "ses_1" },
        { id: "que_456", sessionID: "ses_2" },
        { bad: true },
      ]),
    ).toEqual(["que_123", "que_456"]);
  });
});
