# wallet-cli Feature Roadmap

Goal: Make wallet-cli the one-stop-shop for all personal finance needs.

---

## Completed Features

- **Feature 0: Wallet Audit + Mainnet Gate** — `wallet audit` with comprehensive price/pool/API checks + `checkAuditGate()` blocks mainnet writes if stale >7 days. Checks: CoinGecko prices, CoW Swap ETH + WSOL-ETH quotes, Jupiter SOL quote, deBridge bridge quote + status API, Uniswap API, LI.FI API, Etherscan API, cross-platform spread, USDC peg, stETH/ETH ratio, Lido TVL, Jito pool health, netguard completeness, RPC connectivity.
- **Feature 1: Execute Preview + Confirmation** — all write commands have structured preview + confirm()
- **Feature 2: Buy Command** — `wallet buy <amount> <token>` via Jupiter ExactOut (SOL), multi-provider CoW/Uniswap/LI.FI (ETH, WSOL-ETH), wrap (WSOL)
- **Feature 3: WSOL Support** — wrap/unwrap, balance display, send, tokens listing (Solana SPL WSOL)
- **Feature 3b: WSOL-ETH Support** — Wormhole wrapped SOL on Ethereum as ERC-20. Swap/buy/send/balance via CoW Swap. CLI name: `wsol-eth`
- **Feature 4: Bridge USDC Cross-Chain** — `bridge usdc usdc-sol`, `bridge usdc-sol usdc`, `bridge usdc-sol eth`
- **Feature 4b: Quote Command** — `wallet quote <amount>` compares 6 DeFi paths (CoW/Uniswap/LI.FI+Lido, deBridge/LI.FI+Jito, deBridge+Jupiter+Jito) for deploying USDC into staked assets. Shows fees, slippage, cost-per-unit, and yield projections.
- **Feature 4c: Zap Command** — `wallet zap <amount> usdc <asset>` one-step USDC → staked asset. stETH path (multi-provider swap+Lido), JitoSOL with 2 paths (multi-provider bridge direct vs bridge+Jupiter). Preview + path selection + sequential execution. History aggregated from all providers.
- **Feature 7: Security Audit Research** — assessed Lido (A), Jito (A), deBridge (A+), CoW Swap (A). All category leaders with strong security records. No changes needed.
- **Feature 8: Provider Architecture + Multi-DEX/Bridge** — `SwapProvider`/`BridgeProvider` interfaces, provider registry, auto-registration via side-effect imports. Swap providers: CoW Swap, Uniswap (Trading API + UniswapX), LI.FI. Bridge providers: deBridge, LI.FI. Commands refactored to use provider abstraction. Default mode: `auto` (fetch all providers, show comparison table, user selects). Pin with `wallet config set swap <id>` or `--route <id>`. Config stored at `~/.wallet-cli/config.json`.
- **Feature 9: Enhanced Staking Display** — `wallet balance full` staking dashboard: exchange rates, APR/APY (Lido + Jito APIs), USD values (CoinGecko), earned tracking (stETH via Etherscan deposits, JitoSOL via Solana RPC transaction parsing), projected annual yield, pending Lido withdrawals. Default `wallet balance` shows compact balances only. Staked token labels are clickable links to Lido/Jito. Wallet addresses link to block explorers. `wallet health` shows APR/APY in staking section. `wallet quote` shows yield projections per path ($/yr + base asset/yr). Shared staking module (`src/lib/staking.ts`).
- **Feature 10: Solana Swaps (Jupiter)** — `wallet swap usdc sol` / `wallet swap sol usdc` via Jupiter aggregator. Shared `src/lib/jupiter.ts` module (quote, swap, history, mint lookup). Dynamic slippage (100 bps default, up to 300 bps), dynamic compute units, priority fees, retry on send. Friendly error handling for slippage tolerance exceeded (0x1771). Jupiter history integrated into `wallet swap history`.
- **Feature 11: Value Command** — `wallet value <amount> <token> [target]` shows USD value of any managed asset + cross-token conversion (e.g., `value 10000 usdc eth`). Staked assets resolve through base token: stETH -> ETH -> USD (rate from Lido contract `getPooledEthByShares`), JitoSOL -> SOL -> USD (rate from Jito stake pool). Supports: eth, weth, sol, wsol, wsol-eth, usdc, steth, jitosol.
- **Feature 12: Price Fallback** — shared `src/lib/prices.ts` with CoinGecko primary + DeFi Llama fallback. All price-dependent commands (balance, value, quote, zap, health) use `fetchPrices()`. Never blocked by CoinGecko 429 rate limits. `coins.llama.fi` added to netguard allowlist.
- **Feature 13: History Polish** — all history commands: compact single-line table format, parallel fetch (EVM + Solana via `Promise.allSettled`), clickable shortened IDs/tx hashes (OSC 8 terminal hyperlinks via `link()`/`txLink()` in format.ts), amounts displayed for all operations (Solana: parsed from pre/post balances; ETH unstake: decoded from calldata + internal txs), aligned fixed-width columns, configurable limit (`HISTORY_LIMIT` in config.ts). Bridge status normalization via STATUS_MAP (raw API states -> short display names). Solana txs resolve known token mints (USDC, JitoSOL, WSOL) instead of showing generic "SPL".
- **Feature 17: Off-Ramp (Multi-Provider)** — `wallet withdraw <amount>` sends USDC to fiat via configurable off-ramp providers. `OfframpProvider` interface in `src/providers/types.ts`, registry in `src/providers/registry.ts`, auto-registration via side-effect imports. Pin provider: `wallet config set offramp spritz|peer` or auto-detect first configured provider. Subcommands: `withdraw deposits [closed]`, `withdraw liquidity <amt>`, `withdraw deposit <amt>`, `withdraw add/remove/close/pause/resume <id>`, `withdraw accounts`, `withdraw history`. Providers: Spritz Finance (USDC->bank via ACH), **Peer** (decentralized P2P on Base — Venmo, Zelle, CashApp, Revolut — non-custodial, no KYC/KYB, `@zkp2p/offramp-sdk`). Mainnet only.
- **Feature 18: Base Chain Support** — Full Base L2 support across all commands. Tokens: `ETH-BASE` (native ETH on Base), `USDC-BASE` (USDC on Base). Commands updated: balance (Base section), send (ETH-BASE/USDC-BASE), swap (same-chain Base swaps via LI.FI), bridge (Ethereum↔Base, Base↔Solana via deBridge/LI.FI), transactions (Base tx history via Etherscan V2), health (Base RPC checks), tokens (Base token listing), value (eth-base/usdc-base pricing), audit (Base RPC audit), buy (redirection to bridge/swap). Config: `EvmChain` type (`'ethereum' | 'base'`), per-chain EVM client caching, `BASE_CHAINS` (mainnet 8453, testnet 84532 Base Sepolia), `BASE_TOKENS`, `BASESCAN_CHAIN_ID`, Base in `EXPLORERS`. WalletConnect includes `eip155:8453`/`eip155:84532`. Base RPC: `base-rpc.publicnode.com` (mainnet), `base-sepolia-rpc.publicnode.com` (testnet). Override with `BASE_RPC_URL` env var.

---

## Feature 15: Fiat On-Ramp (with 2FA)

**Status:** TODO (off-ramp handled by Feature 17 via multi-provider architecture)
**Priority:** Medium (very nice to have)
**Complexity:** High

### Goal

```
wallet deposit 5000 usd    -> bank -> USDC on Ethereum (no CEX custody)
wallet withdraw 5000 usdc  -> USDC on Ethereum -> bank (no CEX custody)
```

### Key Constraint

Every fiat-to-crypto path requires a licensed money transmitter between your bank and the blockchain. The question is whether that intermediary is a **full CEX** (you hold funds in their custody) or a **pass-through ramp** (funds go directly to your self-custodial wallet). All options below are pass-through ramps — they handle fiat rails but never custody your crypto.

**Truly headless fiat-to-crypto (zero browser interaction)** is extremely rare due to KYC/AML regulations. Most providers require a one-time browser-based KYC step, after which subsequent transactions can be more automated.

### Recommended Approach: Tiered (Non-CEX Primary, CEX Fallback)

#### Option A (Primary): Coinbase Onramp API — Zero-Fee USDC

This is NOT the Coinbase Exchange. It's the Coinbase Developer Platform's on-ramp product — a pass-through service where USDC goes directly to your self-custodial wallet.

**On-ramp flow:**
1. CLI calls Coinbase Onramp REST API to create a session (server-side, API key auth)
2. CLI opens a browser URL for user to authorize payment (ACH/Apple Pay/debit card)
   - First time: KYC + payment method setup (~2 min)
   - Subsequent: one-click confirmation
3. Coinbase sends USDC **directly to user's self-custodial wallet address**
4. **Fee: 0% on USDC** (zero-fee USDC program)

**Off-ramp flow:**
1. CLI calls Coinbase Offramp REST API to create a session
2. User signs a tx sending USDC to a Coinbase-provided address
3. Coinbase converts to USD and sends via ACH to user's linked bank
4. **Fee: 0% on USDC**
5. Caveat: user needs a Coinbase account with linked bank for off-ramp

Guest Checkout: up to $500/week with Apple Pay/debit, no Coinbase account needed for on-ramp.

#### Option B: Transak Stream — Best Non-CEX Off-Ramp

Transak Stream allows off-ramp without any widget — user sends USDC to a designated address, Transak reconciles and deposits fiat to bank. On-ramp requires a widget.

**Off-ramp flow:**
1. CLI calls Transak API to get a deposit address
2. CLI builds + signs a USDC transfer to that address
3. Transak converts to fiat, deposits via ACH (US) or SEPA (EU)
4. **Fee: 1% flat**
5. No CEX account required

**On-ramp:** Requires Transak widget (browser redirect). 1% fee.

#### Option C: MoonPay CLI — Most Terminal-Native

MoonPay launched `moonpay-cli` (Feb 24, 2026) — a non-custodial CLI tool with fiat on/off-ramp. Purpose-built for terminal use.

**Flow:**
1. First time: KYC through MoonPay checkout (browser)
2. After setup: headless transactions via saved payment method
3. **Fees: ~1% bank transfer, up to 4.5% card**
4. Supports Apple Pay, Venmo, PayPal as funding sources
5. US available, USDC on Ethereum supported

### Provider Comparison (Non-CEX Only)

| Provider | On-Ramp | Off-Ramp | Headless? | Fees | US + USDC ETH | Notes |
|----------|---------|----------|-----------|------|---------------|-------|
| **Coinbase Onramp** | Yes | Yes | Partial (browser for payment auth) | **0% USDC** | Yes | Best fees, not a CEX — pass-through ramp |
| **Transak Stream** | Yes (widget) | **Yes (headless)** | Off-ramp: yes. On-ramp: no | 1% flat | Yes | Best headless off-ramp |
| **MoonPay CLI** | Yes | Yes | After initial KYC | 1-4.5% | Yes | Only truly CLI-native option |

### Recommended Strategy

1. **Primary on-ramp:** Coinbase Onramp (0% USDC fee, browser for payment auth only)
2. **Primary off-ramp:** Coinbase Offramp (0% USDC fee) OR Transak Stream (1% but no CB account needed)
3. **Fallback:** MoonPay CLI (terminal-native, higher fees)
4. **CEX exchange APIs (Coinbase Advanced Trade, Kraken) go in Feature 16 (Brokerage Integrations), not here**

### 2FA Implementation (TOTP)

- Generate TOTP shared secret on `wallet setup-2fa`
- Display QR code in terminal (use `qrcode-terminal` npm package)
- User scans with Google Authenticator / Authy / 1Password
- Store encrypted secret in `~/.wallet-cli/config.enc`
- Before deposit/withdraw: prompt for 6-digit TOTP code, validate with `otpauth` or `speakeasy` npm package
- Generate recovery codes on setup

### New Files

- `src/commands/deposit.ts` — on-ramp command
- `src/commands/withdraw.ts` — off-ramp command
- `src/lib/totp.ts` — 2FA helpers
- `src/lib/ramp.ts` — on-ramp/off-ramp provider abstraction (Coinbase Onramp + Transak)

### Netguard

Add `api.developer.coinbase.com`, `global.transak.com`, `api.moonpay.com` to `ALLOWED_HOSTS`.

---

## Feature 17: Off-Ramp (Multi-Provider Architecture)

**Status:** DONE — Spritz + Peer implemented.
**Priority:** High (core personal utility)
**Complexity:** Medium

### Goal

```
wallet withdraw 500                    # off-ramp USDC to bank (Spritz) or create P2P deposit (Peer)
wallet withdraw deposits               # list active Peer deposits
wallet withdraw liquidity 100          # preview P2P orderbook
wallet withdraw deposit 500            # create deposit (interactive — platforms, spreads)
wallet withdraw add 42 200             # add funds to deposit
wallet withdraw remove 42 100          # remove funds from deposit
wallet withdraw close 42               # close + withdraw all
wallet withdraw pause/resume 42        # toggle buyer acceptance
wallet withdraw accounts               # list linked accounts / active deposits
wallet withdraw history                # past withdrawals / intents
wallet config set offramp spritz|peer  # pin a specific provider
```

### Architecture (DONE)

Multi-provider off-ramp using `OfframpProvider` interface (same pattern as swap/bridge):
- `src/providers/types.ts` — `OfframpProvider`, `OfframpQuote`, `OfframpBankAccount`, `OfframpOrderSummary`
- `src/providers/registry.ts` — `registerOfframpProvider()`, `getOfframpProvider()`, `listConfiguredOfframpProviders()`
- `src/providers/offramp/spritz.ts` — Spritz Finance provider (first implementation)
- `src/lib/config.ts` — `offrampProvider` config field, `resolveOfframpProvider()`
- `src/commands/withdraw.ts` — provider-agnostic withdraw command

### Provider Status

| Provider | Status | Type | Fees | KYB? | 1099-DA? |
|----------|--------|------|------|------|----------|
| **Spritz Finance** | Implemented but account disabled | Custodial | ~1% | No (individual) | Yes >$10K |
| **Peer** | **DONE** | Decentralized, non-custodial | 0% (0.5% bridge) | No | No |
| **Transak** | Researched | Custodial (widget) | ~1% | Yes (KYB) | Yes >$10K |
| **MoonPay** | Researched | Custodial (widget) | 1-4.5% | Yes (KYB) | Yes >$10K |
| **Bridge.xyz** | Researched | Custodial (pure API) | Custom | Yes (KYB) | Yes >$10K |

### Peer (peer.xyz) — DONE

Decentralized P2P off-ramp using zero-knowledge proofs. Non-custodial, no KYC/KYB, no broker reporting.

**How it works:**
1. Deposit USDC into Peer escrow contract (on Base)
2. Set exchange rate (spread %) + payment methods (Venmo, Zelle, CashApp, Revolut)
3. Buyer sends fiat via chosen payment app
4. Buyer proves payment with ZK proof (zkTLS)
5. Smart contract releases USDC to buyer

**Implementation:**
- SDK: `@zkp2p/offramp-sdk` (Zkp2pClient — deposit management, quotes, intents)
- Contracts: `@zkp2p/contracts-v2` (V2 escrow on Base)
- Provider: `src/providers/offramp/peer.ts` (OfframpProvider + deposit lifecycle functions)
- Lib: `src/lib/peer.ts` (SDK wrapper, Base USDC helpers, spread/rate conversion)
- Env: EVM signer required (EVM_PRIVATE_KEY or WC_PROJECT_ID)
- Netguard hosts: `api.zkp2p.xyz`, `indexer.hyperindex.xyz`, `attestation-service.zkp2p.xyz`
- Commands: `withdraw deposit/deposits/liquidity/add/remove/close/pause/resume`
- Payment methods: Venmo, Zelle (any bank), CashApp, Revolut
- Deposit creation is interactive: select platforms → enter handles → set spread
- USDC must be on Base (bridge from Ethereum first: `wallet bridge <amt> usdc usdc-base`)

### Tax Context

- Any custodial provider is a "broker" under IRS 1099-DA rules (starting 2025)
- **De minimis exemption:** Brokers can skip reporting if qualifying stablecoin sales < $10K/year per broker
- USDC → USD is $0 gain regardless — 1099-DA is paperwork, not tax liability
- Only truly decentralized protocols (Peer) avoid broker classification

### Bill Pay (Future)

Spritz also supports bill pay (credit cards, mortgages, utilities via Plaid). This is blocked until the Spritz account issue is resolved or an alternative bill pay provider is found.

### Netguard

Current: `api.spritz.finance`, `platform.spritz.finance`, `api.zkp2p.xyz`, `indexer.hyperindex.xyz`, `attestation-service.zkp2p.xyz`

---

## Feature 19: MCP Server (AI Agent + Mobile Remote Control)

**Status:** NEXT — planning complete
**Priority:** High (unlocks AI-powered wallet management + mobile signing)
**Complexity:** Medium-High

### Goal

Expose wallet-cli as a Model Context Protocol (MCP) tool server so AI agents (Claude Code, Cursor, any MCP client) can manage DeFi operations programmatically. Extend with remote control for mobile wallet signing.

```
# Use wallet-cli from Claude Code (or any MCP-compatible AI)
> "Check my balances across all chains"
> "Swap 100 USDC to ETH on mainnet"
> "Create a Peer deposit for 500 USDC with Venmo and Zelle at 2% spread"
> "Show me the best staking yield paths for 10,000 USDC"

# Mobile remote control
wallet connect mobile                  # generates QR / deep link
                                       # mobile wallet signs txs remotely
```

### Phase 1: MCP Tool Server (Core)

Expose wallet-cli commands as MCP tools that AI agents can call.

**Architecture:**
```
┌──────────────────┐     MCP (stdio/SSE)     ┌──────────────────┐
│  Claude Code     │ ◄──────────────────────► │  wallet-cli MCP  │
│  (or any AI)     │                          │  server          │
└──────────────────┘                          └───────┬──────────┘
                                                      │
                                              ┌───────▼──────────┐
                                              │  wallet-cli core │
                                              │  (existing code) │
                                              └──────────────────┘
```

**MCP Tools to expose:**

| Tool | Description | Read/Write |
|------|-------------|------------|
| `wallet_balance` | Get balances across all chains | Read |
| `wallet_value` | Get USD value of tokens | Read |
| `wallet_health` | Check service status | Read |
| `wallet_audit` | Run security audit | Read |
| `wallet_txs` | Transaction history | Read |
| `wallet_tokens` | Supported tokens list | Read |
| `wallet_quote` | Compare DeFi paths | Read |
| `wallet_swap` | Swap tokens (requires confirmation) | Write |
| `wallet_bridge` | Bridge cross-chain (requires confirmation) | Write |
| `wallet_send` | Send tokens (requires confirmation) | Write |
| `wallet_stake` | Stake ETH/SOL (requires confirmation) | Write |
| `wallet_unstake` | Unstake (requires confirmation) | Write |
| `wallet_zap` | One-step USDC -> staked asset (requires confirmation) | Write |
| `wallet_withdraw` | Off-ramp / deposit management (requires confirmation) | Write |
| `wallet_deposits` | List Peer deposits | Read |
| `wallet_liquidity` | Preview P2P orderbook | Read |
| `wallet_config` | View/set config | Read/Write |

**Safety model:**
- Read tools: no confirmation needed, return data directly
- Write tools: return preview first (dry-run), require explicit confirmation tool call to execute
- All write tools honor the existing audit gate (mainnet blocked if stale >7 days)
- Network operations: same netguard protection applies

**Implementation:**
- New file: `src/mcp/server.ts` — MCP server using `@anthropic-ai/sdk` or `@modelcontextprotocol/sdk`
- New file: `src/mcp/tools.ts` — tool definitions (name, description, input schema, handler)
- Entry point: `wallet mcp` command starts the MCP server (stdio transport for Claude Code)
- SSE transport option for remote/web clients: `wallet mcp --transport sse --port 8765`
- Each tool handler calls existing command functions (reuse, don't duplicate)
- Tool results return structured JSON (not console.log output)

**MCP Resources to expose:**
- `wallet://config` — current CLI configuration
- `wallet://balances` — live balance snapshot
- `wallet://deposits` — active Peer deposits

**Configuration (Claude Code):**
```json
// .claude/settings.json or claude_desktop_config.json
{
  "mcpServers": {
    "wallet": {
      "command": "wallet",
      "args": ["mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "...",
        "EVM_PRIVATE_KEY": "..."
      }
    }
  }
}
```

### Phase 2: Remote Control (Mobile Signing)

Enable mobile wallet signing for MCP-initiated transactions via WalletConnect relay.

**Architecture:**
```
┌──────────────┐     MCP      ┌──────────────┐     WC Relay     ┌──────────────┐
│  Claude Code │ ◄───────────► │  wallet-cli  │ ◄──────────────► │  Mobile App  │
│  (AI agent)  │              │  MCP server  │                  │  (MetaMask)  │
└──────────────┘              └──────────────┘                  └──────────────┘
```

**Flow:**
1. `wallet connect mobile` — establishes persistent WalletConnect session with mobile wallet
2. AI agent calls `wallet_swap` tool via MCP
3. MCP server builds the transaction, returns preview to AI
4. AI confirms, MCP server sends tx signing request to mobile via WC relay
5. User approves on phone → tx signed and broadcast
6. MCP server returns result to AI agent

**Why this works:**
- WalletConnect v2 already implemented (`src/signers/walletconnect.ts`)
- Just needs: persistent session management + MCP server integration
- Mobile app (MetaMask, Phantom) handles key storage + biometric auth
- No private keys on the server/CLI machine at all

### Phase 3: Multi-Client Support

Support multiple MCP transport types for different use cases:

| Transport | Use Case | Auth |
|-----------|----------|------|
| `stdio` | Claude Code (local) | Process isolation |
| `SSE` | Web dashboard, remote AI | API key / JWT |
| `WebSocket` | Real-time mobile app | WalletConnect session |

**Future extensions:**
- Telegram bot via MCP SSE transport
- Discord bot for team wallet management
- Scheduled operations (DCA, rebalancing) via cron + MCP
- Multi-wallet support (manage multiple addresses)

### New Files

```
src/
  mcp/
    server.ts           — MCP server setup (stdio + SSE transports)
    tools.ts            — tool definitions + handlers (calls existing command functions)
    resources.ts        — MCP resource providers (config, balances, deposits)
    auth.ts             — API key validation for SSE transport
```

### Dependencies

- `@modelcontextprotocol/sdk` — MCP server SDK (TypeScript)
- No new deps for Phase 2 (WalletConnect already installed)

### Netguard

No new hosts needed — MCP uses stdio/local transports. SSE runs locally.
WalletConnect relay already whitelisted.

### Security Considerations

- MCP stdio transport: inherently safe (same process isolation as running `wallet` directly)
- SSE transport: requires API key auth, bind to localhost by default
- Write tools: always require explicit confirmation (no auto-execute)
- Audit gate: enforced for all write operations regardless of client
- Private keys: never exposed via MCP tools (signing happens internally or via WC)

---

## Feature 16: CEX & Brokerage Integrations (Long-term)

**Status:** TODO — research phase
**Priority:** Low (very far down the line)
**Complexity:** Very High

This is the only section where CEX integrations belong. Core wallet operations (swap, bridge, buy, deposit, withdraw) should use non-custodial/pass-through providers. CEX integrations here are for portfolio aggregation, DCA, stock trading, and advanced features.

### Platform Assessment

#### Tier 1: Realistic (Good APIs, can build today)

**Coinbase Advanced Trade API** (crypto trading + portfolio view)
- Full REST API with official SDKs (Python, TypeScript)
- Buy/sell crypto, check balances, withdraw to external wallet, market data
- Auth: JWT (API key + secret from Developer Platform)
- Rate limits: 10,000 req/hour
- Docs: https://docs.cdp.coinbase.com/advanced-trade/docs/welcome
- **Use case here: portfolio aggregation, DCA automation, not core on/off-ramp**

**Alpaca** (US stocks + crypto)
- Commission-free US stocks and options, 0.15/0.25% crypto
- Full REST + WebSocket API, official Python SDK (`alpaca-py`)
- Paper trading environment for safe development
- Auth: API key + secret
- Docs: https://docs.alpaca.markets/
- **Best developer-first option for stocks**

**Kraken** (crypto)
- Full REST + WebSocket + FIX API
- Supports programmatic fiat deposit/withdrawal (unlike Coinbase)
- Auth: API key + private key (HMAC-SHA512)
- Community Python SDK: `python-kraken-sdk`
- Docs: https://docs.kraken.com/

#### Tier 2: Possible but Limited

**Robinhood**
- Official Crypto Trading API exists (launched recently): https://docs.robinhood.com/
  - Crypto only. No stocks, no options via API.
  - Auth: API key from Crypto Account Settings portal
- Stocks/options: **No official public API.**
- **Not recommended until they release a full stocks API**

**Interactive Brokers**
- Most comprehensive: stocks, options, futures, forex, bonds, crypto across 170 markets
- Requires TWS or IB Gateway running locally (not purely REST)
- Good for advanced multi-asset portfolio management but adds operational complexity

### Recommended Implementation Order

1. **Coinbase** — already needed for Feature 15, covers crypto trading + on/off ramp
2. **Alpaca** — commission-free stocks, cleanest API for equities
3. **Plaid** — unified portfolio view (bank + brokerage balances)
4. **Kraken** — secondary crypto exchange, better fiat support
5. **Interactive Brokers** — advanced users, international markets
6. **Robinhood** — only if they release a full stocks API

### High-Value Features Once Integrated

- **Unified portfolio view**: `wallet portfolio` showing all assets across all platforms
- **Automated DCA**: scheduled buys via Coinbase (crypto) + Alpaca (stocks)
- **Rebalancing**: compute drift from target allocation, suggest/execute trades
- **Tax data export**: aggregate transaction history into CSV for tax tools

---

## Feature 14: Encrypted Keystore + Signer Abstraction

**Status:** Partially complete (signer abstraction + WalletConnect done, encrypted keystore TODO)
**Priority:** High
**Complexity:** Medium

### Problem

Private keys stored as plain text in `.env`. Anyone with file access (disk theft, backup leak, accidental commit) gets full control of both EVM and Solana wallets. No encryption at rest, no password protection.

### Solution: Signer Abstraction Layer

Abstract signing behind a common interface so multiple key storage backends can coexist:

```
┌─────────────┐
│  CLI Command │  (swap, send, bridge, etc.)
└──────┬──────┘
       │
┌──────▼──────┐
│   Signer    │  resolveSigner(chain, opts) → { sign, address }
└──────┬──────┘
       │ resolves based on config + flags
       ├── EnvSigner          (.env private key — current default, backward compat)
       ├── KeystoreSigner     (AES-256-GCM encrypted file + scrypt KDF)
       ├── LedgerSigner       (USB HID via @ledgerhq packages)
       ├── WalletConnectSigner (QR → MetaMask/Phantom mobile)
       └── (future: Trezor, macOS Keychain, etc.)
```

### Phase 1: Encrypted Keystore (this feature)

Password-protected encrypted keystore files, same pattern as `geth account new` and Foundry's `cast wallet import`.

**Encryption scheme:**
- **KDF:** scrypt (N=2^18, r=8, p=1) — password → 32-byte key
- **Cipher:** AES-256-GCM (from `@noble/ciphers` — already installed as viem dep, zero new deps)
- **Format:** JSON file with salt, nonce, ciphertext, scrypt params, chain type, public address
- **Storage:** `~/.wallet-cli/keystores/<name>.json`

**Keystore file format:**
```json
{
  "version": 1,
  "name": "my-evm",
  "chain": "evm",
  "address": "0x1234...abcd",
  "crypto": {
    "cipher": "aes-256-gcm",
    "kdf": "scrypt",
    "kdfparams": { "n": 262144, "r": 8, "p": 1, "dklen": 32 },
    "salt": "<hex>",
    "nonce": "<hex>",
    "ciphertext": "<hex>",
    "tag": "<hex>"
  }
}
```

**New CLI commands:**
```
wallet keys list                          # show all configured signers (env, keystore files, etc.)
wallet keys import <name>                 # import a key into encrypted keystore
                                          #   prompts for: private key, password (twice)
                                          #   derives address, encrypts, saves to ~/.wallet-cli/keystores/<name>.json
wallet keys import <name> --from-env      # import current .env key into keystore (migrate)
wallet keys delete <name>                 # delete a keystore file (with confirmation)
wallet keys export <name>                 # decrypt and display private key (with password + confirmation)
```

**Signer selection:**
```
wallet swap ETH USDC 1.0                          # uses default signer (config or env fallback)
wallet swap ETH USDC 1.0 --signer keystore:my-evm # explicit keystore
wallet swap ETH USDC 1.0 --signer env             # explicit .env
wallet config set signer keystore:my-evm           # set default signer
```

**Session password caching:**
- First command that needs signing prompts for password
- Decrypted key held in memory for the session (single CLI invocation)
- No persistent password caching across invocations (each `wallet` run prompts once)
- Password input uses hidden/masked terminal input

### Phase 2: Ledger Hardware Wallet (future)

- EVM: viem has built-in Ledger support via `@ledgerhq/hw-transport-node-hid`
- Solana: `@ledgerhq/hw-app-solana` + `@solana/web3.js` transaction signing
- Keys never touch disk
- New dep: `@ledgerhq/hw-transport-node-hid`, `@ledgerhq/hw-app-solana`
- Commands: `wallet keys ledger` (test connection), `--signer ledger` flag

### Phase 3: WalletConnect v2 — DONE

- `wallet connect [evm|solana]` — QR code in terminal → scan with MetaMask / Phantom (supports multiple sessions for both chains)
- `wallet disconnect [wallet]` — close session(s) (by wallet name or all)
- `wallet keys` — show env keys + WC sessions
- `wallet config set signer wc` — set WC as default signer
- EVM: custom viem `LocalAccount` via `toAccount()`, `eth_sendTransaction` + `eth_signTypedData_v4` via WC relay
- Solana: `solana_signTransaction` for both VersionedTransaction and legacy Transaction
- Session persistence in `~/.wallet-cli/wc-sessions/`
- Deps: `@walletconnect/sign-client`, `qrcode-terminal`
- Netguard: `relay.walletconnect.com` added to allowlist
- Files: `src/signers/walletconnect.ts`, `src/commands/connect.ts`

### Phase 4: macOS Keychain (future, optional)

- macOS-only via `/usr/bin/security` CLI
- Requires controlled exception in netguard for that one binary
- Nice-to-have for Mac users but not cross-platform
- Commands: `wallet keys import <name> --keychain`, `--signer keychain:<name>`

### Completed: Signer Abstraction + WalletConnect

**Files created:**
- `src/signers/types.ts` — `Signer` interface
- `src/signers/env.ts` — `EnvSigner` (wraps .env keys)
- `src/signers/walletconnect.ts` — `WalletConnectSigner` (WC v2 relay)
- `src/signers/index.ts` — `resolveSigner()` factory
- `src/commands/connect.ts` — connect/disconnect/keys commands

**Files modified:**
- All commands and providers use `resolveSigner()` instead of direct key access
- `src/lib/evm.ts` — `getWalletClient()` is async, uses signer
- `src/lib/solana.ts` — signing functions accept `Signer` instead of `Keypair`
- `src/lib/jupiter.ts` — accepts `Signer` instead of `Keypair`
- `src/lib/config.ts` — added `signer` field to config schema
- `src/lib/netguard.ts` — added `relay.walletconnect.com`
- `src/index.ts` — registered connect/disconnect/keys commands

### Signer Interface (implemented)

```typescript
interface Signer {
  type: 'env' | 'walletconnect';
  label: string;
  getEvmAddress(): Promise<`0x${string}` | null>;
  getSolanaAddress(): Promise<string | null>;
  getEvmAccount(): Promise<LocalAccount>;
  getEvmWalletClient(chain, transport): Promise<WalletClient<HttpTransport, Chain, LocalAccount>>;
  signSolanaVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
  signAndSendSolanaTransaction(conn: Connection, tx: Transaction): Promise<string>;
}
```

### New Files Needed (Phase 1 — Encrypted Keystore, still TODO)

- `src/lib/keystore.ts` — encrypt/decrypt keystore files, scrypt + AES-256-GCM
- `src/signers/keystore.ts` — `KeystoreSigner` implementing `Signer`
- `src/commands/keys.ts` — `wallet keys import`, `wallet keys delete`, `wallet keys export`

### Migration Path

1. `.env` remains the default signer — zero breaking changes
2. `wallet keys import my-evm --from-env` migrates existing key to keystore
3. `wallet config set signer keystore:my-evm` switches default
4. User can then remove `EVM_PRIVATE_KEY` from `.env`
5. All existing commands work unchanged — signer resolution is transparent

### Security Comparison

| | .env (current) | Encrypted keystore | Ledger | WalletConnect |
|---|---|---|---|---|
| Encryption at rest | None | AES-256-GCM + scrypt | N/A (hardware) | N/A (phone) |
| File access = key access | Yes | No (need password) | No | No |
| Backup leak exposure | Full | Password-protected | None | None |
| Offline signing | Yes | Yes | Yes | No |
| Cross-platform | Yes | Yes | Yes | Yes |
| New dependencies | — | None (@noble/ciphers already installed) | @ledgerhq packages | @walletconnect + qrcode |

---

## Implementation Priority

| # | Feature | Status | Priority |
|---|---------|--------|----------|
| 17 | Off-ramp (Spritz + Peer) | **DONE** — both providers implemented | High |
| 19 | MCP Server (AI agent + mobile remote control) | **NEXT** | High |
| 14 | Encrypted keystore + signer abstraction | Signer + WC done, keystore TODO | High |
| 15 | Fiat on-ramp/off-ramp + 2FA | TODO | Medium |
| 16 | Brokerage integrations | TODO | Low |
