import { Wallet } from "lucide-react";
import { useState } from "react";
import type { Address } from "viem";
import {
  AddressDisplayAvatar,
  AddressDisplayCopy,
  AddressDisplayRoot,
  AddressDisplayText,
} from "~/components/address/address-display";
import { DeploymentChip, groupDeployments } from "~/components/safe/deployment-chip";
import { GatedConnectButton } from "~/components/site/gated-connect-button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "~/components/ui/accordion";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";
import { useOwnedSafesForOwner } from "~/hooks/use-owned-safes";
import { useSpendableAccounts } from "~/hooks/use-spendable-accounts";
import type { SafeAccount } from "~/lib/accounts";

interface ConnectSafesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function SafeRow({
  safe,
  owner,
  isSafeEnabled,
  setSafeEnabled,
}: {
  safe: SafeAccount;
  /** The connected owner whose section this row renders under — the same
   * Safe can appear under several owners, so DOM ids are scoped by it. */
  owner: Address;
  isSafeEnabled: (safe: Address) => boolean;
  setSafeEnabled: (safe: Address, enabled: boolean) => void;
}) {
  const deployments = Object.values(safe.deployments);
  const deploymentGroups = groupDeployments(deployments);
  const controllable = deployments.some((deployment) => deployment.controlled);
  const checkboxId = `enable-safe-${owner.toLowerCase()}-${safe.address.toLowerCase()}`;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label htmlFor={checkboxId} className="flex items-center gap-2 cursor-pointer">
        <Checkbox
          id={checkboxId}
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
        {deploymentGroups.map((group) => (
          <DeploymentChip key={group[0].chainId} deployments={group} />
        ))}
      </div>
      {!controllable && (
        <span className="text-xs text-muted-foreground">No deployment is controlled by your connected wallet.</span>
      )}
    </div>
  );
}

/**
 * The list inside one owner's expanded section. Mounted collapsed too (the
 * accordion animates height), so discovery is gated on `expanded` — chains
 * are only scanned for owners the user actually opens.
 */
function OwnerSafesList({
  owner,
  expanded,
  isSafeEnabled,
  setSafeEnabled,
}: {
  owner: Address;
  expanded: boolean;
  isSafeEnabled: (safe: Address) => boolean;
  setSafeEnabled: (safe: Address, enabled: boolean) => void;
}) {
  const { safes, isLoading, error, refetch } = useOwnedSafesForOwner(owner, expanded);

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Scanning chains…</p>;
  }
  if (error) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-xs text-muted-foreground">Could not scan for Safes — the service may be rate-limited.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (safes.length === 0) {
    return <p className="text-xs text-muted-foreground">No Safes found for this address.</p>;
  }
  return (
    <div className="space-y-3">
      {safes.map((safe) => (
        <SafeRow
          key={safe.address}
          safe={safe}
          owner={owner}
          isSafeEnabled={isSafeEnabled}
          setSafeEnabled={setSafeEnabled}
        />
      ))}
    </div>
  );
}

/**
 * Lets the user opt Safes in as funding sources, grouped by the connected
 * owner key. Discovery runs per owner and only when that owner's section is
 * expanded, so many connected wallets never fan out into one giant request
 * burst. Enabling is keyed by Safe address alone, so a Safe co-owned by
 * several connected keys shows the same checked state under each of them.
 */
export function ConnectSafesDialog({ open, onOpenChange }: ConnectSafesDialogProps) {
  const connectedAddresses = useConnectedAddresses();
  const { isSafeEnabled, setSafeEnabled } = useSpendableAccounts();
  const [expandedOwners, setExpandedOwners] = useState<string[]>([]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Safe Accounts</DialogTitle>
          <DialogDescription>
            Expand a connected wallet to find the Safes it owns, then enable the ones you want to spend from.
          </DialogDescription>
        </DialogHeader>

        {connectedAddresses.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Wallet />
              </EmptyMedia>
              <EmptyTitle>Connect your wallet first</EmptyTitle>
              <EmptyDescription>Safes are discovered through the wallets that own them.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <GatedConnectButton />
            </EmptyContent>
          </Empty>
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <Accordion type="multiple" value={expandedOwners} onValueChange={setExpandedOwners}>
              {connectedAddresses.map((owner) => (
                <AccordionItem key={owner.toLowerCase()} value={owner.toLowerCase()}>
                  <AccordionTrigger className="hover:no-underline">
                    <AddressDisplayRoot address={owner}>
                      <AddressDisplayAvatar className="size-5" />
                      <AddressDisplayText className="text-sm" />
                    </AddressDisplayRoot>
                  </AccordionTrigger>
                  <AccordionContent>
                    <OwnerSafesList
                      owner={owner}
                      expanded={expandedOwners.includes(owner.toLowerCase())}
                      isSafeEnabled={isSafeEnabled}
                      setSafeEnabled={setSafeEnabled}
                    />
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
