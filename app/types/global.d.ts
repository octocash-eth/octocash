// Opt into viem's ambient `Window.ethereum?: EIP1193Provider | undefined`
// declaration so call sites that touch `window.ethereum` typecheck cleanly.
import "viem/window";
