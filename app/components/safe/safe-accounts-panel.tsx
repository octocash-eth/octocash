import { TriangleAlert } from "lucide-react";
import type { Address } from "viem";
import {
  AddressDisplayAvatar,
  AddressDisplayCopy,
  AddressDisplayRoot,
  AddressDisplayText,
} from "~/components/address/address-display";
import { ChainIcon } from "~/components/chain/chain-icon";
import { Checkbox } from "~/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { chains } from "~/data/supported-chains";
import type { SafeAccount, SafeChainDeployment } from "~/lib/accounts";

interface SafeAccountsPanelProps {
  safes: SafeAccount[];
  isDiscovering: boolean;
  isSafeEnabled: (safe: Address) => boolean;
  setSafeEnabled: (safe: Address, enabled: boolean) => void;
}

function DeploymentChip({ deployment }: { deployment: SafeChainDeployment }) {
  const chain = chains[deployment.chainId as keyof typeof chains];
  const chainName = chain?.name ?? `Chain ${deployment.chainId}`;
  const chip = (
    <span
      className={
        deployment.controlled
          ? "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs"
          : "inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
      }
    >
      <ChainIcon chain={chainName} className="size-3.5" />
      {chainName}
      <span className="text-muted-foreground">
        {deployment.threshold}/{deployment.owners.length}
      </span>
      {!deployment.controlled && <TriangleAlert className="size-3" aria-label="Not controlled by your key" />}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>
        {deployment.controlled
          ? `Safe v${deployment.version} — ${deployment.threshold} of ${deployment.owners.length} owners must sign`
          : "This deployment has a different owner set — funds there are not signable by your connected key"}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Lists the connected owners' discovered Safes with per-chain deployment
 * status, and lets the user opt each Safe in as a funding source. Enabled
 * Safes flow into the wallet table and consolidation planning via
 * `useSpendableAccounts`.
 */
export function SafeAccountsPanel({ safes, isDiscovering, isSafeEnabled, setSafeEnabled }: SafeAccountsPanelProps) {
  if (safes.length === 0 && !isDiscovering) return null;

  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Safe accounts</h2>
        {isDiscovering && <span className="text-xs text-muted-foreground">Scanning chains…</span>}
      </div>

      {safes.map((safe) => {
        const deployments = Object.values(safe.deployments).sort((a, b) => a.chainId - b.chainId);
        const controllable = deployments.some((deployment) => deployment.controlled);
        return (
          <div key={safe.address} className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label htmlFor={`enable-safe-${safe.address}`} className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                id={`enable-safe-${safe.address}`}
                checked={isSafeEnabled(safe.address)}
                disabled={!controllable}
                onCheckedChange={(checked) => setSafeEnabled(safe.address, checked === true)}
                aria-label={`Use Safe ${safe.address} as a funding source`}
              />
              <AddressDisplayRoot address={safe.address}>
                <AddressDisplayAvatar className="size-5" />
                <AddressDisplayText className="text-sm" />
                <AddressDisplayCopy className="size-6" />
              </AddressDisplayRoot>
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              {deployments.map((deployment) => (
                <DeploymentChip key={deployment.chainId} deployment={deployment} />
              ))}
            </div>
            {!controllable && (
              <span className="text-xs text-muted-foreground">
                No deployment is controlled by your connected wallet.
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
