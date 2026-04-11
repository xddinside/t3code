import {
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { memo } from "react";
import { DiffIcon, MoreHorizontalIcon, TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import GitActionsControl from "../GitActionsControl";

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleDiff,
}: ChatHeaderProps) {
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2.5 sm:gap-2">
      <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 overflow-hidden sm:min-h-0 sm:gap-3">
        <SidebarTrigger className="size-10 shrink-0 md:hidden sm:size-7" />
        <h2
          className="min-w-0 shrink truncate text-base font-semibold leading-none text-foreground sm:text-sm sm:font-medium sm:leading-tight"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="hidden text-[10px] sm:inline-flex sm:text-xs">
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge
            variant="outline"
            className="hidden text-[10px] text-amber-700 sm:inline-flex sm:text-xs"
          >
            No Git
          </Badge>
        )}
      </div>

      {/* Desktop: all buttons inline */}
      <div className="hidden sm:flex shrink-0 items-center gap-1.5 sm:gap-2 @3xl/header-actions:gap-3">
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {activeProjectName && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="sm"
                disabled={!terminalAvailable}
              >
                <TerminalSquareIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!terminalAvailable
              ? "Terminal is unavailable until this thread has an active project."
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="sm"
                disabled={!isGitRepo}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
      </div>

      {/* Mobile: single overflow menu */}
      <div className="flex min-h-10 shrink-0 items-center sm:hidden">
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="More actions">
                <MoreHorizontalIcon className="size-4" />
              </Button>
            }
          />
          <MenuPopup align="end" className="min-w-44">
            <MenuItem onClick={onToggleTerminal} disabled={!terminalAvailable}>
              <span className="flex items-center gap-2">
                <TerminalSquareIcon className="size-4" />
                {terminalOpen ? "Hide terminal" : "Show terminal"}
              </span>
            </MenuItem>
            <MenuItem onClick={onToggleDiff} disabled={!isGitRepo}>
              <span className="flex items-center gap-2">
                <DiffIcon className="size-4" />
                {diffOpen ? "Hide diff" : "Show diff"}
              </span>
            </MenuItem>
            {activeProjectName && (
              <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} compact />
            )}
            {activeProjectScripts && activeProjectScripts.length > 0 && (
              <>
                <div className="border-t border-border/50" />
                <div className="px-2 py-1.5">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Scripts</p>
                  {activeProjectScripts.map((script) => (
                    <MenuItem key={script.id} onClick={() => onRunProjectScript(script)}>
                      {script.name}
                    </MenuItem>
                  ))}
                </div>
              </>
            )}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
});
