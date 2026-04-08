import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { AlertCircleIcon, FileTextIcon, FileEditIcon, TerminalIcon } from "lucide-react";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const { icon: Icon, label } =
    approval.requestKind === "command"
      ? { icon: TerminalIcon, label: "Command execution" }
      : approval.requestKind === "file-read"
        ? { icon: FileTextIcon, label: "File read" }
        : { icon: FileEditIcon, label: "File modification" };

  return (
    <div className="px-4 py-3 sm:px-5 sm:py-3.5">
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
          <AlertCircleIcon className="size-5 text-amber-600 dark:text-amber-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold text-amber-600 dark:text-amber-500">
              Awaiting approval
            </span>
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Icon className="size-3.5 shrink-0" />
              {label}
            </span>
          </div>
          {approval.detail && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{approval.detail}</p>
          )}
        </div>
        {pendingCount > 1 && (
          <div className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums">
            1 of {pendingCount}
          </div>
        )}
      </div>
    </div>
  );
});
