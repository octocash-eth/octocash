import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

export function TokenIcon({ token, iconUrl, className }: { token: string; iconUrl?: string; className?: string }) {
  return (
    <Avatar className={className}>
      <AvatarImage src={iconUrl} alt={token} />
      <AvatarFallback className="text-[10px] bg-muted text-muted-foreground">
        {token.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
