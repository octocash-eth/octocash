export const HERO_CONTENT = {
  title: "Consolidate Your Tokens",
  subtitle: "Your tokens are scattered across chains. Octo brings them back together",
  cta: "Get Started",
  ctaLink: "/dashboard",
};

export const HOW_IT_WORKS_CONTENT = {
  title: "How it works",
  paragraphs: [
    "Octo is a friendly octopus with many arms. He dives into Ethereum chains grabbing your tokens wherever they hide.",
    "With a few clicks, he brings them home into one wallet, one token, one chain.",
  ],
};

export const FEATURES_CONTENT = {
  title: "Key Features",
  subtitle: "Discover how Octo makes your token consolidation simple, safe, and seamless.",
  cards: [
    {
      title: "Multi-Chain Arms",
      description: "Collect tokens from 8 major chains in one move.",
      imageSrc: "/decorations/feature-card-1.svg",
      imageAlt: "Multi-chain illustration",
      imageWidth: 484,
      imageHeight: 333,
    },
    {
      title: "Smooth & Simple",
      description: "No more hopping across bridges and swaps—Octo does the messy stuff for you.",
      imageSrc: "/decorations/feature-card-2.svg",
      imageAlt: "Simple process illustration",
      imageWidth: 484,
      imageHeight: 333,
    },
    {
      title: "Safe Tentacles",
      description: "Built on trusted protocols, so your tokens are in good hands (or arms).",
      imageSrc: "/decorations/feature-card-3.svg",
      imageAlt: "Security illustration",
      imageWidth: 484,
      imageHeight: 333,
    },
  ],
  trustedTech: {
    title: "Only Trusted Technologies",
    description: (
      <>
        Octo.cash uses <strong>Circle's CCTPv2</strong> and <strong>Odos</strong> behind the scenes.
      </>
    ),
  },
};

export const SUPPORT_CONTENT = {
  title: "Support Octo's Mission",
  description: "Octo.cash is open-source, built as a public good. Help our octopus keep swimming and improving.",
  cta: "Follow us on Twitter",
  ctaLink: "https://x.com/octocash_eth",
};

export const FAQ_CONTENT = {
  title: "FAQs",
  subtitle:
    "From supported chains to safety, here are the answers to the most common doubts—simple, transparent, and straight from the deep.",
};

export const FAQ_ITEMS = [
  {
    question: "Which chains does Octo support?",
    answer:
      "Octo currently supports Ethereum, Polygon, Arbitrum One, Optimism, Base, Unichain, and Linea Mainnet. We're constantly working to add more chains to help you consolidate tokens wherever they are.",
  },
  {
    question: "Does Octo decide which tokens to consolidate?",
    answer:
      "No, you're always in control! Octo shows you all your tokens across chains, and you choose which ones to consolidate and where to send them.",
  },
  {
    question: "Are there fees when consolidating?",
    answer:
      "You'll pay standard gas fees for the transactions on each chain, plus any bridge or swap fees from the underlying protocols we use (Circle CCTP and Odos). Octo itself doesn't charge any additional fees.",
  },
  {
    question: "Is it safe?",
    answer:
      "Absolutely! Octo is built on trusted, battle-tested protocols like Circle's CCTP for bridging and Odos for swaps. We're also open-source, so our code is transparent and auditable by anyone.",
  },
  {
    question: "Can I choose where my tokens end up?",
    answer:
      "Yes! You can choose which chain and wallet address to consolidate your tokens to. Octo gives you full control over the destination.",
  },
];

export const FOOTER_CONTENT = {
  copyright: "© 2025 Blossom Labs. Soon-to-be-licensed under AGPL-3.0. Open source contributions welcome.",
};
