import { ChainIcon } from "~/components/chain-icon";
import { supportedChains } from "~/data/supported-chains";

export function SupportedChains() {
  return (
    <div className="w-full max-w-2xl mx-auto">
      <h3 className="text-lg font-semibold tracking-[0.01em] text-primary mb-5">Supported Chains</h3>
      <div className="flex flex-wrap justify-center gap-3 md:gap-4">
        {supportedChains.map((chain) => (
          <div
            key={chain.id}
            className="w-10 h-10 md:w-12 md:h-12 rounded-full bg-blue-100 flex items-center justify-center"
            title={chain.name}
          >
            <ChainIcon chain={chain.name} className="size-7 md:size-8" />
          </div>
        ))}
      </div>
    </div>
  );
}
