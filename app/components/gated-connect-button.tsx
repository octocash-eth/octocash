import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";

export function GatedConnectButton() {
  const { openConnectModal } = useConnectModal();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const passwordId = useId();

  const onRequestConnect = () => {
    setPassword("");
    setError("");
    setOpen(true);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== "alphacode") {
      setError("Incorrect password. This app is in alpha.");
      return;
    }
    setOpen(false);
    setTimeout(() => {
      openConnectModal?.();
    }, 0);
  };

  return (
    <>
      <Button onClick={onRequestConnect}>Connect Wallet</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Alpha access required</DialogTitle>
            <DialogDescription>
              This app is under active development. Do not use it with real funds unless you know what you are doing.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-2">
              <label htmlFor={passwordId} className="text-sm font-medium">
                Password
              </label>
              <Input
                id={passwordId}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter alpha password"
                aria-invalid={error ? true : undefined}
                autoFocus
                required
              />
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
            <DialogFooter>
              <Button type="submit" className="w-full">
                Continue
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
