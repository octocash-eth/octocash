import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";

export function ChainIcon({ chain, className }: { chain: string; className?: string }) {
  const iconPath = `/chain-icons/${chain.toLowerCase().replace(/\s+/g, "-")}.svg`;

  return (
    <Avatar className={className}>
      <AvatarImage src={iconPath} alt={chain} />
      <AvatarFallback className="text-[10px] text-muted-foreground bg-muted">
        {chain.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
