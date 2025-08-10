import { Link } from "react-router";
import { formatUnits, zeroAddress } from "viem";
import { useToken } from "wagmi";
import { SiteHeader } from "~/components/site-header";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { SITE_DESCRIPTION, SITE_NAME } from "~/data/site";
import { chains, supportedChains } from "~/data/supported-chains";
import type { TokenAmount } from "~/lib/consolidation";
import { getConsolidationRecords } from "~/lib/history";

export function meta() {
  return [{ title: `History — ${SITE_NAME}` }, { name: "description", content: SITE_DESCRIPTION }];
}

function truncateAddress(addr: string, visible: number = 4) {
  return `${addr.slice(0, 2 + visible)}…${addr.slice(-visible)}`;
}

export default function History() {
  const records = getConsolidationRecords();

  const _chainIdToName = new Map<number, string>(supportedChains.map((c) => [c.id, c.name]));

  return (
    <div className="flex flex-col min-h-svh bg-gradient-to-br from-blue-50 to-purple-50">
      <SiteHeader />
      <main className="flex-1 p-4">
        <div className="w-full max-w-7xl mx-auto">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-2xl font-bold">Consolidation History</h2>
            <Link to="/" className="text-sm text-blue-600 hover:underline">
              Back to Home
            </Link>
          </div>

          {records.length === 0 ? (
            <div className="text-center py-16 bg-white/70 rounded-md">
              <p className="text-gray-600">No consolidations yet.</p>
              <p className="text-gray-500 text-sm">Run a consolidation to see it here.</p>
            </div>
          ) : (
            <div className="bg-white/70 rounded-md p-2">
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
                            <span className="text-xs text-gray-500">{r.id}</span>
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
                          <div className="text-sm text-gray-700 flex flex-col gap-2">
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
        <span className="text-gray-500">({chain.name})</span>
      </span>
      <span className="text-xs text-gray-600">{truncateAddress(token.walletAddress)}</span>
    </div>
  );
}
