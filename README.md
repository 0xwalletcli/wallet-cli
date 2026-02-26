# wallet-cli

CLI tool for managing crypto without centralized exchanges.

- **Balance** dashboard across Ethereum + Solana with USD values (`full` for staking details + pending withdrawals)
- **Swap** tokens via [CoW Swap](https://cow.fi), [Uniswap](https://uniswap.org), or [LI.FI](https://li.fi) on Ethereum; [Jupiter](https://jup.ag) on Solana
- **Buy** ETH, SOL, WSOL-ETH, or WSOL with USDC via [CoW Swap](https://cow.fi)/[Uniswap](https://uniswap.org)/[LI.FI](https://li.fi) (Ethereum) or [Jupiter](https://jup.ag) (Solana)
- **Bridge** ETH/USDC/SOL both ways via [deBridge](https://debridge.finance) or [LI.FI](https://li.fi) (cross-chain USDC supported)
- **Send** ETH, USDC, WSOL-ETH on Ethereum; SOL, WSOL on Solana
- **Stake** ETH via [Lido](https://lido.fi) (~3% APR), SOL via [Jito](https://jito.network) (~7% APR)
- **Unstake** stETH (Lido withdrawal queue, 1-5 days) or JitoSOL (Jito instant)
- **Zap** USDC into staked assets in one step — stETH (swap+Lido) or JitoSOL (bridge+Jito)
- **Value** any token in USD, or convert between tokens (`wallet value 10000 usdc eth`)
- **Quote** compare end-to-end costs across multiple DeFi paths with yield projections
- **Transactions** history across Ethereum + Solana with clickable explorer links
- **Wrap/Unwrap** native assets: ETH ↔ WETH, SOL ↔ WSOL
- **Audit** all integrations before mainnet transactions (prices, pools, contracts, APIs)
- **Address book** for human-readable wallet names
- **Price fallback** — CoinGecko primary, DeFi Llama fallback (never blocked by rate limits)

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
# Required — your Ethereum private key (never shared, stays local)
EVM_PRIVATE_KEY=0x...

# Your Solana wallet — for balance checks, bridge recipient, and sending SOL
SOLANA_ADDRESS=...
SOLANA_PRIVATE_KEY=...          # needed for send/stake/swap on Solana

# Optional — custom RPC URLs (public endpoints used by default)
EVM_RPC_URL=
SOLANA_RPC_URL=

# Optional — for transaction history (free key at https://etherscan.io/apis)
ETHERSCAN_API_KEY=

# Optional — alternative swap providers (see Provider Architecture below)
UNISWAP_API_KEY=               # free key from https://developers.uniswap.org
LIFI_API_KEY=                  # increases LI.FI rate limit (200 req/2hr → 200 req/min)
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
wallet config reset                        # back to auto
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

# Solana swaps (Jupiter)
wallet swap 100 usdc sol --run
wallet swap 1 sol usdc --run

# Buy — specify the exact token amount you want
wallet buy 1 eth --run
wallet buy 10 sol --run
```

### 5. Get SOL

```bash
# Option A: Swap USDC -> SOL on Solana (Jupiter, cheapest)
wallet swap 5000 usdc sol --run

# Option B: Bridge USDC -> SOL directly (deBridge, one step)
wallet bridge 5000 usdc sol --run

# Option C: Bridge ETH -> SOL
wallet bridge 1 eth sol --run

# Option D: Bridge to a specific recipient
wallet bridge 1 eth sol --to phantom --run
```

### 6. Check values

```bash
# See USD value of any token amount
wallet value 1 eth
wallet value 100 usdc
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

### 10. Send to external wallets

```bash
wallet send 0.5 eth coinbase-eth --run
wallet send 5 sol coinbase-sol --run
wallet send 10 sol phantom --run
```

### 11. Review

```bash
wallet balance                 # balances across Ethereum + Solana
wallet balance full            # include staking details + pending withdrawals
wallet txs                     # recent transactions (all chains)
wallet swap history            # recent swap orders
wallet bridge history          # recent bridge orders
wallet stake history           # recent staking transactions
wallet unstake history         # recent unstakes + pending Lido withdrawals
wallet zap history             # recent zap operations
wallet buy history             # recent buy orders
```

## All Commands

| Command | Description |
|---------|-------------|
| `wallet balance [target]` | Show balances across Ethereum + Solana. Use `full` for staking details + pending withdrawals |
| `wallet value <amt> <token>` | Show USD value of a token amount (staked assets show base + USD) |
| `wallet swap <amt> <from> <to>` | Swap via CoW/Uniswap/LI.FI (Ethereum) or Jupiter (Solana) |
| `wallet swap history` | Recent swap orders (CoW + Uniswap + LI.FI + Jupiter) |
| `wallet swap status <orderId>` | Check specific swap order |
| `wallet buy <amt> <token>` | Buy tokens with USDC — multi-provider (eth, wsol-eth), Jupiter (sol), wrap (wsol) |
| `wallet buy history` | Recent buy orders |
| `wallet bridge <amt> <from> <to> [--to]` | Bridge via deBridge / LI.FI (ETH/USDC/SOL both ways, cross-chain USDC) |
| `wallet bridge history` | Recent bridge orders (deBridge + LI.FI) |
| `wallet bridge status <orderId>` | Check specific bridge order |
| `wallet send <amt> <token> <recipient>` | Send to a wallet or address book name (eth, usdc, wsol-eth, sol, wsol) |
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
| `wallet config set <key> <value>` | Set config (e.g., `config set swap cow`) |
| `wallet config reset` | Reset config to defaults (auto) |
| `wallet audit` | Security audit of all integrations (required every 7 days for mainnet) |
| `wallet health` | Check status of all RPCs, APIs, staking APR/APY, and asset prices |
| `wallet txs [--limit N]` | Show recent transactions for your wallets (default 15) |
| `wallet tokens` | Show supported tokens, addresses, and explorer links |
| `wallet mint <token> [amount]` | Get testnet tokens — `mint eth`, `mint usdc` (faucet links), `mint sol 2` (airdrop) |
| `wallet approve <token> <spender> <amt>` | ERC-20 approval helper |
| `wallet cancel [orderId]` | Cancel a pending CoW Swap order |
| `wallet address add <name>` | Add to address book (`--evm`, `--solana`) |
| `wallet address list` | List saved addresses |
| `wallet address remove <name>` | Remove from address book |

## Supported Swap Pairs

| Pair | Chain | Provider |
|------|-------|----------|
| USDC <-> ETH | Ethereum | CoW Swap / Uniswap / LI.FI |
| USDC <-> WSOL-ETH | Ethereum | CoW Swap / Uniswap / LI.FI |
| ETH <-> WSOL-ETH | Ethereum | CoW Swap / Uniswap / LI.FI |
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

## Global Flags

| Flag | Description | Default |
|------|-------------|---------|
| `-n, --network` | `mainnet` or `testnet` | `mainnet` |
| `--dry-run` | Simulate without executing | `true` on mainnet |
| `--run` | Execute for real (required on mainnet) | — |
| `--route <id>` | Override swap/bridge provider (`cow`, `uniswap`, `lifi`, `debridge`) | `auto` |

## Security

- **Audit gate** — mainnet write commands are blocked unless a passing `wallet audit` has been run within the last 7 days. The audit verifies all integrated services, price sanity, pool health, stETH/ETH ratio, and USDC peg stability.
- **Network egress guard** — all outbound connections are restricted to a whitelist of known hosts (RPCs, CoW, deBridge, Jupiter, Uniswap, LI.FI, CoinGecko, DeFi Llama). Even if an npm dependency is compromised, it cannot phone home with your keys.
- **`child_process` disabled** — prevents subprocess-based exfiltration (`curl`, `wget`, etc.)
- **UDP sockets blocked** — prevents DNS-tunneling exfiltration
- **Install scripts disabled** (`.npmrc: ignore-scripts=true`) — prevents `postinstall` attacks
- Private keys stay in `.env` on your machine — never sent anywhere
- All transactions require explicit `[y/N]` confirmation before signing
- ERC-20 approvals are always exact amounts (never infinite)
- Mainnet operations show a warning banner
- Bridge validates contract addresses against known deBridge DLN contracts
- Balances are checked before attempting transactions
- `.env` is in `.gitignore` — never committed

## How It Works

| Action | Protocol | Mechanism |
|--------|----------|-----------|
| **Balance** | Multi-chain | Balances + staking dashboard (rates, APR/APY, USD, earned, yields) |
| **Value** | CoinGecko + DeFi Llama | USD pricing for any managed asset; staked assets resolve through base token |
| **Swap (EVM)** | Multi-provider | CoW (gasless intent), Uniswap (AMM/UniswapX), LI.FI (aggregator) |
| **Swap (Solana)** | Jupiter | USDC <-> SOL via Jupiter aggregator with dynamic slippage |
| **Buy** | Multi-provider / Jupiter | Buy order (ETH, WSOL-ETH) or Jupiter ExactOut (SOL) |
| **Bridge** | Multi-provider | deBridge (cross-chain DLN) or LI.FI (aggregator) |
| **Stake ETH** | Lido | ETH -> stETH, auto-rebasing liquid staking (~3% APR) |
| **Stake SOL** | Jito | SOL -> JitoSOL, liquid staking + MEV rewards (~7% APR) |
| **Unstake ETH** | Lido | stETH -> request withdrawal (1-5 day queue) -> claim ETH |
| **Unstake SOL** | Jito | JitoSOL -> SOL, instant via SPL stake pool |
| **Send** | Direct transfer | ETH/ERC-20 or SOL/SPL transfer to any address |
| **Wrap/Unwrap** | WETH / WSOL | Native assets (ETH/SOL) to ERC-20/SPL equivalents and back |
| **Zap** | Multi-platform | USDC -> stETH (swap+Lido) or USDC -> JitoSOL (bridge+Jito) |
| **Quote** | Multi-platform | 6 paths with yield projections across all providers |
| **Audit** | Multi-platform | Prices, quotes, pool health, stETH ratio, USDC peg, API connectivity |

## Provider Architecture

Swap and bridge protocols are pluggable providers behind a common interface. By default (`auto`), commands fetch quotes from **all** available providers, show a comparison table, and let you select. Use `wallet config set swap <id>` or `--route <id>` to pin a specific provider.

| Type | Provider | Notes |
|------|----------|-------|
| **Swap** | [CoW Swap](https://cow.fi) | Gasless, MEV-protected, EIP-712 intents |
| **Swap** | [Uniswap](https://uniswap.org) | Classic (on-chain AMM) + UniswapX (gasless Dutch auction). Requires `UNISWAP_API_KEY` |
| **Swap** | [LI.FI/Jumper](https://li.fi) | DEX aggregator, sell-only (no ExactOutput) |
| **Swap** | [Jupiter](https://jup.ag) | Solana DEX aggregator, USDC <-> SOL with dynamic slippage |
| **Bridge** | [deBridge](https://debridge.finance) | Cross-chain ETH/USDC/SOL both ways |
| **Bridge** | [LI.FI/Jumper](https://li.fi) | Cross-chain bridge aggregator |

Provider resolution order: `--route` flag > `wallet config` setting > `auto` (all providers).

## Price Sources

USD prices use CoinGecko as the primary source with automatic DeFi Llama fallback. If CoinGecko returns a 429 (rate limited), prices transparently fall through to DeFi Llama with no user intervention. This applies to: `balance`, `value`, `quote`, `zap`, and `health` commands.
