import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ConnectSafesDialog } from "~/components/safe/connect-safes-dialog";
import { Button } from "~/components/ui/button";
import { useSpendableAccounts } from "~/hooks/use-spendable-accounts";

/**
 * Header entry point for Safe custody: opens the dialog where the user
 * expands each connected wallet and opts its Safes in as funding sources.
 */
export function ConnectSafesButton() {
  const [open, setOpen] = useState(false);
  const { enabledSafeCount } = useSpendableAccounts();

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <ShieldCheck />
        {enabledSafeCount > 0 ? `Safes (${enabledSafeCount})` : "Connect Safes"}
      </Button>
      <ConnectSafesDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
