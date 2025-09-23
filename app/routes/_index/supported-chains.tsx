import { supportedChains } from "~/data/supported-chains";

export function SupportedChains() {
  return (
    <div className="w-full max-w-2xl mx-auto">
      <h3 className="text-lg font-semibold text-primary mb-6">Supported Chains</h3>
      <div className="flex flex-wrap justify-center gap-4">
        {supportedChains.map((chain) => (
          <div key={chain.id} className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
            <img src={chain.icon} alt={chain.name} title={chain.name} className="w-8 h-8 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
