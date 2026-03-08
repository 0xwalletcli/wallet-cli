# About

## One-liner

Self-custodial CLI for DeFi. Swap, bridge, stake, off-ramp — no exchange needed. ETH, SOL, Base.

## Short (for bios, socials, GitHub description)

Self-custodial CLI wallet for DeFi. Swap, bridge, stake, and off-ramp across Ethereum, Base, and Solana — no exchange, no KYC, no custody risk. Your keys, your coins, your terminal.

## Medium (for README intros, forum posts)

wallet-cli is a self-custodial command-line wallet for DeFi. It connects directly to on-chain protocols — CoW Swap, Uniswap, Jupiter, Lido, Jito, deBridge, LI.FI, Peer — so you can swap, bridge, stake, and off-ramp without ever touching a centralized exchange. Supports Ethereum, Base, and Solana. Sign with private keys, WalletConnect (MetaMask mobile), or browser extensions. Mainnet defaults to dry-run so you can preview everything before committing real funds.

## Long (for landing pages, Show HN, detailed intros)

wallet-cli is a self-custodial command-line wallet that gives you direct access to DeFi protocols across Ethereum, Base, and Solana. No centralized exchange. No KYC. No custody risk.

**What it does:**
- Swap tokens via CoW Swap, Uniswap, LI.FI (Ethereum/Base) or Jupiter (Solana)
- Bridge across Ethereum, Base, and Solana via deBridge or LI.FI
- Stake ETH via Lido (~3% APR) and SOL via Jito (~7% APR)
- Zap USDC into staked assets in one step (swap + stake or bridge + stake)
- Off-ramp to fiat via Peer (P2P on Base — Venmo, Zelle, CashApp, Revolut) or Spritz (bank ACH)
- Compare routes across providers before every transaction
- Full balance dashboard with staking yields, pending withdrawals, and USD values

**What makes it different:**
- Self-custodial — your keys never leave your machine
- Multi-chain — Ethereum, Base, and Solana in one tool
- Multi-provider — auto-compares CoW/Uniswap/LI.FI/Jupiter/deBridge, shows you the best rate
- Safe by default — mainnet commands are dry-run unless you pass `--run`
- Audit gate — `wallet audit` verifies all integrations before mainnet writes
- Flexible signing — `.env` keys, WalletConnect (MetaMask mobile QR), or browser extensions (MetaMask, Coinbase Wallet, Phantom, Solflare)
- No backend — everything runs locally, talks directly to RPCs and protocol APIs

**Who it's for:**
- DeFi power users who want terminal-native access
- Developers building on top of DeFi protocols
- Anyone who wants to manage crypto without trusting a centralized exchange

---

## Key facts

| | |
|---|---|
| **Chains** | Ethereum, Base, Solana |
| **Swap providers** | CoW Swap, Uniswap, LI.FI (Ethereum/Base), Jupiter (Solana) |
| **Bridge providers** | deBridge, LI.FI |
| **Staking** | Lido stETH (~3% APR), Jito JitoSOL (~7% APR) |
| **Off-ramp** | Peer (P2P — Venmo/Zelle/CashApp/Revolut), Spritz (bank ACH) |
| **Signing** | Private keys, WalletConnect, browser extensions |
| **Safety** | Dry-run by default on mainnet, audit gate, network egress firewall |
| **License** | MIT |
| **Language** | TypeScript (Node.js, ESM) |
| **Dependencies** | viem, @solana/web3.js, commander |

## Hashtags / keywords

`#DeFi` `#CLI` `#self-custodial` `#Ethereum` `#Solana` `#Base` `#staking` `#P2P` `#off-ramp` `#open-source`
