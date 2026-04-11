import type { GitStatusResult } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const GIT_CWD = "/repo/project";
const BRANCH_NAME = "feature/toast-scope";

const {
  invalidateGitQueriesSpy,
  invalidateGitStatusQuerySpy,
  gitStatusState,
  runStackedActionMutateAsyncSpy,
  setThreadBranchSpy,
  toastAddSpy,
  toastCloseSpy,
  toastPromiseSpy,
  toastUpdateSpy,
} = vi.hoisted(() => ({
  invalidateGitQueriesSpy: vi.fn(() => Promise.resolve()),
  invalidateGitStatusQuerySpy: vi.fn(() => Promise.resolve()),
  runStackedActionMutateAsyncSpy: vi.fn(() => new Promise<never>(() => undefined)),
  setThreadBranchSpy: vi.fn(),
  toastAddSpy: vi.fn(() => "toast-1"),
  toastCloseSpy: vi.fn(),
  toastPromiseSpy: vi.fn(),
  toastUpdateSpy: vi.fn(),
  gitStatusState: (() => {
    const defaultStatus: GitStatusResult = {
      isRepo: true,
      hasOriginRemote: true,
      hasUpstream: true,
      branch: "feature/toast-scope",
      isDefaultBranch: false,
      aheadCount: 1,
      behindCount: 0,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      pr: null,
    };
    let currentStatus: GitStatusResult = {
      ...defaultStatus,
      workingTree: { ...defaultStatus.workingTree, files: [...defaultStatus.workingTree.files] },
    };
    return {
      get: () => ({
        ...currentStatus,
        workingTree: {
          ...currentStatus.workingTree,
          files: [...currentStatus.workingTree.files],
        },
      }),
      set: (next: GitStatusResult) => {
        currentStatus = {
          ...next,
          workingTree: {
            ...next.workingTree,
            files: [...next.workingTree.files],
          },
        };
      },
      reset: () => {
        currentStatus = {
          ...defaultStatus,
          workingTree: {
            ...defaultStatus.workingTree,
            files: [...defaultStatus.workingTree.files],
          },
        };
      },
    };
  })(),
}));

function setMockGitStatus(status: GitStatusResult) {
  gitStatusState.set(status);
}

function resetMockGitStatus() {
  gitStatusState.reset();
}

function getMockGitStatus() {
  return gitStatusState.get();
}

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useIsMutating: vi.fn(() => 0),
    useMutation: vi.fn((options: { __kind?: string }) => {
      if (options.__kind === "run-stacked-action") {
        return {
          mutateAsync: runStackedActionMutateAsyncSpy,
          isPending: false,
        };
      }

      if (options.__kind === "pull") {
        return {
          mutateAsync: vi.fn(),
          isPending: false,
        };
      }

      return {
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        isPending: false,
      };
    }),
    useQuery: vi.fn((options: { queryKey?: string[] }) => {
      if (options.queryKey?.[0] === "git-status") {
        const status = getMockGitStatus();
        return {
          data: status,
          error: null,
        };
      }

      if (options.queryKey?.[0] === "git-branches") {
        const status = getMockGitStatus();
        return {
          data: {
            isRepo: true,
            hasOriginRemote: true,
            branches: [
              {
                name: status.branch ?? BRANCH_NAME,
                current: true,
                isDefault: status.isDefaultBranch,
                worktreePath: null,
              },
            ],
          },
          error: null,
        };
      }

      return { data: null, error: null };
    }),
    useQueryClient: vi.fn(() => ({})),
  };
});

vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: toastAddSpy,
    close: toastCloseSpy,
    promise: toastPromiseSpy,
    update: toastUpdateSpy,
  },
}));

vi.mock("~/editorPreferences", () => ({
  openInPreferredEditor: vi.fn(),
}));

vi.mock("~/lib/gitReactQuery", () => ({
  gitBranchesQueryOptions: vi.fn(() => ({ queryKey: ["git-branches"] })),
  gitInitMutationOptions: vi.fn(() => ({ __kind: "init" })),
  gitMutationKeys: {
    pull: vi.fn(() => ["pull"]),
    runStackedAction: vi.fn(() => ["run-stacked-action"]),
  },
  gitPullMutationOptions: vi.fn(() => ({ __kind: "pull" })),
  gitRunStackedActionMutationOptions: vi.fn(() => ({ __kind: "run-stacked-action" })),
  gitStatusQueryOptions: vi.fn(() => ({ queryKey: ["git-status"] })),
  invalidateGitQueries: invalidateGitQueriesSpy,
  invalidateGitStatusQuery: invalidateGitStatusQuerySpy,
}));

vi.mock("~/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("~/lib/utils")>("~/lib/utils");

  return {
    ...actual,
    newCommandId: vi.fn(() => "command-1"),
    randomUUID: vi.fn(() => "action-1"),
  };
});

vi.mock("~/nativeApi", () => ({
  readNativeApi: vi.fn(() => null),
}));

vi.mock("~/store", () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      setThreadBranch: setThreadBranchSpy,
      threads: [
        { id: THREAD_A, branch: BRANCH_NAME, worktreePath: null },
        { id: THREAD_B, branch: BRANCH_NAME, worktreePath: null },
      ],
    }),
}));

vi.mock("~/terminal-links", () => ({
  resolvePathLinkTarget: vi.fn(),
}));

import GitActionsControl from "./GitActionsControl";

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

function findMenuItemByText(text: string): HTMLElement | null {
  return (Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
    item.textContent?.includes(text),
  ) ?? null) as HTMLElement | null;
}

function Harness() {
  const [activeThreadId, setActiveThreadId] = useState(THREAD_A);

  return (
    <>
      <button type="button" onClick={() => setActiveThreadId(THREAD_B)}>
        Switch thread
      </button>
      <GitActionsControl gitCwd={GIT_CWD} activeThreadId={activeThreadId} />
    </>
  );
}

function CompactMenuHarness() {
  return (
    <Menu>
      <MenuTrigger render={<button type="button">More actions</button>} />
      <MenuPopup align="end">
        <GitActionsControl gitCwd={GIT_CWD} activeThreadId={THREAD_A} compact />
      </MenuPopup>
    </Menu>
  );
}

describe("GitActionsControl thread-scoped progress toast", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetMockGitStatus();
    document.body.innerHTML = "";
  });

  it("keeps an in-flight git action toast pinned to the thread that started it", async () => {
    vi.useFakeTimers();

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<Harness />, { container: host });

    try {
      const quickActionButton = findButtonByText("Push & create PR");
      expect(quickActionButton, 'Unable to find button containing "Push & create PR"').toBeTruthy();
      if (!(quickActionButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Push & create PR"');
      }
      quickActionButton.click();

      expect(toastAddSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { threadId: THREAD_A },
          title: "Pushing...",
          type: "loading",
        }),
      );

      await vi.advanceTimersByTimeAsync(1_000);

      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({
          data: { threadId: THREAD_A },
          title: "Pushing...",
          type: "loading",
        }),
      );

      const switchThreadButton = findButtonByText("Switch thread");
      expect(switchThreadButton, 'Unable to find button containing "Switch thread"').toBeTruthy();
      if (!(switchThreadButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Switch thread"');
      }
      switchThreadButton.click();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({
          data: { threadId: THREAD_A },
          title: "Pushing...",
          type: "loading",
        }),
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps compact quick actions mounted when default-branch confirmation is required", async () => {
    setMockGitStatus({
      isRepo: true,
      hasOriginRemote: true,
      hasUpstream: true,
      branch: "main",
      isDefaultBranch: true,
      aheadCount: 0,
      behindCount: 0,
      hasWorkingTreeChanges: true,
      workingTree: { files: [], insertions: 4, deletions: 1 },
      pr: null,
    });

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<CompactMenuHarness />, { container: host });

    try {
      const menuTrigger = findButtonByText("More actions");
      expect(menuTrigger, 'Unable to find button containing "More actions"').toBeTruthy();
      if (!(menuTrigger instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "More actions"');
      }
      menuTrigger.click();

      const quickActionItem = findMenuItemByText("Commit & push");
      expect(quickActionItem, 'Unable to find menu item containing "Commit & push"').toBeTruthy();
      if (!(quickActionItem instanceof HTMLElement)) {
        throw new Error('Unable to find menu item containing "Commit & push"');
      }
      quickActionItem.click();

      expect(document.body.textContent).toContain("Commit & push to default branch?");
      expect(runStackedActionMutateAsyncSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
