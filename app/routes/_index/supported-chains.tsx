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
          >
            <img src={chain.icon} alt={chain.name} title={chain.name} className="w-7 h-7 md:w-8 md:h-8 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
