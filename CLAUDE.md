# wallet-cli

DeFi wallet CLI for swapping, bridging, staking, and managing funds across Ethereum and Solana without centralized exchanges.

## Running

```bash
wallet <command>           # global (requires npm link)
npx tsx src/index.ts       # from project root
npm run wallet -- <args>   # via npm script
```

Default network is `mainnet`. Use `--network testnet` or `-n testnet` for testnet.

## Conventions

- **When adding new commands**: always update `README.md` (All Commands table + workflow examples) and this `CLAUDE.md` file (Architecture section + any relevant sections).
- **Dry-run defaults**: mainnet defaults to dry-run (safe). Use `--run` to execute. Testnet defaults to live. `--dry-run` forces simulation on testnet.
- Write commands (swap, send, bridge, stake, unstake, approve, buy, zap, wrap, unwrap, withdraw) support `--dry-run`/`--run`. Read commands (balance, health, history, mint, value) don't.
- **Subcommand pattern**: swap, bridge, stake, unstake use `[args...]` variadic pattern in commander to support subcommands (`history`, `status`). The action handler checks `args[0]` for keyword routing.
- **Solana RPC performance**: Never query signatures from high-traffic contracts (e.g., Jito stake pool). Always query the user's own address and filter results. Fetch chains in parallel with `Promise.allSettled`.
- **When adding a new third-party integration** (API, contract, bridge, DEX): you MUST also expand `src/commands/audit.ts` to verify that service's health, prices, and/or pool liquidity. The audit is the trust gate before mainnet transactions — every external dependency must be covered.
- **Provider abstraction**: Swap and bridge protocols are implemented as providers in `src/providers/`. Each provider implements `SwapProvider` or `BridgeProvider` from `types.ts` and auto-registers via side-effect import in `index.ts`. Commands default to `auto` mode (fetch from all providers, show comparison table, let user select). Use `wallet config set swap <id>` to pin a default, or `--route <id>` to override for a single invocation. Config stored at `~/.wallet-cli/config.json`.
- **Signer abstraction**: All signing goes through the `Signer` interface (`src/signers/types.ts`). Use `resolveSigner()` to get the active signer — never import private key helpers directly. Three signer backends: `EnvSigner` (`.env` keys), `WalletConnectSigner` (EVM via MetaMask mobile QR), `BrowserSigner` (EVM + Solana via localhost page + browser extensions). Commands accept `Signer` instead of raw keypairs. EVM: `signer.getEvmAccount()` returns a viem `LocalAccount`. Solana: `signSolanaVersionedTransaction()` for Jupiter/bridge VersionedTransactions, `signAndSendSolanaTransaction()` for legacy Transactions. For Jito ephemeral signers, `partialSign()` with ephemeral keys first, then pass to `signer.signAndSendSolanaTransaction()`. Signer is configured per-chain: `wallet config set signer evm wc`, `wallet config set signer solana browser`. EVM supports: `env`, `wc`, `browser`. Solana supports: `env`, `browser`. Config stored as `SignerConfig { evm, solana }` in `~/.wallet-cli/config.json`. If not set, defaults to `env`.
- **History limit**: All history/txs commands cap output at `HISTORY_LIMIT` (defined once in `src/config.ts`). Change it there to update everywhere.
- **Price fallback**: Use `fetchPrices()` from `src/lib/prices.ts` for USD pricing — it tries CoinGecko first, falls back to DeFi Llama on rate limit. Never call CoinGecko directly in new code (exception: `audit.ts` intentionally tests CoinGecko health).
- **Terminal links**: Use `link()` and `txLink()` from `src/lib/format.ts` for clickable hyperlinks in terminal output (OSC 8 escape sequences). All tx hashes in history commands should be clickable shortened links.

## Import Order (Critical)

`src/index.ts` imports must stay in this exact order:

```
1. dotenv/config        — loads .env
2. ./lib/netguard.js    — patches net/tls/child_process/dgram BEFORE any deps connect
3. ./lib/txtracker.js   — SIGINT handler for pending transactions
4. ./providers/swap/cow.js + uniswap.js + lifi.js + ./providers/bridge/debridge.js + lifi.js — auto-register providers
5. commander + commands  — everything else
```

Moving netguard after other imports defeats its purpose. If you add a new import that makes network calls at import time, it must come after netguard.

## Security Model

### Network Egress Guard (`src/lib/netguard.ts`)
- Monkey-patches `net.connect`, `tls.connect` to whitelist known hosts
- Blocks all `child_process` methods (prevents curl/wget exfiltration)
- Blocks `dgram.createSocket` (prevents DNS-based exfiltration)
- Custom RPC hosts from `EVM_RPC_URL`/`SOLANA_RPC_URL` env vars are auto-added

**When adding a new external API/RPC endpoint**, you must add its hostname to `ALLOWED_HOSTS` in netguard.ts, otherwise connections will be silently blocked.

### `.npmrc`
- `ignore-scripts=true` — blocks postinstall attacks from compromised packages
- `audit=false` — suppresses misleading bigint-buffer vulnerability warning (not exploitable, it's in Solana's dep chain)

### NEVER run `npm audit fix --force`
It downgrades `@solana/spl-token` and `@solana/spl-stake-pool` to incompatible versions, breaking all Solana functionality. If Solana packages break, restore with:
```bash
npm install @solana/spl-token@0.4.12 @solana/spl-stake-pool@1.1.8
```

## Architecture

```
src/
  index.ts              — entry point, commander setup, [args...] subcommand routing, timed() wrapper, audit gate
  config.ts             — chain configs, token addresses, RPCs, explorer URLs, Jupiter/WSOL/HISTORY_LIMIT config
  signers/
    types.ts            — Signer interface (getEvmAccount, signSolanaVersionedTransaction, etc.)
    env.ts              — EnvSigner: wraps .env private keys (EVM_PRIVATE_KEY, SOLANA_PRIVATE_KEY)
    walletconnect.ts    — WalletConnectSigner: EVM-only signing via WalletConnect v2 relay (MetaMask mobile QR), session persistence (~/.wallet-cli/wc-sessions/)
    browser.ts          — BrowserSigner: EVM + Solana signing via localhost bridge (port 18457) + browser extensions (MetaMask, Coinbase Wallet, Phantom, Solflare, Backpack). Sessions at ~/.wallet-cli/browser-sessions/
    index.ts            — resolveSigner() factory: reads per-chain config (SignerConfig), returns cached Signer (PerChainSigner if EVM/Solana differ)
  commands/
    connect.ts          — `wallet connect [evm [browser]]` / `wallet connect solana` / `wallet disconnect [evm|solana|wallet]` / `wallet keys` for wallet pairing (WC + browser, per-chain disconnect)
    config.ts           — `wallet config` / `config set` / `config reset` for provider preferences
    balance.ts          — multi-chain balance display. Default shows balances only; `full` adds staking dashboard (rates, APR/APY, earned, yields) + pending withdrawals. Supports external addresses/aliases, shows WSOL. Staked token labels link to Lido/Jito, wallet addresses link to explorers.
    value.ts            — `wallet value <amount> <token> [target]` USD pricing + cross-token conversion (e.g., `value 10000 usdc eth`). Staked assets show base+USD (stETH->ETH->USD, JitoSOL->SOL->USD). Gets stETH rate from Lido contract, JitoSOL rate from Jito pool.
    swap.ts             — multi-provider swap: auto-compares CoW/Uniswap/LI.FI (EVM), Jupiter (Solana USDC<->SOL) + history/status
    buy.ts              — buy tokens with USDC: Jupiter ExactOut (SOL), multi-provider buy orders (ETH, WSOL-ETH), wrap (WSOL)
    bridge.ts           — multi-provider bridge: auto-compares deBridge/LI.FI, shows table, lets user select + history/status
    send.ts             — send ETH/USDC/WSOL-ETH (Ethereum) or SOL/WSOL (Solana) to addresses or address book names
    stake.ts            — Lido stETH (ETH) and Jito JitoSOL (SOL) + history subcommand (parallel fetch, clickable tx links)
    unstake.ts          — Lido withdrawal request/claim (ETH) and Jito instant unstake (SOL) + history subcommand (parallel fetch, amounts, clickable tx links, pending Lido withdrawals)
    wrap.ts             — wrap/unwrap native assets: ETH <-> WETH (Ethereum), SOL <-> WSOL (Solana), partial unwrap for WETH
    approve.ts          — ERC-20 token approvals
    audit.ts            — comprehensive audit: prices (ETH, SOL, WSOL-ETH, USDC peg, stETH ratio), pools (Lido, Jito), APIs (CoW, Jupiter, deBridge, Uniswap, LI.FI, Etherscan), RPCs, netguard
    quote.ts            — compare up to 6 DeFi paths (CoW/Uniswap/LI.FI+Lido, deBridge/LI.FI+Jito) for USDC -> staked assets, with yield projections per path
    zap.ts              — one-step USDC -> staked asset: `zap <amt> usdc steth` (multi-provider swap+Lido) or `zap <amt> usdc jitosol` (multi-provider bridge+Jito, 2 paths)
    transactions.ts     — recent transaction history, command: `wallet txs` (Etherscan + Solana in parallel, resolves known Solana token mints)
    tokens.ts           — supported token reference (addresses, decimals, explorer links, includes WSOL)
    health.ts           — service status dashboard (RPCs, APIs, staking APR/APY, prices)
    mint.ts             — testnet faucet (SOL airdrop programmatic, ETH/USDC print URLs)
    withdraw.ts         — withdraw USDC to bank via Spritz Finance off-ramp (Ethereum mainnet only) + accounts/history subcommands
    cancel.ts           — cancel pending CoW Swap orders
    address.ts          — address book management
  providers/
    types.ts            — SwapProvider, BridgeProvider interfaces + SwapQuote, BridgeQuote types
    registry.ts         — registerSwapProvider/getBridgeProvider + listSwapProviders/listBridgeProviders
    swap/
      cow.ts            — CoW Swap provider: EIP-712 signing, quote/submit/poll (consolidates 4x duplication)
      uniswap.ts        — Uniswap provider: Classic (on-chain) + UniswapX (gasless intent), Permit2, local order storage
      lifi.ts           — LI.FI/Jumper swap provider: same-chain EVM swaps, sell-only (no ExactOutput)
    bridge/
      debridge.ts       — deBridge provider: KNOWN_DLN_CONTRACTS, quote/create-tx, poll fulfillment, history/status
      lifi.ts           — LI.FI/Jumper bridge provider: cross-chain via aggregated bridges, poll via /status
  lib/
    prices.ts           — shared price fetcher: CoinGecko primary + DeFi Llama fallback. Used by balance, value, quote, zap, health.
    jupiter.ts          — shared Jupiter API helpers: getJupiterQuote(), buildAndSendJupiterSwap(), getJupiterHistory(), mint/decimals lookup
    staking.ts          — shared Lido APR + Jito APY fetchers (used by balance, health, quote)
    balancedelta.ts     — BalanceTracker: snapshots token balances before/after a transaction, prints deltas
    netguard.ts         — network egress firewall (see Security Model)
    txtracker.ts        — SIGINT handler, prints pending tx hash on Ctrl+C
    auditgate.ts        — audit record management (~/.wallet-cli/audit.json), mainnet gate (blocks if stale >7 days)
    evm.ts              — viem clients (async getWalletClient via resolveSigner), ERC-20 helpers
    solana.ts           — Solana connection, SOL/SPL/WSOL balance helpers, wrap/unwrap (accepts Signer)
    format.ts           — formatToken, parseTokenAmount, formatUSD, formatAddress, formatGasFee, link (OSC 8 hyperlink), txLink (shortened clickable tx hash)
    prompt.ts           — confirm(), validateAmount(), warnMainnet(), warnDryRun(), select() for provider selection
    config.ts           — CLI config load/save (~/.wallet-cli/config.json): swapProvider, bridgeProvider, per-chain signer (SignerConfig { evm, solana })
    spritz.ts           — Spritz Finance API client: payment requests, web3 tx params, bank account listing, payment history
    addressbook.ts      — JSON-file address book (~/.wallet-cli/addresses.json)
```

## Subcommands

swap, bridge, buy, stake, unstake, zap support subcommands via `[args...]` variadic pattern:

| Command | Subcommands |
|---------|-------------|
| `wallet swap` | `history`, `status <orderId>`, `--help` |
| `wallet buy` | `history`, `--help` |
| `wallet bridge` | `history`, `status <orderId>`, `--help` |
| `wallet stake` | `history`, `--help` |
| `wallet unstake` | `history`, `--help` |
| `wallet zap` | `history`, `--help` |
| `wallet withdraw` | `accounts`, `history`, `--help` |

- `history` shows recent orders/transactions for that command
- `status <orderId>` shows detailed info for a specific order (swap/bridge only)
- `--help` shows supported pairs/tokens and available subcommands

## RPCs

Default RPCs are publicnode (fast, free, no API key):
- EVM mainnet: `ethereum-rpc.publicnode.com`
- EVM testnet: `ethereum-sepolia-rpc.publicnode.com`
- Solana mainnet: `solana-rpc.publicnode.com`
- Solana testnet: `api.devnet.solana.com`

Override with `EVM_RPC_URL` and `SOLANA_RPC_URL` env vars.

## Network Constraints

- deBridge: mainnet only (no testnet bridge)
- Jupiter: mainnet only (no devnet support)
- Jito staking/unstaking: mainnet only
- Lido unstaking: two-phase (request withdrawal -> wait 1-5 days -> claim ETH)
- Lido Withdrawal Queue: `0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1` (mainnet)
- Jito unstaking: instant via SPL stake pool `withdrawSol()`
- SOL airdrop (`mint sol`): testnet/devnet only, max 2 SOL per request (loops for larger amounts)
- ETH/USDC faucets: no programmatic API, `mint` prints URLs
- CoW Swap: works on both mainnet and Sepolia
- Uniswap: works on both mainnet and Sepolia, requires UNISWAP_API_KEY
- LI.FI/Jumper: swap (same-chain) and bridge (cross-chain), sell-only (no ExactOutput/buy orders)
- Spritz Finance: mainnet only, US only, requires SPRITZ_API_KEY + Spritz account with linked bank
- Audit gate: mainnet write commands require a passing audit within 7 days

## UX Patterns

- Every command prints immediate feedback before network calls ("Fetching...", "Checking balance...")
- `timed()` wrapper prints elapsed time after every command
- `txtracker.ts` stores pending tx hash — if user hits Ctrl+C during a tx wait, the SIGINT handler prints the tx hash + explorer URL so they can find it
- Explorer links (`TX:` + `URL:`) printed after every broadcast transaction
- History commands show clickable shortened tx hashes via OSC 8 terminal hyperlinks
- Balance command has per-chain error handling (one chain failing doesn't crash the other)
- Multi-chain fetches run in parallel (`Promise.allSettled`) for speed
- All commands show explicit chain labels (e.g., "Chain: Ethereum mainnet", "Chain: Solana mainnet")
- All history commands capped at `HISTORY_LIMIT` (configurable in `src/config.ts`)

## Testing

```bash
npm test              # run all tests (vitest)
```

Tests cover: `parseTokenAmount` for all token decimals, `validateAmount` edge cases (Infinity, scientific notation), price calculation correctness, dry-run defaults, address detection, netguard allowlist completeness.

## Build / TypeScript

- ESM (`"type": "module"` in package.json)
- All internal imports use `.js` extension (e.g., `import './lib/netguard.js'`)
- tsx is the runtime (no build step needed for dev)
- `bigint-buffer` native addon warning: run `npx node-gyp rebuild --directory=node_modules/bigint-buffer` if it appears

## Global Command

`bin/wallet.mjs` is a wrapper that spawns tsx as a child process. It's registered via the `bin` field in package.json. Run `npm link` from the project root to make `wallet` available globally.

## Playbooks

- `PLAY-MAINNET.md` — monthly mainnet workflow (deploy USDC into stETH + JitoSOL)
- `PLAY-TESTNET.md` — testnet dry run (mint, swap, stake on Sepolia/devnet)

## Feature Roadmap

See `FEATURES-LIST.md` for the full feature roadmap with research notes and implementation details.

### Pending Features (in priority order)

5. **Fiat on-ramp** — non-CEX provider (Coinbase Onramp, Transak, MoonPay) + TOTP 2FA
6. **Bill pay** — pay credit cards, mortgages, utilities via Spritz (research complete, pending implementation)
7. **Brokerage integrations** — Coinbase, Alpaca, Kraken, etc. (CEX-only section)

## Environment Variables (.env)

```
EVM_PRIVATE_KEY=0x...       # required for EVM transactions
SOLANA_PRIVATE_KEY=...      # base58, required for SOL send/stake/swap
EVM_RPC_URL=...             # optional, overrides default publicnode RPC
SOLANA_RPC_URL=...          # optional, overrides default publicnode RPC
ETHERSCAN_API_KEY=...       # optional, for transaction history + stake/unstake history
UNISWAP_API_KEY=...         # required for Uniswap swaps (free key from developers.uniswap.org)
LIFI_API_KEY=...            # optional, increases LI.FI rate limit (200 req/2hr → 200 req/min)
WC_PROJECT_ID=...           # optional, required for WalletConnect signing (free from cloud.reown.com)
SPRITZ_API_KEY=...          # optional, required for withdraw command (off-ramp USDC to bank via Spritz)
```
