import { Link } from "react-router";
import { formatUnits, zeroAddress } from "viem";
import { useToken } from "wagmi";
import { SiteHeader } from "~/components/site-header";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { SITE_DESCRIPTION, SITE_NAME } from "~/data/site";
import { chains } from "~/data/supported-chains";
import { useConsolidationRecords } from "~/hooks/use-consolidation-records";
import type { TokenAmount } from "~/lib/consolidation";
import ManualClaimDialog from "./manual-claim-dialog";

export function meta() {
  return [{ title: `History — ${SITE_NAME}` }, { name: "description", content: SITE_DESCRIPTION }];
}

function truncateAddress(addr: string, visible: number = 4) {
  return `${addr.slice(0, 2 + visible)}…${addr.slice(-visible)}`;
}

export default function History() {
  const [records] = useConsolidationRecords();

  return (
    <div className="flex flex-col min-h-svh bg-gradient-to-br from-background to-accent/10">
      <SiteHeader />
      <main className="flex-1 p-4">
        <div className="w-full max-w-7xl mx-auto">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-3xl font-semibold tracking-[0.01em]">Consolidation History</h2>
            <div className="flex items-center gap-2">
              <ManualClaimDialog />
              <Link to="/" className="text-sm text-blue-600 hover:underline">
                Back to Home
              </Link>
            </div>
          </div>

          {records.length === 0 ? (
            <div className="text-center py-16 bg-card/70 rounded-md">
              <p className="text-muted-foreground">No consolidations yet.</p>
              <p className="text-muted-foreground/80 text-sm">Run a consolidation to see it here.</p>
            </div>
          ) : (
            <div className="bg-card/70 rounded-md p-2">
              <Table>
                <TableCaption>Most recent first</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Sources</TableHead>
                    <TableHead>Destination</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((r) => {
                    const date = new Date(r.timestamp);
                    const sourceChains = Array.from(new Set(r.sourceTokens.map((t) => t.chainId)));
                    return (
                      <TableRow key={r.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">
                              {date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                            </span>
                            <span className="text-xs text-muted-foreground/80">{r.id}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              r.status === "completed"
                                ? "text-green-700 bg-green-100 px-2 py-0.5 rounded"
                                : "text-red-700 bg-red-100 px-2 py-0.5 rounded"
                            }
                          >
                            {r.status}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm text-muted-foreground flex flex-col gap-2">
                            <span className="font-medium">
                              {r.sourceTokens.length} token(s) across {sourceChains.length} chain(s)
                            </span>
                            {r.sourceTokens.map((t) => {
                              return (
                                <div key={`${t.token}-${t.chainId}`}>
                                  <TokenBalance token={t} />
                                </div>
                              );
                            })}
                          </div>
                        </TableCell>
                        <TableCell>
                          <TokenBalance token={r.destinationToken} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function TokenBalance({ token }: { token: TokenAmount }) {
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
  const { symbol, decimals } = tokenData ?? chain.nativeCurrency;

  return (
    <div className="flex flex-col">
      <span className="text-sm font-medium">
        <span className="font-bold">
          {formatUnits(token.amount, decimals)} {symbol}
        </span>{" "}
        <span className="text-muted-foreground/80">({chain.name})</span>
      </span>
      <span className="text-xs text-muted-foreground">{truncateAddress(token.walletAddress)}</span>
    </div>
  );
}
