# wallet-cli

CLI tool for managing crypto without centralized exchanges.

- **Balance** dashboard across Ethereum, Base, and Solana with USD values (`full` for staking details + pending withdrawals)
- **Swap** tokens via [CoW Swap](https://cow.fi), [Uniswap](https://uniswap.org), or [LI.FI](https://li.fi) on Ethereum; [LI.FI](https://li.fi) on Base; [Jupiter](https://jup.ag) on Solana
- **Buy** ETH, SOL, WSOL-ETH, or WSOL with USDC via [CoW Swap](https://cow.fi)/[Uniswap](https://uniswap.org)/[LI.FI](https://li.fi) (Ethereum) or [Jupiter](https://jup.ag) (Solana)
- **Bridge** across Ethereum, Base, and Solana via [deBridge](https://debridge.finance) or [LI.FI](https://li.fi) (ETH/USDC cross-chain)
- **Send** ETH, USDC, WSOL-ETH on Ethereum; ETH-BASE, USDC-BASE on Base; SOL, WSOL on Solana
- **Stake** ETH via [Lido](https://lido.fi) (~3% APR), SOL via [Jito](https://jito.network) (~7% APR)
- **Unstake** stETH (Lido withdrawal queue, 1-5 days) or JitoSOL (Jito instant)
- **Zap** USDC into staked assets in one step — stETH (swap+Lido) or JitoSOL (bridge+Jito)
- **Value** any token in USD, or convert between tokens (`wallet value 10000 usdc eth`)
- **Quote** compare end-to-end costs across DeFi staking paths + off-ramp paths (Peer P2P liquidity, Spritz ACH)
- **Transactions** history across Ethereum, Base, and Solana with clickable explorer links
- **Wrap/Unwrap** native assets: ETH ↔ WETH, SOL ↔ WSOL
- **Audit** all integrations before mainnet transactions (prices, pools, contracts, APIs)
- **Deposit** fiat to buy USDC via P2P ([Peer](https://peer.xyz) — decentralized, non-custodial, no KYC)
- **Withdraw** USDC to fiat via [Peer](https://peer.xyz) P2P (Venmo/Zelle/CashApp/Revolut, Base chain) or [Spritz](https://spritz.finance) ACH
- **Connect** MetaMask, Coinbase Wallet, Phantom (EVM via WalletConnect or browser extension; Solana via browser extension) — sign transactions without storing private keys
- **Address book** for human-readable wallet names
- **Price fallback** — CoinGecko primary, DeFi Llama fallback (never blocked by rate limits)

## Requirements

- **Node.js** v18.x or later
- **npm** v9+ (ships with Node 18)

## Setup

```bash
npm install
cp .env.example .env
npm link                        # makes `wallet` available globally
```

### Option A: Connect a wallet (recommended)

Sign transactions with MetaMask, Coinbase Wallet, or Phantom — private keys never touch disk.

```bash
# EVM via WalletConnect (mobile QR — requires WC_PROJECT_ID in .env from https://cloud.reown.com)
wallet connect evm
wallet config set signer evm wc

# EVM via browser extension (MetaMask, Coinbase Wallet, Phantom — no project ID needed)
wallet connect evm browser
wallet config set signer evm browser

# Solana via browser extension (Phantom, Solflare, Backpack, Coinbase Wallet)
wallet connect solana
wallet config set signer solana browser
```

### Option B: Use private keys in `.env`

Store keys locally for fully offline signing.

Edit `.env`:

```bash
# Ethereum private key (never shared, stays local)
EVM_PRIVATE_KEY=0x...

# Solana wallet
SOLANA_PRIVATE_KEY=...          # base58 encoded, needed for send/stake/swap on Solana
```

### Optional settings (both options)

```bash
# Custom RPC URLs (public endpoints used by default)
EVM_RPC_URL=
BASE_RPC_URL=
SOLANA_RPC_URL=

# Transaction history (free key at https://etherscan.io/apis)
ETHERSCAN_API_KEY=               # Ethereum txs; Base txs require paid Etherscan V2 plan

# Alternative swap providers
UNISWAP_API_KEY=               # free key from https://developers.uniswap.org
LIFI_API_KEY=                  # increases LI.FI rate limit (200 req/2hr → 200 req/min)

# Off-ramp (withdraw USDC to bank)
SPRITZ_API_KEY=                # Spritz Finance: https://app.spritz.finance
# Peer P2P off-ramp on Base requires an EVM signer (EVM_PRIVATE_KEY or WC_PROJECT_ID)
```

## Quick Start

```bash
npm link                        # makes `wallet` available globally
wallet audit                    # required before mainnet transactions
wallet balance                  # see all balances
wallet balance full             # include staking details + pending withdrawals
wallet health                   # check all services + prices
```

## Workflow

Here's the typical flow, starting with USDC on Ethereum:

### 1. Audit + pre-flight

```bash
# Run the full audit (required every 7 days for mainnet)
wallet audit

# Quick health check
wallet health

# Verify token addresses
wallet tokens

# Starting balances — confirm USDC landed
wallet balance
```

### 2. Register your wallets

```bash
wallet address add coinbase-eth --evm 0x...
wallet address add coinbase-sol --solana ...
wallet address add phantom --solana ...
```

### 3. Configure providers (optional)

By default, swap/bridge/buy/zap commands compare all available providers and let you select.
Pin a default to skip the comparison:

```bash
wallet config                              # show current config
wallet config set swap cow                 # always use CoW Swap
wallet config set bridge debridge          # always use deBridge
wallet config set signer evm wc           # EVM via WalletConnect (MetaMask mobile)
wallet config set signer evm browser     # EVM via browser extension (MetaMask, Coinbase, Phantom)
wallet config set signer solana browser   # Solana via browser extension
wallet config set signer solana env       # Solana via .env keys
wallet config set signer env              # both chains via .env keys (default)
wallet config reset                        # back to defaults
```

Override for a single command:

```bash
wallet swap 100 usdc eth --route uniswap
wallet bridge 1000 usdc sol --route lifi
```

### 4. Swap tokens

```bash
# EVM swaps (CoW Swap / Uniswap / LI.FI — auto-compare)
wallet swap 2000 usdc eth --run
wallet swap 0.5 eth usdc --run
wallet swap 500 usdc wsol-eth --run
wallet swap 5 wsol-eth eth --run

# Base swaps (LI.FI)
wallet swap 500 usdc-base eth-base --run
wallet swap 0.1 eth-base usdc-base --run

# Solana swaps (Jupiter)
wallet swap 100 usdc sol --run
wallet swap 1 sol usdc --run

# Buy — specify the exact token amount you want
wallet buy 1 eth --run
wallet buy 10 sol --run
```

### 5. Bridge across chains

```bash
# Ethereum <-> Solana
wallet bridge 5000 usdc sol --run
wallet bridge 1 eth sol --run
wallet bridge 1 eth sol --to phantom --run

# Ethereum <-> Base
wallet bridge 1000 usdc usdc-base --run
wallet bridge 0.5 eth eth-base --run
wallet bridge 500 usdc-base usdc --run

# Base <-> Solana
wallet bridge 1000 usdc-base sol --run
wallet bridge 5 sol usdc-base --run
```

### 6. Check values

```bash
# See USD value of any token amount
wallet value 1 eth
wallet value 0.5 eth-base
wallet value 100 usdc
wallet value 100 usdc-base
wallet value 1.5 steth        # shows ETH + USD (stETH -> ETH -> USD)
wallet value 10 jitosol       # shows SOL + USD (JitoSOL -> SOL -> USD)
wallet value 5 wsol-eth
```

### 7. Zap (one-step USDC -> staked asset)

```bash
# USDC -> ETH -> stETH in one step (compares swap providers)
wallet zap 10000 usdc steth --run

# USDC -> SOL -> JitoSOL (compares bridge providers x paths)
wallet zap 5000 usdc jitosol --run
wallet zap 5000 usdc jitosol --path 1 --run    # direct SOL bridge -> Jito
wallet zap 5000 usdc jitosol --path 2 --run    # USDC bridge + Jupiter -> Jito

# Compare all paths before deciding
wallet quote 10000
```

### 8. Stake manually (if not using zap)

```bash
# Stake ETH -> stETH via Lido (~3% APR)
wallet stake 2 eth --run

# Stake SOL -> JitoSOL via Jito (~7% APR)
wallet stake 20 sol --run
```

### 9. Unstake

```bash
# Request Lido withdrawal (stETH -> ETH, 1-5 day queue)
wallet unstake 0.5 steth --run

# Claim finalized Lido withdrawals
wallet unstake claim steth --run

# Instant unstake JitoSOL -> SOL
wallet unstake 10 jitosol --run
```

### 10. Deposit — on-ramp (fiat → USDC)

Check available USDC to buy via Peer P2P.

```bash
wallet deposit platforms                     # supported payment platforms
wallet deposit liquidity 1000               # available USDC to buy
```

### 11. Withdraw — off-ramp (USDC → fiat)

Off-ramp via Peer P2P (Venmo/Zelle/CashApp/Revolut) or Spritz ACH.

```bash
# Off-ramp USDC to fiat
wallet withdraw 1000 --run                   # lock USDC, select platforms + spread
wallet withdraw liquidity 5000              # check off-ramp liquidity

# Manage positions
wallet withdraw list                         # active positions
wallet withdraw list closed                  # closed positions
wallet withdraw add 42 200 --run             # add $200 to position #42
wallet withdraw remove 42 100 --run          # remove $100 from position #42
wallet withdraw close 42 --run               # close position + reclaim USDC
wallet withdraw pause 42 --run               # stop accepting buyers
wallet withdraw resume 42 --run              # resume
wallet withdraw platforms                    # supported payment platforms
wallet withdraw accounts                     # linked bank accounts (Spritz)
wallet withdraw history                      # recent activity
```

### 12. Send to external wallets

```bash
wallet send 0.5 eth coinbase-eth --run
wallet send 0.1 eth-base coinbase-eth --run
wallet send 100 usdc-base coinbase-eth --run
wallet send 5 sol coinbase-sol --run
wallet send 10 sol phantom --run
```

### 13. Review

```bash
wallet balance                 # balances across Ethereum, Base, and Solana
wallet balance full            # include staking details + pending withdrawals
wallet txs                     # recent transactions (all chains)
wallet swap history            # recent swap orders
wallet bridge history          # recent bridge orders
wallet stake history           # recent staking transactions
wallet unstake history         # recent unstakes + pending Lido withdrawals
wallet zap history             # recent zap operations
wallet buy history             # recent buy orders
wallet withdraw list            # active Peer positions
wallet withdraw history        # recent off-ramp activity
```

## All Commands

| Command | Description |
|---------|-------------|
| `wallet balance [target]` | Show balances across Ethereum, Base, and Solana. Use `full` for staking details + pending withdrawals |
| `wallet value <amt> <token>` | Show USD value of a token amount (staked assets show base + USD). Supports eth-base, usdc-base |
| `wallet swap <amt> <from> <to>` | Swap via CoW/Uniswap/LI.FI (Ethereum), LI.FI (Base), or Jupiter (Solana) |
| `wallet swap history` | Recent swap orders (CoW + Uniswap + LI.FI + Jupiter) |
| `wallet swap status <orderId>` | Check specific swap order |
| `wallet buy <amt> <token>` | Buy tokens with USDC — multi-provider (eth, wsol-eth), Jupiter (sol), wrap (wsol) |
| `wallet buy history` | Recent buy orders |
| `wallet bridge <amt> <from> <to> [--to]` | Bridge via deBridge / LI.FI (Ethereum↔Base, Ethereum↔Solana, Base↔Solana) |
| `wallet bridge history` | Recent bridge orders (deBridge + LI.FI) |
| `wallet bridge status <orderId>` | Check specific bridge order |
| `wallet send <amt> <token> <recipient>` | Send to a wallet or address book name (eth, usdc, wsol-eth, eth-base, usdc-base, sol, wsol) |
| `wallet stake <amt> <token>` | Liquid stake ETH (Lido) or SOL (Jito) |
| `wallet stake history` | Recent staking transactions |
| `wallet unstake <amt> <token>` | Unstake stETH (Lido) or JitoSOL (Jito) |
| `wallet unstake claim steth` | Claim finalized Lido withdrawals |
| `wallet unstake history` | Recent unstakes + pending Lido withdrawals |
| `wallet wrap <amt> <token>` | Wrap native assets (e.g., `wrap 1 eth`, `wrap 5 sol`) |
| `wallet unwrap [amt] <token>` | Unwrap wrapped assets (e.g., `unwrap weth`, `unwrap 0.5 weth`, `unwrap wsol`) |
| `wallet zap <amt> usdc <asset>` | One-step USDC -> staked asset (steth, jitosol) |
| `wallet zap history` | Recent zap operations |
| `wallet quote <amount>` | Compare end-to-end costs + yield projections (6 paths across all providers) |
| `wallet config` | View current CLI configuration |
| `wallet config set <key> <value> [chain]` | Set config (e.g., `config set swap cow`, `config set signer evm wc`) |
| `wallet config reset` | Reset config to defaults (auto) |
| `wallet audit` | Security audit of all integrations (required every 7 days for mainnet) |
| `wallet health` | Check status of all RPCs, APIs, staking APR/APY, and asset prices |
| `wallet txs [--limit N]` | Show recent transactions across Ethereum, Base, and Solana (default 15) |
| `wallet tokens` | Show supported tokens, addresses, and explorer links |
| `wallet mint <token> [amount]` | Get testnet tokens — `mint eth`, `mint usdc` (faucet links), `mint sol 2` (airdrop) |
| `wallet approve <token> <spender> <amt>` | ERC-20 approval helper |
| `wallet deposit platforms` | Supported payment platforms for buying USDC |
| `wallet deposit liquidity <amount>` | Available USDC to buy via Peer P2P (on-ramp) |
| `wallet withdraw <amount>` | Off-ramp USDC to fiat via Peer P2P or Spritz ACH |
| `wallet withdraw liquidity <amount>` | Check off-ramp liquidity |
| `wallet withdraw list [closed]` | List active or closed Peer positions |
| `wallet withdraw add <id> <amount>` | Add USDC to a position |
| `wallet withdraw remove <id> <amount>` | Remove USDC from a position |
| `wallet withdraw close <id>` | Close position and reclaim USDC |
| `wallet withdraw pause/resume <id>` | Pause or resume accepting buyers |
| `wallet withdraw platforms` | Supported payment platforms (Peer) |
| `wallet withdraw accounts` | List linked bank accounts (Spritz) |
| `wallet withdraw history` | Recent off-ramp activity |
| `wallet cancel [orderId]` | Cancel a pending CoW Swap order |
| `wallet connect [chain] [browser]` | Connect wallet — EVM via WalletConnect or `evm browser`; Solana via browser (MetaMask, Coinbase, Phantom, Solflare) |
| `wallet disconnect [target]` | Disconnect session(s) — WC + browser (`disconnect evm`, `disconnect solana`, `disconnect metamask`, or all) |
| `wallet keys` | Show signing keys, WalletConnect sessions, and browser sessions |
| `wallet address add <name>` | Add to address book (`--evm`, `--solana`) |
| `wallet address list` | List saved addresses |
| `wallet address remove <name>` | Remove from address book |

## Supported Swap Pairs

| Pair | Chain | Provider |
|------|-------|----------|
| USDC <-> ETH | Ethereum | CoW Swap / Uniswap / LI.FI |
| USDC <-> WSOL-ETH | Ethereum | CoW Swap / Uniswap / LI.FI |
| ETH <-> WSOL-ETH | Ethereum | CoW Swap / Uniswap / LI.FI |
| ETH-BASE <-> USDC-BASE | Base | LI.FI |
| USDC <-> SOL | Solana | Jupiter |

## Supported Bridge Routes

| Route | Provider |
|-------|----------|
| ETH -> SOL | deBridge / LI.FI |
| USDC -> SOL | deBridge / LI.FI |
| USDC -> USDC-SOL | deBridge / LI.FI |
| SOL -> ETH | deBridge / LI.FI |
| SOL -> USDC | deBridge / LI.FI |
| USDC-SOL -> USDC | deBridge / LI.FI |
| USDC-SOL -> ETH | deBridge / LI.FI |
| USDC-SOL -> SOL | deBridge / LI.FI |
| ETH -> ETH-BASE | deBridge / LI.FI |
| USDC -> USDC-BASE | deBridge / LI.FI |
| ETH-BASE -> ETH | deBridge / LI.FI |
| USDC-BASE -> USDC | deBridge / LI.FI |
| ETH-BASE -> SOL | deBridge / LI.FI |
| USDC-BASE -> SOL | deBridge / LI.FI |
| SOL -> ETH-BASE | deBridge / LI.FI |
| SOL -> USDC-BASE | deBridge / LI.FI |

## Global Flags

| Flag | Description | Default |
|------|-------------|---------|
| `-n, --network` | `mainnet` or `testnet` | `mainnet` |
| `--dry-run` | Simulate without executing | `true` on mainnet |
| `--run` | Execute for real (required on mainnet) | — |
| `--route <id>` | Override swap/bridge provider (`cow`, `uniswap`, `lifi`, `debridge`) | `auto` |

## Security

- **Audit gate** — mainnet write commands are blocked unless a passing `wallet audit` has been run within the last 7 days. The audit verifies all integrated services, price sanity, pool health, stETH/ETH ratio, and USDC peg stability.
- **Network egress guard** — all outbound connections are restricted to a whitelist of known hosts (RPCs, CoW, deBridge, Jupiter, Uniswap, LI.FI, Spritz, Peer, CoinGecko, DeFi Llama). Even if an npm dependency is compromised, it cannot phone home with your keys.
- **`child_process` disabled** — prevents subprocess-based exfiltration (`curl`, `wget`, etc.)
- **UDP sockets blocked** — prevents DNS-tunneling exfiltration
- **Install scripts disabled** (`.npmrc: ignore-scripts=true`) — prevents `postinstall` attacks
- **Signer abstraction** — pluggable per-chain signing: `.env` keys (default), WalletConnect for EVM (mobile QR), browser bridge for EVM + Solana (MetaMask, Coinbase Wallet, Phantom, Solflare, Backpack) — private keys never touch disk
- Private keys stay in `.env` on your machine — never sent anywhere (or use WalletConnect/browser to avoid storing keys entirely)
- All transactions require explicit `[y/N]` confirmation before signing
- ERC-20 approvals use infinite allowance (reduces repeated approval transactions)
- Mainnet operations show a warning banner
- Bridge validates contract addresses against known deBridge DLN contracts
- Balances are checked before attempting transactions
- `.env` is in `.gitignore` — never committed

## Peer Off-ramp: On-chain vs Off-chain

[Peer](https://peer.xyz) (prev ZKP2P) is a decentralized P2P off-ramp. Here's exactly what happens on-chain vs off-chain:

**On-chain (trustless, verifiable on Base):**
- USDC escrow — positions are locked in smart contracts (`0x2f121cdd...88888`), not held by Peer
- Intent signaling — buyer commits to purchase on-chain
- Fund release — USDC released to buyer after zero-knowledge proof of fiat payment
- All custody is non-custodial — the protocol contracts hold funds, not any company

**Off-chain (centralized API at `api.zkp2p.xyz`):**
- Liquidity discovery — finding available positions and matching buyers to sellers
- Quote/pricing — the `/v2/quote` endpoint aggregates available LP rates
- ZK proof verification relay — verifying proof-of-payment (e.g., you prove you sent Venmo without revealing account details)

**Why we use the API:** The on-chain contracts don't have a built-in order book. To find available positions and their rates, you'd have to scan all contract events and index them yourself — which is what Peer's indexer (`indexer.hyperindex.xyz`) does. The API is a convenience layer over on-chain state. We could theoretically read positions directly from the contract, but it would be significantly slower and more complex.

**Supported payment platforms:** Venmo, Zelle, CashApp, Revolut. Available liquidity varies by platform and changes in real-time — `wallet quote`, `wallet withdraw liquidity`, and `wallet health` show current availability.

## How It Works

| Action | Protocol | Mechanism |
|--------|----------|-----------|
| **Balance** | Multi-chain | Balances across Ethereum, Base, Solana + staking dashboard (rates, APR/APY, USD, earned, yields) |
| **Value** | CoinGecko + DeFi Llama | USD pricing for any managed asset; staked assets resolve through base token |
| **Swap (Ethereum)** | Multi-provider | CoW (gasless intent), Uniswap (AMM/UniswapX), LI.FI (aggregator) |
| **Swap (Base)** | LI.FI | ETH-BASE <-> USDC-BASE via LI.FI aggregator |
| **Swap (Solana)** | Jupiter | USDC <-> SOL via Jupiter aggregator with dynamic slippage |
| **Buy** | Multi-provider / Jupiter | Buy order (ETH, WSOL-ETH) or Jupiter ExactOut (SOL) |
| **Bridge** | Multi-provider | deBridge or LI.FI (Ethereum↔Base, Ethereum↔Solana, Base↔Solana) |
| **Stake ETH** | Lido | ETH -> stETH, auto-rebasing liquid staking (~3% APR) |
| **Stake SOL** | Jito | SOL -> JitoSOL, liquid staking + MEV rewards (~7% APR) |
| **Unstake ETH** | Lido | stETH -> request withdrawal (1-5 day queue) -> claim ETH |
| **Unstake SOL** | Jito | JitoSOL -> SOL, instant via SPL stake pool |
| **Withdraw** | Multi-provider | USDC -> fiat: Spritz (bank ACH) or Peer (P2P on Base — Venmo/Zelle/CashApp/Revolut) |
| **Send** | Direct transfer | ETH/ERC-20 (Ethereum), ETH-BASE/USDC-BASE (Base), or SOL/SPL (Solana) to any address |
| **Wrap/Unwrap** | WETH / WSOL | Native assets (ETH/SOL) to ERC-20/SPL equivalents and back |
| **Zap** | Multi-platform | USDC -> stETH (swap+Lido) or USDC -> JitoSOL (bridge+Jito) |
| **Quote** | Multi-platform | 6 paths with yield projections across all providers |
| **Audit** | Multi-platform | Prices, quotes, pool health, stETH ratio, USDC peg, API connectivity |

## Provider Architecture

Swap, bridge, and off-ramp protocols are pluggable providers behind a common interface. By default (`auto`), commands fetch quotes from **all** available providers, show a comparison table, and let you select. Use `wallet config set swap|bridge|offramp <id>` or `--route <id>` / `--provider <id>` to pin a specific provider.

| Type | Provider | Notes |
|------|----------|-------|
| **Swap** | [CoW Swap](https://cow.fi) | Gasless, MEV-protected, EIP-712 intents |
| **Swap** | [Uniswap](https://uniswap.org) | Classic (on-chain AMM) + UniswapX (gasless Dutch auction). Requires `UNISWAP_API_KEY` |
| **Swap** | [LI.FI/Jumper](https://li.fi) | DEX aggregator, sell-only (no ExactOutput) |
| **Swap** | [Jupiter](https://jup.ag) | Solana DEX aggregator, USDC <-> SOL with dynamic slippage |
| **Bridge** | [deBridge](https://debridge.finance) | Cross-chain ETH/USDC/SOL both ways |
| **Bridge** | [LI.FI/Jumper](https://li.fi) | Cross-chain bridge aggregator |
| **Off-ramp** | [Spritz Finance](https://spritz.finance) | USDC -> bank account via ACH (US, mainnet only) |
| **Off-ramp** | [Peer](https://peer.xyz) | Decentralized P2P off-ramp on Base — Venmo, Zelle, CashApp, Revolut. Non-custodial, no KYC |

Provider resolution order: `--route`/`--provider` flag > `wallet config` setting > `auto` (all providers).

## Price Sources

USD prices use CoinGecko as the primary source with automatic DeFi Llama fallback. If CoinGecko returns a 429 (rate limited), prices transparently fall through to DeFi Llama with no user intervention. This applies to: `balance`, `value`, `quote`, `zap`, and `health` commands.
