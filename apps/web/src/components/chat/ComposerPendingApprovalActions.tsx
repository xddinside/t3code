import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";
import { XIcon, ThumbsDownIcon, ShieldCheckIcon, CheckIcon } from "lucide-react";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-foreground"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        <XIcon className="mr-1.5 size-3.5" />
        Cancel turn
      </Button>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "decline")}
        >
          <ThumbsDownIcon className="mr-1.5 size-3.5" />
          Decline
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
        >
          <ShieldCheckIcon className="mr-1.5 size-3.5" />
          Allow session
        </Button>
        <Button
          size="sm"
          variant="default"
          className="bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-700"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "accept")}
        >
          <CheckIcon className="mr-1.5 size-3.5" />
          Approve
        </Button>
      </div>
    </div>
  );
});
