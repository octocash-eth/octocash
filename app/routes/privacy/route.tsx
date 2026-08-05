import { useEffect } from "react";
import { Link } from "react-router";
import { SiteHeader } from "~/components/site";
import { generateMeta } from "~/utils/meta";

export function meta() {
  return generateMeta({
    title: "Privacy Policy",
    description: "Privacy Policy for Octocash - cross-chain token consolidation.",
    url: "/privacy",
    noIndex: true,
  });
}

export default function PrivacyPolicy() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return (
    <div className="relative flex flex-col min-h-screen">
      <SiteHeader />
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-12 md:py-20">
        <article className="prose prose-lg dark:prose-invert mx-auto max-w-3xl">
          <h1>Privacy Policy</h1>
          <p className="text-muted-foreground">Last updated: June 16, 2026</p>

          <p>
            This Privacy Policy describes how OtoCo WY LLC - Octocash - Series 435, a Wyoming limited liability company
            (&quot;Company,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;), collects, uses, and shares
            information in connection with the Octocash website and application located at{" "}
            <a href="https://octo.cash" target="_blank" rel="noopener noreferrer">
              https://octo.cash
            </a>{" "}
            (the &quot;Service&quot;).
          </p>
          <p>
            By using the Service, you agree to the collection and use of information as described in this Privacy
            Policy. If you do not agree, please do not use the Service.
          </p>

          <h2>1. Information We Collect</h2>
          <p>
            Octocash is designed with privacy in mind. We minimize data collection to what is strictly necessary for the
            Service to function.
          </p>
          <h3>Information you provide</h3>
          <ul>
            <li>
              <strong>Public wallet addresses</strong> — when you connect your wallet, we access your public wallet
              address(es) to display your token balances and facilitate consolidation transactions. Wallet addresses are
              publicly available on-chain data.
            </li>
          </ul>
          <h3>Information we do not collect</h3>
          <ul>
            <li>We do not collect your name, email address, phone number, or other personal contact information;</li>
            <li>We do not use cookies or analytics tracking;</li>
            <li>We do not collect your private keys or seed phrases;</li>
            <li>We do not require account creation or registration.</li>
          </ul>

          <h2>2. Third-Party Services</h2>
          <p>
            The Service integrates with third-party protocols and infrastructure to provide its functionality. When you
            use the Service, certain data may be transmitted to these third-party services as part of normal operation:
          </p>
          <h3>Hosting infrastructure</h3>
          <ul>
            <li>
              <strong>Deno Deploy</strong> (Deno Land Inc.) — hosts and serves the Service. Your IP address, browser
              information, and request metadata are processed by Deno Deploy&apos;s infrastructure when you access the
              Service;
            </li>
            <li>
              <strong>Fermyon Cloud</strong> — hosts token icon images served at assets.octo.cash. Your IP address is
              transmitted when loading token icons.
            </li>
          </ul>
          <h3>Blockchain infrastructure</h3>
          <ul>
            <li>
              <strong>Alchemy</strong> (Alchemy Insights, Inc.) — a blockchain RPC provider used for querying blockchain
              data and submitting transactions. Receives your wallet address, transaction data, and IP address;
            </li>
            <li>
              <strong>DRPC</strong> — a decentralized RPC provider used as a fallback for blockchain data access.
              Receives the same data as Alchemy;
            </li>
            <li>
              <strong>WalletConnect</strong> (WalletConnect Inc.) — provides the wallet connection relay protocol. When
              connecting a wallet via WalletConnect (as opposed to a browser extension), connection data and wallet
              addresses are transmitted through WalletConnect&apos;s relay servers.
            </li>
          </ul>
          <h3>DeFi protocols</h3>
          <ul>
            <li>
              <strong>Delora</strong> — a token routing and swap protocol used for token swaps. Receives wallet
              addresses, token addresses, and amounts to generate and execute swap quotes;
            </li>
            <li>
              <strong>Circle CCTP</strong> (Cross-Chain Transfer Protocol) — used for bridging USDC across blockchain
              networks. Receives transaction hashes and chain identifiers to facilitate cross-chain transfers.
            </li>
            <li>
              <strong>Railgun</strong> — a privacy protocol used, at your option, to shield consolidated tokens into a
              private (0zk) address. When you choose a Railgun destination, your wallet address, the token address, and
              the amount are submitted on-chain to the Railgun smart contract to execute the shield.
            </li>
            <li>
              <strong>Gas.zip</strong> — a gas refuel bridge used to route cross-chain native gas top-ups when a source
              or destination wallet lacks gas. Receives your wallet address, the recipient address, source and
              destination chain IDs, native token amounts, and IP address to generate deposit quotes. When Gas.zip
              cannot serve a chain pair, the same data is sent to Delora instead, which routes the top-up through its
              underlying bridges, each operating under its own privacy policy.
            </li>
          </ul>
          <h3>Data services</h3>
          <ul>
            <li>
              <strong>Zerion</strong> — a portfolio data provider used to fetch your token balances and positions across
              supported chains. Receives your wallet address(es) and IP address.
            </li>
          </ul>
          <p>
            These third-party services operate under their own privacy policies. We encourage you to review their
            respective policies. The Company does not control how these third parties collect, use, or store data.
          </p>

          <h2>3. How We Use Information</h2>
          <p>We use the information available to us solely to:</p>
          <ul>
            <li>Display your token balances across supported chains;</li>
            <li>Facilitate the consolidation of your tokens as you direct;</li>
            <li>Display transaction history within the Service interface.</li>
          </ul>
          <p>
            We do not use your information for profiling, targeted advertising, marketing, or any purpose unrelated to
            providing the Service.
          </p>

          <h2>4. Data Storage</h2>
          <p>
            Octocash is a client-side application. We do not operate a server-side database that stores your personal
            data. The Service stores minimal preferences locally on your device using browser localStorage, including:
          </p>
          <ul>
            <li>Theme preference (light/dark mode);</li>
            <li>Terms of Service acceptance status;</li>
            <li>UI preferences.</li>
          </ul>
          <p>
            This data is stored exclusively on your device and is not transmitted to our servers. You can clear this
            data at any time through your browser settings.
          </p>

          <h2>5. Data Sharing</h2>
          <p>
            We do not sell, rent, trade, or otherwise share your information with third parties for their marketing or
            commercial purposes.
          </p>
          <p>
            Information is transmitted to the third-party services listed in Section 2 only as necessary to execute
            transactions you have initiated. We may also disclose information if required by law, regulation, legal
            process, or governmental request.
          </p>

          <h2>6. Blockchain Data</h2>
          <p>
            All transactions executed through the Service are recorded on public blockchain networks. Blockchain
            transactions are publicly visible, immutable, and cannot be deleted by the Company or any other party. This
            includes wallet addresses, transaction amounts, and timestamps.
          </p>
          <p>
            You acknowledge that the inherent transparency of blockchain technology means that your transaction history
            is permanently available to anyone who can access the relevant blockchain.
          </p>
          <p>
            If you shield tokens into a private Railgun (0zk) address, the shield deposit itself is a public on-chain
            transaction (including the depositing wallet address, token, and amount), while the resulting shielded
            balance is held privately within the Railgun protocol.
          </p>

          <h2>7. Security</h2>
          <p>
            The Service employs a non-custodial architecture, meaning we never have access to your private keys or
            control over your funds. Because we do not operate a server-side database for user data, there is no
            centralized data store to be compromised.
          </p>
          <p>
            However, no system is completely secure. You are responsible for securing your wallet, private keys, and the
            devices you use to access the Service.
          </p>

          <h2>8. Children&apos;s Privacy</h2>
          <p>
            The Service is not directed at and is not intended for use by individuals under the age of 18. We do not
            knowingly collect information from children. If you believe that a child has used the Service, please
            contact us and we will take appropriate steps.
          </p>

          <h2>9. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. The updated policy will be posted on the Service with a
            revised &quot;Last updated&quot; date. Your continued use of the Service after any changes constitutes your
            acceptance of the updated policy.
          </p>

          <h2>10. Governing Law</h2>
          <p>
            This Privacy Policy shall be governed by and construed in accordance with the laws of the State of Wyoming,
            without regard to its conflict of laws principles.
          </p>

          <h2>11. Contact</h2>
          <p>
            If you have any questions about this Privacy Policy, you can reach us at{" "}
            <a href="https://x.com/octocash_eth" target="_blank" rel="noopener noreferrer">
              @octocash_eth on X (Twitter)
            </a>
            .
          </p>

          <div className="mt-12 pt-8 border-t text-sm text-muted-foreground flex gap-4">
            <Link to="/terms" className="underline">
              Terms of Service
            </Link>
            <Link to="/privacy" className="underline">
              Privacy Policy
            </Link>
          </div>
        </article>
      </main>
    </div>
  );
}
