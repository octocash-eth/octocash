import { ChainIcon } from "~/components/chain/chain-icon";
import { supportedChains } from "~/data/supported-chains";

export function SupportedChains() {
  return (
    <div className="w-full">
      <div className="flex flex-wrap gap-3 md:gap-4">
        {supportedChains.map((chain) => (
          <div
            key={chain.id}
            className="size-14 rounded-full bg-background shadow-2xl flex items-center justify-center"
            title={chain.name}
          >
            <ChainIcon chain={chain.name} className="size-12" />
          </div>
        ))}
      </div>
    </div>
  );
}
