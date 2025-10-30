import { ChevronDown, ChevronUp, Inbox, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { zeroAddress } from "viem";
import { useToken } from "wagmi";
import { ChainIcon } from "~/components/chain-icon";
import { SiteHeader } from "~/components/site-header";
import { TransactionPlanViewer } from "~/components/transaction-plan";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/ui/address-display";
import { Button } from "~/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  TokenDisplayAmount,
  TokenDisplayIcon,
  TokenDisplayRoot,
  TokenDisplaySymbol,
} from "~/components/ui/token-display";
import { SITE_DESCRIPTION, SITE_NAME } from "~/data/site";
import { chains } from "~/data/supported-chains";
import { useConsolidationRecords } from "~/hooks/use-consolidation-records";
import type { ConsolidationState, TokenAmount } from "~/lib/types";
import ManualClaimDialog from "./manual-claim-dialog";

export function meta() {
  return [{ title: `History — ${SITE_NAME}` }, { name: "description", content: SITE_DESCRIPTION }];
}

export default function History() {
  const { consolidations, removeConsolidation, clearAll } = useConsolidationRecords();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);

  const handleDelete = (id: string) => {
    removeConsolidation(id);
  };

  const handleDeleteAll = () => {
    clearAll();
    setShowDeleteAllConfirm(false);
  };

  const toggleExpanded = (id: string) => {
    const newExpanded = new Set(expandedIds);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedIds(newExpanded);
  };

  const getStatusColor = (status: ConsolidationState["status"]) => {
    switch (status) {
      case "completed":
        return "text-green-700 bg-green-100";
      case "partial":
        return "text-yellow-700 bg-yellow-100";
      case "paused":
        return "text-orange-700 bg-orange-100";
      case "executing":
        return "text-blue-700 bg-blue-100";
      default:
        return "text-gray-700 bg-gray-100";
    }
  };

  return (
    <div className="flex flex-col min-h-svh bg-gradient-to-br from-background to-accent/10">
      <SiteHeader />
      <main className="flex-1 p-4">
        <div className="w-full max-w-7xl mx-auto">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-3xl font-semibold tracking-[0.01em]">Consolidation History</h2>
            <div className="flex items-center gap-2">
              <ManualClaimDialog>
                <Button variant="outline" size="sm">
                  Manual CCTP Claim
                </Button>
              </ManualClaimDialog>
              {consolidations.length > 0 && (
                <Button variant="destructive" size="sm" onClick={() => setShowDeleteAllConfirm(true)}>
                  Clear All
                </Button>
              )}
            </div>
          </div>

          {consolidations.length === 0 ? (
            <div className="text-center py-20 bg-card/70 rounded-lg border border-border/50">
              <Inbox className="w-16 h-16 mx-auto mb-4 text-muted-foreground/50" />
              <p className="text-lg font-medium mb-2">No consolidations yet</p>
              <p className="text-muted-foreground text-sm mb-6">Run a consolidation to see it here.</p>
              <Button variant="default" asChild>
                <Link to="/">Start Consolidating</Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {consolidations.map((consolidation) => (
                <ConsolidationCard
                  key={consolidation.id}
                  consolidation={consolidation}
                  expanded={expandedIds.has(consolidation.id)}
                  onToggle={() => toggleExpanded(consolidation.id)}
                  onDelete={() => handleDelete(consolidation.id)}
                  getStatusColor={getStatusColor}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Delete All Confirmation Dialog */}
      <Dialog open={showDeleteAllConfirm} onOpenChange={setShowDeleteAllConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear All History?</DialogTitle>
            <DialogDescription>
              This will permanently delete all consolidation records. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteAllConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteAll}>
              Delete All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ConsolidationCardProps {
  consolidation: ConsolidationState;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  getStatusColor: (status: ConsolidationState["status"]) => string;
}

function ConsolidationCard({ consolidation, expanded, onToggle, onDelete, getStatusColor }: ConsolidationCardProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const date = new Date(consolidation.updatedAt);
  const sourceChains = Array.from(new Set(consolidation.sourceTokens.map((t) => t.chainId)));

  const completedSteps = consolidation.plan.filter((s) => s.status === "success").length;
  const totalSteps = consolidation.plan.length;

  const handleDeleteClick = () => {
    setShowDeleteConfirm(false);
    onDelete();
  };

  return (
    <>
      <Card
        className={`bg-card/70 border-secondary/30 hover:border-secondary/60 transition-colors gap-0 py-0 ${expanded ? "border-secondary/60" : ""}`}
      >
        <CardHeader className="py-4">
          <div className="flex items-center gap-3 mb-2">
            <CardTitle className="text-lg">
              {date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
            </CardTitle>
            <span className={`px-2.5 py-1 rounded-md text-xs font-medium ${getStatusColor(consolidation.status)}`}>
              {consolidation.status}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>
              {consolidation.sourceTokens.length} token{consolidation.sourceTokens.length !== 1 ? "s" : ""} across{" "}
              {sourceChains.length} chain{sourceChains.length !== 1 ? "s" : ""}
            </span>
            <span className="text-muted-foreground/50">•</span>
            <span>
              {completedSteps}/{totalSteps} steps completed
            </span>
          </div>
          <div className="text-xs text-muted-foreground/70 mt-1">ID: {consolidation.id}</div>

          <CardAction>
            <div className="flex items-center gap-1">
              <Button variant="link" size="icon" onClick={onToggle} aria-label={expanded ? "Collapse" : "Expand"}>
                {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              </Button>
              <Button
                variant="link"
                size="icon"
                onClick={() => setShowDeleteConfirm(true)}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                aria-label="Delete consolidation"
              >
                <Trash2 className="w-5 h-5" />
              </Button>
            </div>
          </CardAction>
        </CardHeader>

        {expanded && (
          <CardContent className="border-t border-border bg-muted/30 py-5 space-y-6">
            {/* Source & Destination Tokens */}
            <div className="grid md:grid-cols-2 gap-4">
              {/* Source Tokens */}
              <div>
                <h4 className="text-sm font-medium mb-3 text-muted-foreground">Source Tokens</h4>
                <div className="space-y-2">
                  {consolidation.sourceTokens.map((token, idx) => (
                    <TokenCard key={`${token.token}-${token.chainId}-${idx}`} token={token} />
                  ))}
                </div>
              </div>

              {/* Destination Token */}
              <div>
                <h4 className="text-sm font-medium mb-3 text-muted-foreground">Destination</h4>
                <TokenCard
                  token={{
                    ...consolidation.destinationToken,
                    amount: 0n,
                    symbol: "USDC",
                    decimals: 6,
                  }}
                />
              </div>
            </div>

            {/* Transaction Steps */}
            <div>
              <h4 className="text-sm font-medium mb-3 text-muted-foreground">Transaction Steps</h4>
              <div className="bg-background rounded-lg border border-border p-3">
                <TransactionPlanViewer state={consolidation} showActions={false} />
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Consolidation?</DialogTitle>
            <DialogDescription>
              This will permanently delete this consolidation record. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteClick}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TokenCard({ token }: { token: TokenAmount }) {
  const { data: tokenData } = useToken({
    address: token.token,
    chainId: token.chainId,
    query: {
      enabled: token.token !== zeroAddress,
    },
  });

  if (token.token !== zeroAddress && !tokenData) {
    return null;
  }

  const chain = chains[token.chainId as keyof typeof chains];
  const chainName = chain?.name || `Chain ${token.chainId}`;

  return (
    <div className="bg-background rounded-lg border border-border p-3 space-y-2">
      {/* Token Info */}
      <TokenDisplayRoot tokenAddress={token.token} chainId={token.chainId} symbol={token.symbol} className="gap-2">
        <div className="flex items-center gap-2 flex-1">
          <TokenDisplayIcon className="size-4" />
          <TokenDisplaySymbol />
          {token.amount > 0n && (
            <span className="ml-auto font-semibold text-sm">
              <TokenDisplayAmount amount={token.amount} />
            </span>
          )}
        </div>
      </TokenDisplayRoot>

      {/* Chain & Wallet Info */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <ChainIcon chain={chainName} className="size-4" />
          <span>{chainName}</span>
        </div>
        <div className="text-muted-foreground">
          <AddressDisplayRoot address={token.walletAddress} className="gap-1.5">
            <AddressDisplayAvatar className="size-3" />
            <AddressDisplayText />
          </AddressDisplayRoot>
        </div>
      </div>
    </div>
  );
}
