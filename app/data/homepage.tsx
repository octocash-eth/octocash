export const HERO_CONTENT = {
  title: "Consolidate Your Tokens",
  subtitle: "Your tokens are scattered across chains like treasures at sea. Octo gathers them all in one place.",
  cta: "Get Started",
  ctaLink: "/dashboard",
};

export const HOW_IT_WORKS_CONTENT = {
  title: "How it works",
  paragraphs: [
    "I'm Octo, your cross-chain treasure hunter. I'll show you where your tokens are hiding, help you pick what to keep, and then I'll fetch them for you.",
    "In a few clicks, your scattered loot becomes one wallet, one token, one chain.",
  ],
};

export const FEATURES_CONTENT = {
  title: "What Makes Octo Special",
  subtitle: "We know managing tokens across chains is frustrating. That's why Octo exists.",
  cards: [
    {
      title: "Seven Seas, One View",
      description: "See all your tokens across 7 chains. No more wallet hopping.",
      imageSrc: "/decorations/feature-card-1-light.svg",
      imageSrcDark: "/decorations/feature-card-1-dark.svg",
      imageAlt: "Multi-chain illustration",
      imageWidth: 484,
      imageHeight: 333,
    },
    {
      title: "Choose Your Journey",
      description: "Select which tokens to consolidate and where to send them. You're always in control.",
      imageSrc: "/decorations/feature-card-2.svg",
      imageAlt: "Simple process illustration",
      imageWidth: 484,
      imageHeight: 333,
    },
    {
      title: "Treasures Secured",
      description:
        "Built on trusted protocols. Your treasures arrive in a matter of seconds, exactly where you want them.",
      imageSrc: "/decorations/feature-card-3.svg",
      imageAlt: "Security illustration",
      imageWidth: 484,
      imageHeight: 333,
    },
  ],
  trustedTech: {
    title: "Octo's Secret Ingredients",
    description: (
      <>
        Behind the magic: <strong>Circle's CCTPv2</strong> handles the bridges, <strong>Odos</strong> powers the swaps.
        Both proven protocols that keep your assets safe.
      </>
    ),
  },
};

export const SUPPORT_CONTENT = {
  title: "Join Octo's Journey",
  description:
    "We're on a mission to make multi-chain crypto as simple as a single wallet. Join our community and watch Octo grow with us.",
  cta: "Follow us on Twitter",
  ctaLink: "https://x.com/octocash_eth",
};

export const FAQ_CONTENT = {
  title: "FAQs",
  subtitle: "Questions from the surface to the deep, answered simply, transparently, straight from Octo's heart.",
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
      "Yes. On top of gas fees, you'll pay: 0.04% for stablecoin swaps, 0.16% for volatile asset swaps, and 0.01% for USDC bridges (0.14% on Linea). These fees go to the protocols (Odos and CCTP), with a small portion supporting Octo. All costs are shown upfront.",
  },
  {
    question: "Is it safe?",
    answer:
      "Yes! Octo doesn't hold your funds. All interactions happen directly between your wallet and battle-tested protocols like Circle's CCTP and Odos. We coordinate the consolidation; the protocols handle your assets.",
  },
  {
    question: "Can I choose where my tokens end up?",
    answer:
      "Yes! You can choose which chain and wallet address to consolidate your tokens to. Octo gives you full control over the destination.",
  },
];

export const FOOTER_CONTENT = {
  copyright: "© 2025 Blossom Labs. Built with love for the people like us, navigating multi-chain complexity.",
};
