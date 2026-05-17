import { useEffect } from "react";
import { Link } from "react-router";
import { SiteHeader } from "~/components/site";
import { generateMeta } from "~/utils/meta";

export function meta() {
  return generateMeta({
    title: "Terms of Service",
    description: "Terms of Service for OctoCash - cross-chain token consolidation.",
    url: "/terms",
    noIndex: true,
  });
}

export default function TermsOfService() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return (
    <div className="relative flex flex-col min-h-screen">
      <SiteHeader />
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-12 md:py-20">
        <article className="prose prose-lg dark:prose-invert mx-auto max-w-3xl">
          <h1>Terms of Service</h1>
          <p className="text-muted-foreground">Last updated: May 17, 2026</p>

          <p>
            These Terms of Service (&quot;Terms&quot;) govern your access to and use of the OctoCash website and
            application located at{" "}
            <a href="https://octo.cash" target="_blank" rel="noopener noreferrer">
              https://octo.cash
            </a>{" "}
            (the &quot;Service&quot;), operated by OtoCo WY LLC - Octocash - Series 435, a Wyoming limited liability
            company (&quot;Company,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;).
          </p>
          <p>
            By accessing or using the Service, connecting a wallet, or clicking &quot;I agree,&quot; you agree to be
            bound by these Terms. If you do not agree to these Terms, do not use the Service.
          </p>

          <h2>1. Description of Service</h2>
          <p>
            OctoCash is a non-custodial, cross-chain token consolidation interface. The Service allows users to view
            token balances across multiple blockchain networks and consolidate them into a single wallet address on a
            chosen destination chain. The Service coordinates token swaps through Odos (a decentralized exchange
            aggregator) and cross-chain bridges through Circle&apos;s Cross-Chain Transfer Protocol v2 (CCTPv2).
          </p>
          <p>
            When a destination wallet does not hold sufficient native gas to execute its share of the consolidation, the
            Service may route a small native-token top-up to that wallet through LI.FI, a bridge aggregator. LI.FI in
            turn routes the top-up through fast underlying bridges such as Across, Relay, and Gas.zip.
          </p>
          <p>
            The Service acts solely as a coordination interface. We do not hold, control, or take custody of your
            digital assets at any point during the consolidation process. All transactions require your explicit wallet
            approval and are executed directly on public blockchain networks.
          </p>

          <h2>2. Eligibility</h2>
          <p>By using the Service, you represent and warrant that:</p>
          <ul>
            <li>You are at least 18 years of age or the age of majority in your jurisdiction;</li>
            <li>You have the legal capacity and authority to enter into these Terms and to use the Service;</li>
            <li>
              You are not located in, organized in, or a resident of any country or territory that is the subject of
              comprehensive sanctions by the United States (including, without limitation, Cuba, Iran, North Korea,
              Syria, and the Crimea, Donetsk, and Luhansk regions of Ukraine), or any other applicable sanctions regime;
            </li>
            <li>
              You are not identified on any applicable sanctions or restricted party list, including the U.S. Department
              of the Treasury&apos;s Office of Foreign Assets Control (OFAC) Specially Designated Nationals and Blocked
              Persons List; and
            </li>
            <li>Your use of the Service does not violate any applicable law or regulation.</li>
          </ul>

          <h2>3. Wallet Connection and Security</h2>
          <p>
            To use the Service, you must connect a compatible blockchain wallet. You are solely responsible for the
            security and management of your wallet, private keys, and seed phrases. The Company has no access to and
            does not store your private keys or seed phrases.
          </p>
          <p>
            You acknowledge that all transactions initiated through the Service require your explicit approval via your
            connected wallet. The Company cannot reverse, cancel, or modify any blockchain transaction once it has been
            broadcast to the network.
          </p>

          <h2>4. Third-Party Services</h2>
          <p>
            The Service integrates with and relies upon third-party protocols, infrastructure, and services, including
            but not limited to:
          </p>
          <ul>
            <li>
              <strong>Deno Deploy</strong> — cloud hosting platform that serves the Service;
            </li>
            <li>
              <strong>Alchemy and DRPC</strong> — blockchain RPC providers used for querying blockchain data and
              submitting transactions;
            </li>
            <li>
              <strong>WalletConnect</strong> — wallet connection relay protocol used for connecting compatible wallets;
            </li>
            <li>
              <strong>Zerion</strong> — portfolio data provider used to retrieve token balances and positions;
            </li>
            <li>
              <strong>Odos</strong> — a decentralized exchange aggregator used for token swaps;
            </li>
            <li>
              <strong>Circle CCTP (Cross-Chain Transfer Protocol)</strong> — used for bridging USDC across blockchain
              networks;
            </li>
            <li>
              <strong>LI.FI</strong> — bridge aggregator used to route cross-chain native gas top-ups when a destination
              wallet lacks gas; LI.FI in turn relies on third-party bridges including Across, Relay, and Gas.zip;
            </li>
            <li>
              <strong>Fermyon Cloud</strong> — hosts token icon assets served by the Service.
            </li>
          </ul>
          <p>
            Your use of these third-party services is subject to their respective terms of service and privacy policies.
            The Company does not control these third-party services and is not responsible for their availability,
            performance, accuracy, or security. You acknowledge and accept the risks associated with relying on
            third-party protocols and infrastructure.
          </p>

          <h2>5. Fees</h2>
          <p>Using the Service involves the following fees, which are displayed before you confirm any transaction:</p>
          <ul>
            <li>
              <strong>Gas fees</strong> — blockchain network transaction fees, which vary by network and congestion;
            </li>
            <li>
              <strong>Swap fees</strong> — 0.04% for stablecoin swaps and 0.16% for volatile asset swaps, charged by the
              swap protocol;
            </li>
            <li>
              <strong>Bridge fees</strong> — 0.01% for USDC bridges (0.14% on Linea), charged by the bridge protocol;
            </li>
            <li>
              <strong>Gas top-up bridge fees</strong> — when a destination wallet lacks native gas, an additional bridge
              fee charged by LI.FI and the underlying bridge (Across, Relay, or Gas.zip) applies to the top-up amount.
              This fee is only incurred when a top-up is required and is shown before you approve the transaction.
            </li>
          </ul>
          <p>
            A small portion of swap and bridge fees supports the continued development and operation of OctoCash. All
            applicable fees are shown upfront before you approve any transaction. The Company reserves the right to
            modify the fee structure at any time, with updated fees displayed in the Service interface.
          </p>

          <h2>6. Risks</h2>
          <p>
            You acknowledge and accept that using the Service and interacting with blockchain networks and decentralized
            protocols involves significant risks, including but not limited to:
          </p>
          <ul>
            <li>
              <strong>Smart contract risk</strong> — the protocols used by the Service may contain bugs,
              vulnerabilities, or exploits that could result in loss of funds;
            </li>
            <li>
              <strong>Bridge risk</strong> — cross-chain bridging involves additional layers of risk including potential
              delays, failures, or loss of assets during transit;
            </li>
            <li>
              <strong>Slippage and price volatility</strong> — token prices may change between the time a transaction is
              initiated and when it is confirmed, resulting in receiving fewer tokens than expected;
            </li>
            <li>
              <strong>Blockchain finality</strong> — transactions on blockchain networks are generally irreversible once
              confirmed, and network reorganizations may in rare cases affect transaction finality;
            </li>
            <li>
              <strong>Regulatory risk</strong> — the legal and regulatory environment for digital assets and
              decentralized finance is evolving, and changes in law or regulation may adversely affect the Service or
              your ability to use it;
            </li>
            <li>
              <strong>Network congestion</strong> — high network usage may result in delayed transactions, increased gas
              fees, or failed transactions.
            </li>
          </ul>
          <p>
            You accept full responsibility for evaluating and assuming these risks. The Company does not guarantee the
            successful completion of any transaction.
          </p>

          <h2>7. No Custody; No Fiduciary Relationship</h2>
          <p>
            The Service is non-custodial. The Company never holds, controls, or has access to your digital assets. All
            transactions are executed directly between your wallet and the relevant blockchain protocols.
          </p>
          <p>
            Nothing in these Terms or in the Service creates a fiduciary, advisory, or agency relationship between you
            and the Company. The Service does not provide financial, investment, legal, or tax advice. You are solely
            responsible for your own investment decisions.
          </p>

          <h2>8. Disclaimer of Warranties</h2>
          <p>
            THE SERVICE IS PROVIDED ON AN &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; BASIS, WITHOUT WARRANTIES OF
            ANY KIND, EITHER EXPRESS OR IMPLIED. THE COMPANY HEREBY DISCLAIMS ALL WARRANTIES, INCLUDING BUT NOT LIMITED
            TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.
          </p>
          <p>
            THE COMPANY DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF VIRUSES
            OR OTHER HARMFUL COMPONENTS. THE COMPANY DOES NOT WARRANT THE ACCURACY, RELIABILITY, OR COMPLETENESS OF ANY
            INFORMATION PROVIDED THROUGH THE SERVICE, INCLUDING TOKEN BALANCES, PRICES, OR TRANSACTION ESTIMATES.
          </p>

          <h2>9. Limitation of Liability</h2>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL THE COMPANY, ITS MANAGER, MEMBERS,
            AFFILIATES, OR SERVICE PROVIDERS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
            DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, DATA, OR DIGITAL ASSETS, WHETHER INCURRED DIRECTLY OR INDIRECTLY,
            OR ANY LOSS OF GOODWILL OR REPUTATION, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF OR INABILITY TO USE
            THE SERVICE.
          </p>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE COMPANY&apos;S TOTAL AGGREGATE LIABILITY FOR ALL
            CLAIMS ARISING OUT OF OR RELATING TO THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE GREATER OF (A) THE
            AMOUNT OF FEES PAID BY YOU TO THE COMPANY IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM OR (B) ONE HUNDRED
            U.S. DOLLARS ($100).
          </p>

          <h2>10. Indemnification</h2>
          <p>
            You agree to indemnify, defend, and hold harmless the Company, its manager, members, affiliates, and their
            respective officers, agents, and service providers from and against any and all claims, liabilities,
            damages, losses, costs, and expenses (including reasonable attorneys&apos; fees) arising out of or in
            connection with:
          </p>
          <ul>
            <li>Your use of the Service;</li>
            <li>Your violation of these Terms;</li>
            <li>Your violation of any applicable law or regulation;</li>
            <li>Your violation of any rights of any third party; or</li>
            <li>Any transaction you initiate or approve through the Service.</li>
          </ul>

          <h2>11. Governing Law and Dispute Resolution</h2>
          <p>
            These Terms shall be governed by and construed in accordance with the laws of the State of Wyoming, without
            regard to its conflict of laws principles.
          </p>
          <p>
            Any dispute, controversy, or claim arising out of or relating to these Terms, or the breach thereof, shall
            be settled by binding arbitration before three arbitrators, administered by the American Arbitration
            Association under its Commercial Arbitration Rules, in Sheridan, Wyoming. Judgment on the award rendered by
            the arbitrators may be entered in any court having jurisdiction.
          </p>
          <p>
            Each party shall bear its own arbitration fees and administrative costs. The prevailing party, as determined
            by the arbitrators, shall be awarded its reasonable attorneys&apos; fees and costs.
          </p>
          <p>
            YOU AGREE THAT ANY DISPUTE RESOLUTION PROCEEDINGS WILL BE CONDUCTED ONLY ON AN INDIVIDUAL BASIS AND NOT IN A
            CLASS, CONSOLIDATED, OR REPRESENTATIVE ACTION.
          </p>

          <h2>12. Modification of Terms</h2>
          <p>
            The Company reserves the right to modify these Terms at any time. Updated Terms will be posted on the
            Service with a revised &quot;Last updated&quot; date. Your continued use of the Service after any
            modification constitutes your acceptance of the updated Terms. It is your responsibility to review these
            Terms periodically.
          </p>

          <h2>13. Severability</h2>
          <p>
            If any provision of these Terms is determined to be invalid or unenforceable by a court of competent
            jurisdiction, the remaining provisions shall continue in full force and effect. The invalid or unenforceable
            provision shall be deemed modified to the minimum extent necessary to make it valid and enforceable.
          </p>

          <h2>14. Entire Agreement</h2>
          <p>
            These Terms, together with our{" "}
            <Link to="/privacy" className="underline">
              Privacy Policy
            </Link>
            , constitute the entire agreement between you and the Company regarding your use of the Service and
            supersede all prior agreements and understandings, whether written or oral.
          </p>

          <h2>15. Contact</h2>
          <p>
            If you have any questions about these Terms, you can reach us at{" "}
            <a href="mailto:legal@octo.cash" className="underline">
              legal@octo.cash
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
