import { ChevronDown, ChevronUp, Inbox, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router";
import { SiteHeader } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Pagination } from "~/components/ui/pagination";
import { Skeleton } from "~/components/ui/skeleton";
import { useConsolidationRecords } from "~/hooks/use-consolidation-records";
import type { ConsolidationState } from "~/lib/types";
import { generateMeta } from "~/utils/meta";

// Heavy components (viem/wagmi/CCTP/LiFi/Odos execution stack) are only needed when
// a card is expanded, so keep them out of the initial route chunk for fast navigation.
const ConsolidationTokensSummary = lazy(() =>
  import("~/components/consolidation-tokens-summary").then((m) => ({ default: m.ConsolidationTokensSummary })),
);
const TransactionPlanViewer = lazy(() =>
  import("~/components/transaction-plan/transaction-plan-viewer").then((m) => ({ default: m.TransactionPlanViewer })),
);

const PAGE_SIZE = 10;

export function meta() {
  return generateMeta({
    title: "History",
    description: "View your consolidation transaction history",
    url: "/history",
    noIndex: true,
  });
}

export default function History() {
  const { consolidations, removeConsolidation, clearAll } = useConsolidationRecords();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);

  const pageCount = Math.max(1, Math.ceil(consolidations.length / PAGE_SIZE));
  const pagedConsolidations = consolidations.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);

  useEffect(() => {
    if (pageIndex > 0 && pageIndex >= pageCount) {
      setPageIndex(pageCount - 1);
    }
  }, [pageCount, pageIndex]);

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
    <div className="flex flex-col min-h-svh bg-linear-to-br from-background to-accent/10">
      <SiteHeader />
      <main className="flex-1 p-4">
        <div className="w-full max-w-7xl mx-auto">
          <div className="mb-6 flex items-center justify-between py-4">
            <h2 className="font-grotesque text-2xl font-semibold tracking-[0.01em]">Consolidation History</h2>
            <div className="flex items-center gap-2">
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
              <Link to="/dashboard">
                <Button variant="default">Start Consolidating</Button>
              </Link>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {pagedConsolidations.map((consolidation) => (
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

              {pageCount > 1 && (
                <div className="mt-8">
                  <Pagination
                    pageIndex={pageIndex}
                    pageSize={PAGE_SIZE}
                    pageCount={pageCount}
                    onPageChange={setPageIndex}
                  />
                </div>
              )}
            </>
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

function ExpandedCardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-20 w-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-32 w-full" />
      </div>
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
        className={`bg-card/70 border-secondary/30 hover:border-secondary/60 transition-colors gap-0 py-0 ${expanded ? "border-secondary/60" : "cursor-pointer"}`}
        onClick={expanded ? undefined : onToggle}
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
            <Button
              variant="link"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            </Button>
          </CardAction>
        </CardHeader>

        {expanded && (
          <CardContent className="border-t border-border bg-muted/30 py-5 space-y-6">
            <Suspense fallback={<ExpandedCardSkeleton />}>
              {/* Source & Final Tokens */}
              <ConsolidationTokensSummary state={consolidation} />

              {/* Transaction Steps */}
              <div>
                <h4 className="text-sm font-medium mb-3 text-muted-foreground">Transaction Steps</h4>
                <div className="bg-background rounded-lg border border-border p-3">
                  <TransactionPlanViewer state={consolidation} showActions={false} />
                </div>
              </div>
            </Suspense>
          </CardContent>
        )}

        {expanded && (
          <CardFooter className="border-t border-border py-4 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setShowDeleteConfirm(true);
              }}
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              aria-label="Delete consolidation"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </Button>
          </CardFooter>
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
