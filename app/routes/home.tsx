import { ConnectButton } from "@rainbow-me/rainbowkit";
import { SITE_DESCRIPTION, SITE_NAME } from "~/data/site";

export function meta() {
  return [{ title: SITE_NAME }, { name: "description", content: SITE_DESCRIPTION }];
}

export default function Home() {
  return <ConnectButton />;
}
