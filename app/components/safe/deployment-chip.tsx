import { TriangleAlert } from "lucide-react";
import { ChainIcon } from "~/components/chain/chain-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { chains } from "~/data/supported-chains";
import type { SafeChainDeployment } from "~/lib/accounts";

/**
 * Groups a Safe's deployments by identical owner set + threshold, so chains
 * where the Safe is configured the same collapse into one chip. Groups are
 * ordered by their lowest chain id; chains within a group likewise.
 */
export function groupDeployments(deployments: SafeChainDeployment[]): SafeChainDeployment[][] {
  const groups = new Map<string, SafeChainDeployment[]>();
  for (const deployment of [...deployments].sort((a, b) => a.chainId - b.chainId)) {
    const key = `${deployment.threshold}/${deployment.owners
      .map((owner) => owner.toLowerCase())
      .sort()
      .join(",")}`;
    const group = groups.get(key);
    if (group) group.push(deployment);
    else groups.set(key, [deployment]);
  }
  return Array.from(groups.values());
}

function chainName(chainId: number): string {
  return chains[chainId as keyof typeof chains]?.name ?? `Chain ${chainId}`;
}

/** One chip per owner-set/threshold group: the group's chain icons + `threshold/owners`. */
export function DeploymentChip({ deployments }: { deployments: SafeChainDeployment[] }) {
  const [first] = deployments;
  const names = deployments.map((deployment) => chainName(deployment.chainId));
  const chip = (
    <span
      className={
        first.controlled
          ? "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs"
          : "inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
      }
    >
      {names.map((name) => (
        <ChainIcon key={name} chain={name} className="size-3.5" />
      ))}
      <span className="text-muted-foreground">
        {first.threshold}/{first.owners.length}
      </span>
      {!first.controlled && <TriangleAlert className="size-3" aria-label="Not controlled by your key" />}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>
        {first.controlled
          ? `${first.threshold} of ${first.owners.length} owners must sign — deployed on ${names.join(", ")}`
          : `The ${names.join(", ")} deployment has a different owner set — funds there are not signable by your connected key`}
      </TooltipContent>
    </Tooltip>
  );
}
