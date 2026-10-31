// The resource catalog. One list drives everything: the paid /v1 routes, the
// Resources page, the docs, and the tools the Wafermap App agent can call.
// Prices are in USD and settle 1:1 in USDG (Robinhood Chain) or USDC (Base).

export type Category = "llm" | "image" | "audio" | "vision" | "web" | "onchain" | "stocks" | "prediction" | "content";

export type Field = {
  name: string;
  type: "string" | "number" | "enum" | "address" | "url" | "network";
  required?: boolean;
  description: string;
  options?: string[];
  max?: number;
  example?: string | number;
};

export type Resource = {
  id: string;
  name: string;
  category: Category;
  /** Price per call in USD, as a decimal string so it never drifts through floats. */
  price: string;
  summary: string;
  provider: string;
  /** What comes back. */
  returns: string;
  fields: Field[];
  /** Workers AI model behind it, when there is one. */
  model?: string;
  /** Short words that help the agent pick the right tool. */
  tags?: string[];
};

export const CATEGORIES: Record<Category, string> = {
  llm: "LLM",
  image: "Image generation",
  audio: "Audio",
  vision: "Vision",
  web: "Web",
  onchain: "On-chain data",
  stocks: "Tokenized stocks",
  prediction: "Prediction markets",
  content: "Content",
};

const PROMPT: Field = { name: "prompt", type: "string", required: true, description: "What you want, in plain words.", max: 24000, example: "Explain x402 in two sentences." };
const SYSTEM: Field = { name: "system", type: "string", description: "Optional instructions that shape every answer.", max: 8000 };
const MAX_TOKENS: Field = { name: "max_tokens", type: "number", description: "Output cap. 2048 at most, 1024 by default.", max: 2048, example: 1024 };
const NETWORK: Field = { name: "network", type: "network", description: "robinhood (default) or base.", options: ["robinhood", "base"], example: "robinhood" };
const TOKEN: Field = { name: "address", type: "address", required: true, description: "Token contract address (0x…).", example: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" };
const IMAGE_PROMPT: Field = { name: "prompt", type: "string", required: true, description: "Describe the image.", max: 2000, example: "A glossy black wafer on white, studio light" };
const SIZE: Field = { name: "size", type: "enum", description: "Square, wide or tall.", options: ["1024x1024", "1280x768", "768x1280"], example: "1024x1024" };

const llm = (id: string, name: string, model: string, price: string, summary: string, tags: string[] = []): Resource => ({
  id,
  name,
  category: "llm",
  price,
  summary,
  provider: "Workers AI",
  returns: "{ text, model, usage }",
  model,
  fields: [PROMPT, SYSTEM, MAX_TOKENS],
  tags: ["chat", "write", "answer", ...tags],
});

const image = (id: string, name: string, model: string, price: string, summary: string): Resource => ({
  id,
  name,
  category: "image",
  price,
  summary,
  provider: "Workers AI",
  returns: "{ image: data:image/png;base64,… }",
  model,
  fields: [IMAGE_PROMPT, SIZE],
  tags: ["image", "picture", "logo", "art", "generate"],
});

export const RESOURCES: Resource[] = [
  // LLM
  llm("kimi-k2-6", "Kimi K2.6", "@cf/moonshotai/kimi-k2.6", "0.02", "Moonshot's agentic flagship. Long reasoning, strong tool use, 262K context.", ["reasoning", "agent"]),
  llm("deepseek-v4-pro", "DeepSeek V4 Pro", "@cf/deepseek-ai/deepseek-v4-pro-0813", "0.025", "DeepSeek's top model for hard reasoning, math and code.", ["reasoning", "code", "math"]),
  llm("glm-5-3", "GLM 5.3", "@cf/zai-org/glm-5.3", "0.025", "Z.ai's frontier model. Careful writing and multi-step planning.", ["reasoning", "writing"]),
  llm("qwen-3-8", "Qwen 3.8 27B", "@cf/qwen/qwen3.8-27b", "0.015", "Alibaba's dense 27B. Fast, multilingual, solid at code.", ["multilingual", "code"]),
  llm("nemotron-3", "Nemotron 3 120B", "@cf/nvidia/nemotron-3-120b-a12b", "0.01", "NVIDIA's open MoE model tuned for agent workflows.", ["agent"]),
  llm("gpt-oss-120b", "GPT-OSS 120B", "@cf/openai/gpt-oss-120b", "0.006", "OpenAI's open-weight 120B. Reasoning at a low price.", ["reasoning"]),
  llm("deepseek-v4-1-flash", "DeepSeek V4.1 Flash", "@cf/deepseek-ai/deepseek-v4.1-flash-1017", "0.007", "Quick DeepSeek for everyday questions and drafts.", ["fast"]),
  llm("llama-4-scout", "Llama 4 Scout", "@cf/meta/llama-4-scout-17b-16e-instruct", "0.006", "Meta's multimodal MoE. Good general assistant.", ["general"]),
  llm("gemma-4", "Gemma 4 26B", "@cf/google/gemma-4-26b-a4b-it", "0.002", "Google's open model. The cheapest way to get a good answer.", ["cheap", "fast"]),

  // Image
  image("flux-2-dev", "FLUX.2 dev", "@cf/black-forest-labs/flux-2-dev", "0.04", "Black Forest Labs' FLUX.2. High fidelity, accurate text in images."),
  image("flux-2-klein-4b", "FLUX.2 klein 4B", "@cf/black-forest-labs/flux-2-klein-4b", "0.01", "Smallest FLUX.2. Fast drafts and variations."),
  image("lucid-origin", "Lucid Origin", "@cf/leonardo/lucid-origin", "0.04", "Leonardo's prompt-faithful model. Strong on design and typography."),
  image("phoenix-1", "Phoenix 1.0", "@cf/leonardo/phoenix-1.0", "0.035", "Leonardo Phoenix. Polished, coherent compositions."),
  image("flux-1-schnell", "FLUX.1 schnell", "@cf/black-forest-labs/flux-1-schnell", "0.005", "The quick classic. Four steps, half a cent."),

  // Audio
  {
    id: "tts-aura-2",
    name: "Aura 2 Voice",
    category: "audio",
    price: "0.04",
    summary: "Deepgram Aura 2. Natural English speech from text, up to 1,000 characters.",
    provider: "Workers AI",
    returns: "{ audio: data:audio/mpeg;base64,… }",
    model: "@cf/deepgram/aura-2-en",
    fields: [{ name: "text", type: "string", required: true, description: "Text to speak.", max: 1000, example: "Your agent just paid for this sentence." }],
    tags: ["speech", "voice", "tts", "audio"],
  },
  {
    id: "tts-melo",
    name: "MeloTTS",
    category: "audio",
    price: "0.002",
    summary: "Light multilingual text-to-speech. Cheap narration for drafts.",
    provider: "Workers AI",
    returns: "{ audio: data:audio/mpeg;base64,… }",
    model: "@cf/myshell-ai/melotts",
    fields: [
      { name: "text", type: "string", required: true, description: "Text to speak.", max: 1000, example: "Hello from Wafermap." },
      { name: "lang", type: "enum", description: "Language.", options: ["en", "es", "fr", "zh", "ja", "ko"], example: "en" },
    ],
    tags: ["speech", "voice", "tts", "audio"],
  },
  {
    id: "stt-whisper",
    name: "Whisper v3 Turbo",
    category: "audio",
    price: "0.01",
    summary: "Transcribe audio from an HTTPS link. Files up to 10 MB.",
    provider: "Workers AI",
    returns: "{ text, language }",
    model: "@cf/openai/whisper-large-v3-turbo",
    fields: [{ name: "url", type: "url", required: true, description: "HTTPS link to an audio file (mp3, wav, m4a, ogg).", example: "https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac" }],
    tags: ["transcribe", "speech to text", "audio"],
  },

  // Vision + language
  {
    id: "vision-describe",
    name: "Image Describe",
    category: "vision",
    price: "0.006",
    summary: "Ask a question about an image at an HTTPS link. Llama 4 Scout reads it.",
    provider: "Workers AI",
    returns: "{ text }",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    fields: [
      { name: "url", type: "url", required: true, description: "HTTPS link to a PNG, JPEG or WebP image.", example: "https://wafermap.xyz/og.png" },
      { name: "question", type: "string", description: "What to look for. Defaults to a plain description.", max: 1000, example: "What does this image show?" },
    ],
    tags: ["image", "caption", "ocr", "see"],
  },
  {
    id: "translate",
    name: "Translate",
    category: "web",
    price: "0.002",
    summary: "Translate text between 100 languages with M2M100.",
    provider: "Workers AI",
    returns: "{ text }",
    model: "@cf/meta/m2m100-1.2b",
    fields: [
      { name: "text", type: "string", required: true, description: "Text to translate.", max: 4000, example: "Agents pay per call." },
      { name: "target", type: "string", required: true, description: "Target language code (e.g. id, es, zh).", example: "id" },
      { name: "source", type: "string", description: "Source language code. Defaults to en.", example: "en" },
    ],
    tags: ["translate", "language"],
  },
  {
    id: "web-read",
    name: "Web Reader",
    category: "web",
    price: "0.003",
    summary: "Fetch a public web page and return clean Markdown an agent can read.",
    provider: "Wafermap",
    returns: "{ title, markdown }",
    fields: [{ name: "url", type: "url", required: true, description: "HTTPS link to read.", example: "https://www.x402.org" }],
    tags: ["web", "read", "scrape", "page", "article"],
  },

  // On-chain
  {
    id: "token-snapshot",
    name: "Token Snapshot",
    category: "onchain",
    price: "0.005",
    summary: "Name, supply and decimals read from the chain, plus price, liquidity and volume from the top pool.",
    provider: "Wafermap · GeckoTerminal",
    returns: "{ token, market, pools }",
    fields: [TOKEN, NETWORK],
    tags: ["token", "price", "market cap", "liquidity", "contract"],
  },
  {
    id: "token-signal",
    name: "Token Signal",
    category: "onchain",
    price: "0.02",
    summary: "Snapshot plus a short AI read: momentum, liquidity depth and the risks worth checking.",
    provider: "Wafermap · Workers AI",
    returns: "{ snapshot, signal: { stance, summary, risks[] } }",
    fields: [TOKEN, NETWORK],
    tags: ["token", "analysis", "sentiment", "risk", "signal"],
  },
  {
    id: "contract-check",
    name: "Contract Check",
    category: "onchain",
    price: "0.005",
    summary: "Who owns it, is it a proxy, can supply still change. Read straight from bytecode and storage.",
    provider: "Wafermap",
    returns: "{ isContract, owner, proxy, implementation, notes[] }",
    fields: [TOKEN, NETWORK],
    tags: ["contract", "owner", "proxy", "safety"],
  },
  {
    id: "trending-pools",
    name: "Trending Pools",
    category: "onchain",
    price: "0.01",
    summary: "The pools traders are hitting right now, with price change, volume and liquidity.",
    provider: "Wafermap · GeckoTerminal",
    returns: "{ network, pools[] }",
    fields: [NETWORK],
    tags: ["trending", "hot", "movers", "pools"],
  },
  {
    id: "new-pools",
    name: "New Pools",
    category: "onchain",
    price: "0.005",
    summary: "Freshly created pools, newest first, with age, liquidity and early volume.",
    provider: "Wafermap · GeckoTerminal",
    returns: "{ network, pools[] }",
    fields: [NETWORK],
    tags: ["new", "launch", "fresh", "pools"],
  },
  {
    id: "market-brief",
    name: "Market Brief",
    category: "onchain",
    price: "0.03",
    summary: "Trending and new pools in one call, written up as a short brief by an LLM.",
    provider: "Wafermap · Workers AI",
    returns: "{ network, brief, pools[] }",
    fields: [NETWORK],
    tags: ["market", "brief", "summary", "today"],
  },
  {
    id: "wallet-balances",
    name: "Wallet Balances",
    category: "onchain",
    price: "0.002",
    summary: "ETH and stablecoin balances for any address, plus any tokens you list.",
    provider: "Wafermap",
    returns: "{ address, network, balances[] }",
    fields: [
      { name: "address", type: "address", required: true, description: "Wallet address (0x…).", example: "0x0000000000000000000000000000000000000000" },
      NETWORK,
      { name: "tokens", type: "string", description: "Extra token addresses, comma-separated (up to 10)." },
    ],
    tags: ["wallet", "balance", "portfolio"],
  },
  {
    id: "gas-now",
    name: "Gas Now",
    category: "onchain",
    price: "0.001",
    summary: "Current gas price and latest block on Robinhood Chain or Base.",
    provider: "Wafermap",
    returns: "{ network, block, gasPriceGwei }",
    fields: [NETWORK],
    tags: ["gas", "fee", "block"],
  },

  // Tokenized stocks (Robinhood Chain)
  {
    id: "stock-tokens",
    name: "Stock Tokens",
    category: "stocks",
    price: "0.002",
    summary: "Every active stock token on Robinhood Chain: ticker, name, contract and whether a Chainlink feed prices it.",
    provider: "Wafermap · Robinhood registry",
    returns: "{ total, stocks[] }",
    fields: [{ name: "query", type: "string", description: "Filter by ticker or company name.", max: 60, example: "tesla" }],
    tags: ["stocks", "equities", "xstocks", "tokenized", "list"],
  },
  {
    id: "stock-signal",
    name: "Stock Token Signal",
    category: "stocks",
    price: "0.02",
    summary: "One stock token: Chainlink reference price, on-chain DEX price, the premium between them and a short AI read.",
    provider: "Wafermap · Chainlink · Workers AI",
    returns: "{ stock, reference, dex, premiumPct, signal: { stance, summary, risks[] } }",
    fields: [{ name: "symbol", type: "string", required: true, description: "Ticker (TSLA) or token address.", max: 64, example: "TSLA" }],
    tags: ["stocks", "signal", "tsla", "nvda", "premium", "tokenized", "trading"],
  },

  // Prediction markets (Polymarket)
  {
    id: "prediction-markets",
    name: "Prediction Markets",
    category: "prediction",
    price: "0.003",
    summary: "Live Polymarket markets with outcome odds, volume, liquidity and end date. Search by topic or browse the busiest.",
    provider: "Wafermap · Polymarket",
    returns: "{ markets[]: { question, outcomes[{ name, probability }], volume24hUsd, liquidityUsd, endDate, url } }",
    fields: [
      { name: "query", type: "string", description: "Topic to search, e.g. fed rates, bitcoin, election.", max: 120, example: "bitcoin" },
      { name: "sort", type: "enum", description: "Without a query: busiest, ending soon or newest.", options: ["volume", "ending", "new"], example: "volume" },
      { name: "limit", type: "number", description: "How many markets, 20 at most.", max: 20, example: 10 },
    ],
    tags: ["polymarket", "prediction", "odds", "bets", "forecast", "election"],
  },
  {
    id: "prediction-read",
    name: "Prediction Read",
    category: "prediction",
    price: "0.02",
    summary: "One Polymarket market, read by an LLM: what the odds price in, the week's move, catalysts and risks.",
    provider: "Wafermap · Polymarket · Workers AI",
    returns: "{ market, history[], read: { summary, pricedIn, lean, confidence, catalysts[], risks[] } }",
    fields: [{ name: "market", type: "string", required: true, description: "Polymarket link, slug, market id, or a few words to find the busiest matching market.", max: 300, example: "fed interest rates" }],
    tags: ["polymarket", "prediction", "analysis", "odds", "forecast"],
  },

  // Content
  {
    id: "token-starter-kit",
    name: "Token Starter Kit",
    category: "content",
    price: "0.08",
    summary: "From one idea: three name and ticker options, a tagline, a short lore and a logo.",
    provider: "Wafermap · Workers AI",
    returns: "{ names[], tagline, lore, logo: data:image/png;base64,… }",
    fields: [{ name: "idea", type: "string", required: true, description: "The idea, in a sentence.", max: 500, example: "A cat that only trades on weekends" }],
    tags: ["token", "launch", "logo", "name", "meme"],
  },
  {
    id: "x-post-writer",
    name: "X Post Writer",
    category: "content",
    price: "0.01",
    summary: "Three ready-to-post X drafts under 280 characters, in the tone you ask for.",
    provider: "Wafermap · Workers AI",
    returns: "{ posts[] }",
    fields: [
      { name: "topic", type: "string", required: true, description: "What the posts are about.", max: 1500, example: "Our agent now pays for its own tools" },
      { name: "tone", type: "enum", description: "Voice.", options: ["confident", "playful", "technical", "minimal"], example: "confident" },
    ],
    tags: ["twitter", "x", "post", "tweet", "copy"],
  },
  {
    id: "prompt-refine",
    name: "Prompt Refiner",
    category: "content",
    price: "0.004",
    summary: "Turn a rough idea into a precise prompt for an image or text model.",
    provider: "Wafermap · Workers AI",
    returns: "{ prompt, negative }",
    fields: [
      { name: "idea", type: "string", required: true, description: "Your rough idea.", max: 1500, example: "logo for a robot bank" },
      { name: "target", type: "enum", description: "What the prompt is for.", options: ["image", "text"], example: "image" },
    ],
    tags: ["prompt", "creative", "director"],
  },
];

export const byId = (id: string) => RESOURCES.find((r) => r.id === id);

/** Official mark of the model maker or data source behind each resource (files in /logos).
 *  Tools Wafermap composes itself carry the Wafermap mark. */
const MAKER: Record<string, string> = {
  "kimi-k2-6": "kimi",
  "deepseek-v4-pro": "deepseek",
  "deepseek-v4-1-flash": "deepseek",
  "glm-5-3": "zai",
  "qwen-3-8": "qwen",
  "nemotron-3": "nvidia",
  "gpt-oss-120b": "openai",
  "stt-whisper": "openai",
  "llama-4-scout": "meta",
  "vision-describe": "meta",
  translate: "meta",
  "gemma-4": "gemma",
  "flux-2-dev": "bfl",
  "flux-2-klein-4b": "bfl",
  "flux-1-schnell": "bfl",
  "lucid-origin": "leonardo",
  "phoenix-1": "leonardo",
  "tts-aura-2": "deepgram",
  "tts-melo": "myshell",
  "stock-tokens": "robinhood",
  "stock-signal": "chainlink",
  "prediction-markets": "polymarket",
  "prediction-read": "polymarket",
};
const PNG = new Set(["leonardo", "polymarket"]);
export const logoOf = (id: string) => `/logos/${MAKER[id] ?? "wafermap"}.${PNG.has(MAKER[id]) ? "png" : "svg"}`;

/** USD decimal string -> 6-decimal base units (USDG and USDC both use 6). */
export function toUnits(price: string): bigint {
  const [w, f = ""] = price.split(".");
  return BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export function formatPrice(price: string): string {
  const n = Number(price);
  if (n >= 0.01) return `$${n.toFixed(n < 0.1 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${price}`;
}

export const NETWORKS = {
  robinhood: { id: 4663, caip: "eip155:4663", name: "Robinhood Chain", asset: "USDG", gecko: "robinhood", explorer: "https://robinhoodchain.blockscout.com" },
  base: { id: 8453, caip: "eip155:8453", name: "Base", asset: "USDC", gecko: "base", explorer: "https://basescan.org" },
} as const;
export type NetworkKey = keyof typeof NETWORKS;

/** Where a payment can be made. Wider than NETWORKS, which are the chains the data resources read.
 *  Every one of these is USD-pegged at 6 decimals, so a price is the same number of base units everywhere. */
export const PAY_NETWORKS = {
  robinhood: { ...NETWORKS.robinhood, vm: "evm" },
  solana: { id: 0, caip: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", name: "Solana", asset: "USDC", explorer: "https://solscan.io", vm: "svm" },
  base: { ...NETWORKS.base, vm: "evm" },
  arbitrum: { id: 42161, caip: "eip155:42161", name: "Arbitrum", asset: "USDC", explorer: "https://arbiscan.io", vm: "evm" },
  polygon: { id: 137, caip: "eip155:137", name: "Polygon", asset: "USDC", explorer: "https://polygonscan.com", vm: "evm" },
} as const;
export type PayNetworkKey = keyof typeof PAY_NETWORKS;
/** The EVM payment networks, which the Wafermap wallet (web and CLI) can sign for. */
export const EVM_PAY = ["robinhood", "base", "arbitrum", "polygon"] as const;
export type EvmPayKey = (typeof EVM_PAY)[number];
export const isEvmPay = (v: unknown): v is EvmPayKey => EVM_PAY.includes(v as EvmPayKey);
/** Every network the Wafermap agent wallet pays on, in the order the UI lists them. */
export const PAY_KEYS = ["robinhood", "solana", "base", "arbitrum", "polygon"] as const satisfies readonly PayNetworkKey[];
export const isPayKey = (v: unknown): v is PayNetworkKey => PAY_KEYS.includes(v as PayNetworkKey);
/** "eip155:42161", "arbitrum" or "42161" → "arbitrum". */
export function payNetworkOf(v: string): PayNetworkKey | null {
  const s = String(v ?? "").toLowerCase();
  for (const [k, n] of Object.entries(PAY_NETWORKS)) if (s === k || s === n.caip.toLowerCase() || (n.id && s === String(n.id))) return k as PayNetworkKey;
  return null;
}
