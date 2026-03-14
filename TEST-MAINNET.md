# Mainnet E2E Test

Verify every wallet-cli workflow on mainnet. Run in order — each step builds on the previous.

**Starting balances:**
- ETH: 0.002 (~$5 gas)
- USDC: 100.00
- SOL: 0.00 (no Solana gas yet)

---

## Phase 1: Read commands (free, no gas)

```bash
# 1.1 — Audit gate (required before any mainnet write)
wallet audit

# 1.2 — Service health
wallet health

# 1.3 — Token reference
wallet tokens

# 1.4 — Balance (own wallet)
wallet balance

# 1.5 — Balance (external address — Vitalik)
wallet balance 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045

# 1.6 — Quote comparison (informational)
wallet quote 100

# 1.7 — Transaction history
wallet txs
```

---

## Phase 2: Local commands (free, no blockchain)

```bash
# 2.1 — Config: show defaults
wallet config

# 2.2 — Config: set + verify + reset
wallet config set swap cow
wallet config
wallet config reset
wallet config

# 2.3 — Address book: add + list + remove
wallet address add test-addr --evm 0x0000000000000000000000000000000000000001
wallet address list
wallet address remove test-addr
wallet address list
```

---

## Phase 2.5: Migrate from .env to wallet signing

Switch signing from raw private keys in `.env` to wallet extensions.
This is a one-time setup — all subsequent phases use wallet signing.

```bash
# 2.5.1 — Connect EVM wallet
#          Option A: WalletConnect (scan QR with MetaMask mobile)
wallet connect evm
#          Option B: Browser extension (MetaMask, Coinbase Wallet, Phantom)
wallet connect evm browser

# 2.5.2 — Connect Solana wallet (browser extension: Phantom, Solflare, Backpack)
wallet connect solana

# 2.5.3 — Verify sessions are active
wallet keys

# 2.5.4 — Switch signers per chain
wallet config set signer evm wc          # or: browser
wallet config set signer solana browser

# 2.5.5 — Verify signer is set
wallet config

# 2.5.6 — Verify balances still resolve (read path uses signer addresses)
wallet balance
```

**After step 2.5:** All write commands (swap, send, bridge, stake, etc.) will prompt
your wallet for approval instead of auto-signing with `.env` keys. EVM supports
`env`, `wc` (WalletConnect), and `browser`. Solana supports `env` and `browser`.
Set each chain independently, or switch both back with `wallet config set signer env`.

**Cleanup (optional):** Once you've verified wallet signing works through Phase 3,
you can remove `EVM_PRIVATE_KEY` and `SOLANA_PRIVATE_KEY` from your `.env` file.

---

## Phase 3: Ethereum swaps (gasless via CoW)

CoW Swap is gasless — the solver pays gas. This gets us ETH without spending our 0.002 ETH gas.

**Note:** Uniswap and LI.FI swaps output WETH (ERC-20), not native ETH. The CLI auto-unwraps
WETH → ETH after the swap fills. CoW Swap settles to native ETH automatically.

```bash
# 3.1 — Swap USDC -> ETH (dry-run first)
wallet swap 10 usdc eth

# 3.2 — Swap USDC -> ETH (execute, auto-compare providers)
#        Select CoW Swap (gasless — preserves ETH gas)
wallet swap 10 usdc eth --run

# 3.3 — Verify ETH arrived + check history
wallet balance
wallet swap history
```

**After step 3.2:** ~90 USDC, ~0.007 ETH (enough gas for the rest of the test)

```bash
# 3.4 — Buy ETH (exact amount, auto-compare)
#        Select CoW if available (gasless)
wallet buy 0.002 eth --run

# 3.5 — Swap via CoW (gasless, MEV-protected)
wallet swap 5 usdc eth --route cow --run

# 3.6 — Swap via Uniswap (on-chain AMM or UniswapX)
#        Verify auto-unwrap: should see "Unwrapping X WETH -> ETH..." after fill
wallet swap 5 usdc eth --route uniswap --run

# 3.7 — Swap via LI.FI (DEX aggregator)
#        LI.FI routes to native ETH, no auto-unwrap needed
wallet swap 5 usdc eth --route lifi --run

# 3.8 — Buy via each provider (verify auto-unwrap for uniswap)
#        Note: LI.FI does not support buy (ExactOutput) — only sell orders
wallet buy 0.002 eth --route cow --run
wallet buy 0.002 eth --route uniswap --run

# 3.9 — Verify + history (should show orders from all 3 providers)
#        Balance should show native ETH only (no WETH line = auto-unwrap worked)
wallet balance
wallet swap history
wallet buy history
```

**After step 3:** ~65 USDC, ~0.015 ETH

---

## Phase 4: Wrap / unwrap ETH (costs gas only, ~$0.50)

```bash
# 4.1 — Wrap ETH -> WETH
wallet wrap 0.001 eth --run

# 4.2 — Verify WETH balance
wallet balance

# 4.3 — Unwrap WETH -> ETH
wallet unwrap 0.001 weth --run

# 4.4 — Verify ETH is back
wallet balance
```

---

## Phase 5: Stake ETH -> stETH via Lido (costs gas only, ~$1)

```bash
# 5.1 — Stake ETH (dry-run)
wallet stake 0.002 eth

# 5.2 — Stake ETH (execute)
wallet stake 0.002 eth --run

# 5.3 — Verify stETH appeared + history
wallet balance
wallet stake history
```

---

## Phase 6: Zap USDC -> stETH (gasless swap + gas for Lido, ~$1 gas)

**Note:** Zap = swap USDC → ETH + stake ETH → stETH. For Uniswap/LI.FI, the CLI
auto-unwraps WETH → ETH between the swap and Lido stake steps.

```bash
# 6.1 — Zap (dry-run — shows swap comparison + Lido stake)
wallet zap 5 usdc steth

# 6.2 — Zap via CoW (gasless swap + Lido stake)
wallet zap 5 usdc steth --route cow --run

# 6.3 — Zap via Uniswap (on-chain swap + Lido stake)
#        Verify: should see "Unwrapping X WETH -> ETH..." between swap and stake
wallet zap 5 usdc steth --route uniswap --run

# 6.4 — Zap via LI.FI (aggregator swap + Lido stake)
wallet zap 5 usdc steth --route lifi --run

# 6.5 — Verify stETH increased + history (should show all 3 providers)
wallet balance
wallet zap history
```

**After step 6:** ~50 USDC, ~0.012 ETH, ~0.008 stETH

---

## Phase 7: Unstake stETH -> ETH (Lido withdrawal request)

Request goes into Lido's queue (1-5 days). Claim in Phase 15 after finalization.

```bash
# 7.1 — Request withdrawal (dry-run)
wallet unstake 0.001 eth

# 7.2 — Request withdrawal (execute — enters Lido queue)
wallet unstake 0.001 eth --run

# 7.3 — Verify pending withdrawal + history
wallet balance
wallet unstake history
```

---

## Phase 8: Approve (standalone, costs gas only)

Set up unlimited approvals so staking/unstaking/swaps never prompt for approval again.

```bash
# 8.1 — Approve 1 USDC to CoW vault relayer (basic, specific amount)
wallet approve usdc 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110 1 --run

# 8.2 — stETH → Lido Withdrawal Queue (needed for unstaking stETH)
wallet approve steth lido-withdrawal unlimited --run

# 8.3 — USDC → LI.FI Diamond proxy (needed for LI.FI swaps/zaps)
wallet approve usdc lifi unlimited --run

# 8.4 — USDC → CoW Protocol (needed for CoW swaps)
wallet approve usdc cow unlimited --run

# 8.5 — Verify approvals are set
wallet balance
```

---

## Phase 9: Bridge to Solana (gets us SOL for gas)

This is the critical step — we have no SOL, so we must bridge ETH or USDC to get SOL for Solana gas.

```bash
# 9.1 — Bridge USDC -> SOL (dry-run — shows provider comparison)
wallet bridge 5 usdc sol

# 9.2 — Bridge USDC -> SOL via deBridge
#        Wait ~2-5 min for bridge fulfillment
wallet bridge 3 usdc sol --route debridge --run

# 9.3 — Bridge USDC -> SOL via LI.FI
wallet bridge 3 usdc sol --route lifi --run

# 9.4 — Verify SOL arrived + history (should show both providers)
wallet balance
wallet bridge history

# 9.5 — Bridge USDC -> USDC on Solana via deBridge
wallet bridge 3 usdc usdc-sol --route debridge --run

# 9.6 — Bridge USDC -> USDC on Solana via LI.FI
wallet bridge 3 usdc usdc-sol --route lifi --run

# 9.7 — Verify USDC on Solana
wallet balance
```

**After step 9:** ~26 USDC (Ethereum), ~0.03 SOL + ~6 USDC (Solana)

---

## Phase 10: Solana — Buy SOL via Jupiter

Now that we have USDC on Solana + SOL for gas:

```bash
# 10.1 — Buy SOL with USDC on Solana (Jupiter)
wallet buy 0.02 sol --run

# 10.2 — Verify + history
wallet balance
wallet buy history
```

---

## Phase 11: Solana — Zap USDC -> JitoSOL (bridge + Jito in one step)

Zap bridges USDC from Ethereum and stakes into JitoSOL in a single command.
Two paths available: direct SOL bridge → Jito, or USDC bridge + Jupiter → Jito.

```bash
# 11.1 — Zap (dry-run — shows bridge comparison + Jito stake)
wallet zap 3 usdc jitosol

# 11.2 — Zap (execute — pick a path)
wallet zap 3 usdc jitosol --run

# 11.3 — Verify JitoSOL appeared + history
wallet balance
wallet zap history
```

---

## Phase 12: Solana — Stake SOL -> JitoSOL via Jito

```bash
# 12.1 — Stake SOL (dry-run)
wallet stake 0.02 sol

# 12.2 — Stake SOL (execute)
wallet stake 0.02 sol --run

# 12.3 — Verify JitoSOL appeared + history
wallet balance
wallet stake history
```

---

## Phase 13: Solana — Unstake JitoSOL -> SOL (instant)

```bash
# 13.1 — Unstake JitoSOL
wallet unstake 0.01 jitosol --run

# 13.2 — Verify SOL returned + history
wallet balance
wallet unstake history
```

---

## Phase 14: Solana — Wrap / unwrap SOL

```bash
# 14.1 — Wrap SOL -> WSOL
wallet wrap 0.005 sol --run

# 14.2 — Verify WSOL
wallet balance

# 14.3 — Unwrap WSOL -> SOL
wallet unwrap wsol --run

# 14.4 — Verify
wallet balance
```

---

## Phase 15: P2P on-ramp + off-ramp via Peer

Peer is a decentralized P2P protocol on Base. No KYC, non-custodial.
- **Deposit (on-ramp):** buy USDC by paying fiat to a seller
- **Withdraw (off-ramp):** sell USDC by locking it in escrow, receive fiat from buyers

Requires an EVM signer (env key, WalletConnect, or browser).

### Step 0: Configure + check platforms

```bash
# 15.0 — Configure payment handles (one-time setup)
wallet config set handle venmo @your-venmo-username
wallet config set handle zelle your-email@bank.com
wallet config                    # verify handles saved

# 15.1 — Check supported platforms
wallet withdraw platforms
wallet deposit platforms
```

### Step 1: Deposit — buy USDC with fiat (on-ramp)

```bash
# 15.2 — Check available USDC to buy
wallet deposit liquidity 100

# 15.3 — Buy USDC via Venmo (dry-run — preview sellers)
wallet deposit 100 --from venmo

# 15.4 — Buy USDC via Venmo (execute — signal intent, then pay seller)
wallet deposit 100 --from venmo --run

# 15.5 — Buy USDC from any platform (shows all sellers, you pick)
wallet deposit 100 --run

# 15.6 — Verify USDC arrived
wallet balance
```

### Step 2: Get USDC onto Base (if needed for withdraw)

```bash
# 15.7 — Bridge USDC from Ethereum to Base
wallet bridge 10 usdc usdc-base --run

# 15.8 — Verify USDC arrived on Base
wallet balance
```

### Step 3: Withdraw — sell USDC for fiat (off-ramp)

```bash
# 15.9 — Check off-ramp liquidity
wallet withdraw liquidity 5

# 15.10 — Off-ramp to Venmo only (dry-run — preview)
wallet withdraw 5 --to venmo

# 15.11 — Off-ramp to Venmo (execute — lock USDC, receive fiat)
#          Handle auto-filled from config
#          Spread:        2 (2% — buyer pays $5.10 for $5 USDC)
wallet withdraw 5 --to venmo --run

# 15.12 — Off-ramp with all platforms (interactive — select which)
wallet withdraw 5 --run

# 15.13 — List active positions
wallet withdraw list
```

### Step 4: Manage positions

```bash
# 15.14 — Add more funds to a position
wallet withdraw add <positionId> 3 --run

# 15.15 — Remove some funds
wallet withdraw remove <positionId> 2 --run

# 15.16 — Pause position (stop accepting buyers temporarily)
wallet withdraw pause <positionId> --run

# 15.17 — Resume position
wallet withdraw resume <positionId> --run
```

### Step 5: Monitor + close

```bash
# 15.18 — Check if any buyers have signaled intent / completed purchases
wallet withdraw history

# 15.19 — Close position (reclaim all remaining USDC)
wallet withdraw close <positionId> --run

# 15.20 — Verify closed
wallet withdraw list
wallet withdraw list closed
```

### How Peer works

**Deposit (on-ramp — you're the buyer):**
1. You signal intent on a seller's position (locks USDC in escrow for you)
2. You pay the seller fiat via Venmo/Zelle/CashApp/Revolut
3. zkTLS proves your payment → escrow releases USDC to your wallet

**Withdraw (off-ramp — you're the seller/LP):**
1. You lock USDC into Peer escrow on Base
2. Buyers find your position on peer.xyz and signal intent
3. Buyer pays you fiat, proves payment with zkTLS → escrow releases USDC to buyer
4. You receive fiat in your Venmo/Zelle account + your spread as profit

Monitor activity with `wallet withdraw history`.

---

## Phase 15b: Withdraw USDC to bank (Spritz off-ramp)

Requires `SPRITZ_API_KEY` in `.env` and a linked bank account on Spritz.

```bash
# 15b.1 — List linked bank accounts
wallet withdraw accounts

# 15b.2 — Withdraw (dry-run)
wallet withdraw 1

# 15b.3 — Withdraw (execute — sends USDC to Spritz, ACH to bank ~1 business day)
wallet withdraw 1 --run

# 15b.4 — Verify + history
wallet balance
wallet withdraw history
```

---

## Phase 16: Send

```bash
# 16.1 — Send ETH to yourself (your own EVM address)
wallet send 0.0001 eth 0xDd104d5b8a582Db5a229d8749e7991a30823e31B --run

# 16.2 — Send SOL to yourself (your own Solana address)
wallet send 0.001 sol 6MACtaCgvUM6uefGbP2HVp8u2CRgmWcb4hTWpdQTN93D --run

# 16.3 — Verify both chains
wallet balance
```

---

## Phase 17: Final review

```bash
# All histories — verify every operation is recorded
wallet swap history
wallet buy history
wallet bridge history
wallet stake history
wallet unstake history
wallet zap history
wallet withdraw list
wallet withdraw history
wallet txs --limit 20

# Final balances
wallet balance

# System check
wallet health
```

---

## Phase 18: Claim stETH withdrawal (run 1-5 days after Phase 7)

```bash
# 17.1 — Check if withdrawal is finalized
wallet unstake history

# 17.2 — Claim ETH (only works after Lido finalizes)
wallet unstake claim eth --run

# 17.3 — Verify ETH returned
wallet balance
```

---

## Deferred tests (need more funds or time)

| Test | Why deferred | How to test later |
|------|-------------|-------------------|
| Bridge SOL -> ETH | Reverse direction | `wallet bridge 0.01 sol eth --run` |
| Swap WSOL-ETH | Need to buy WSOL-ETH first | `wallet buy 0.5 wsol-eth --run` then `wallet swap 0.5 wsol-eth eth --run` |
| Send USDC (ERC-20 transfer) | Same as send ETH, just ERC-20 | `wallet send 1 usdc <address> --run` |
| Off-ramp with all 4 platforms | Need handles for all | `wallet withdraw 10 --run` or `--to cashapp`, `--to revolut` |
| On-ramp with all 4 platforms | Need sellers on all | `wallet deposit 100 --from cashapp --run`, `--from revolut` |
| Position buyer intent | Need a buyer on peer.xyz | Wait for buyer activity, check `wallet withdraw history` |

---

## Checklist

| # | Test | Cost | Status |
|---|------|------|--------|
| **Phase 1 — Read commands** | | | |
| 1.1 | Audit | free | [ ] |
| 1.2 | Health | free | [ ] |
| 1.3 | Tokens | free | [ ] |
| 1.4 | Balance (own) | free | [ ] |
| 1.5 | Balance (external) | free | [ ] |
| 1.6 | Quote | free | [ ] |
| 1.7 | Txs | free | [ ] |
| **Phase 2 — Local** | | | |
| 2.1-2.2 | Config (set, reset) | free | [ ] |
| 2.3 | Address book (add, list, remove) | free | [ ] |
| **Phase 2.5 — Migrate signer** | | | |
| 2.5.1 | Connect EVM (WC or `evm browser`) | free | [ ] |
| 2.5.2 | Connect Solana (browser) | free | [ ] |
| 2.5.3 | Verify sessions (keys) | free | [ ] |
| 2.5.4 | Set signer per chain (evm wc/browser, solana browser) | free | [ ] |
| 2.5.5-6 | Verify config + balance | free | [ ] |
| **Phase 3 — Swaps** | | | |
| 3.1 | Swap dry-run | free | [ ] |
| 3.2 | Swap USDC -> ETH (auto) | ~$10 | [ ] |
| 3.3 | Swap history | free | [ ] |
| 3.4 | Buy ETH (auto) | ~$5 | [ ] |
| 3.5 | Swap --route cow | ~$5 | [ ] |
| 3.6 | Swap --route uniswap | ~$5 | [ ] |
| 3.7 | Swap --route lifi | ~$5 | [ ] |
| 3.8 | Buy --route cow/uniswap | ~$10 | [ ] |
| 3.9 | Swap + buy history | free | [ ] |
| **Phase 4 — Wrap/unwrap ETH** | | | |
| 4.1-4.4 | Wrap + unwrap ETH/WETH | gas | [ ] |
| **Phase 5 — Stake ETH** | | | |
| 5.1-5.3 | Stake ETH -> stETH (Lido) | ~$4 + gas | [ ] |
| **Phase 6 — Zap stETH** | | | |
| 6.1 | Zap dry-run | free | [ ] |
| 6.2 | Zap --route cow | ~$5 + gas | [ ] |
| 6.3 | Zap --route uniswap | ~$5 + gas | [ ] |
| 6.4 | Zap --route lifi | ~$5 + gas | [ ] |
| 6.5 | Zap history | free | [ ] |
| **Phase 7 — Unstake stETH** | | | |
| 7.1-7.3 | Request Lido withdrawal | gas | [ ] |
| **Phase 8 — Approve** | | | |
| 8.1 | Approve USDC (specific amount) | gas | [ ] |
| 8.2 | Approve stETH → Lido withdrawal (unlimited) | gas | [ ] |
| 8.3 | Approve USDC → LI.FI (unlimited) | gas | [ ] |
| 8.4 | Approve USDC → CoW (unlimited) | gas | [ ] |
| **Phase 9 — Bridge** | | | |
| 9.1 | Bridge dry-run | free | [ ] |
| 9.2 | Bridge USDC -> SOL --route debridge | ~$3 | [ ] |
| 9.3 | Bridge USDC -> SOL --route lifi | ~$3 | [ ] |
| 9.4 | Bridge history | free | [ ] |
| 9.5 | Bridge USDC -> USDC-SOL --route debridge | ~$3 | [ ] |
| 9.6 | Bridge USDC -> USDC-SOL --route lifi | ~$3 | [ ] |
| 9.7 | Verify USDC on Solana | free | [ ] |
| **Phase 10 — Buy SOL** | | | |
| 10.1-10.2 | Buy SOL via Jupiter | ~$3 | [ ] |
| **Phase 11 — Zap JitoSOL** | | | |
| 11.1 | Zap dry-run | free | [ ] |
| 11.2 | Zap USDC -> JitoSOL | ~$3 + gas | [ ] |
| 11.3 | Zap history | free | [ ] |
| **Phase 12 — Stake SOL** | | | |
| 12.1-12.3 | Stake SOL -> JitoSOL | ~$3 | [ ] |
| **Phase 13 — Unstake SOL** | | | |
| 13.1-13.2 | Unstake JitoSOL -> SOL | gas | [ ] |
| **Phase 14 — Wrap/unwrap SOL** | | | |
| 14.1-14.4 | Wrap + unwrap SOL/WSOL | gas | [ ] |
| **Phase 15 — Peer P2P (on-ramp + off-ramp)** | | | |
| 15.0 | Configure handles (venmo, zelle) | free | [ ] |
| 15.1 | Discover platforms | free | [ ] |
| 15.2 | Deposit liquidity check | free | [ ] |
| 15.3 | Deposit dry-run (--from venmo) | free | [ ] |
| 15.4 | Deposit 100 USDC --from venmo (on-ramp) | gas | [ ] |
| 15.5 | Deposit 100 USDC (all platforms) | gas | [ ] |
| 15.6 | Verify balance | free | [ ] |
| 15.7 | Bridge USDC to Base | ~$3 | [ ] |
| 15.8 | Balance check (Base USDC) | free | [ ] |
| 15.9 | Withdraw liquidity check | free | [ ] |
| 15.10 | Withdraw dry-run (--to venmo) | free | [ ] |
| 15.11 | Withdraw 5 USDC --to venmo (off-ramp) | gas | [ ] |
| 15.12 | Withdraw 5 USDC (all platforms) | gas | [ ] |
| 15.13 | List active positions | free | [ ] |
| 15.14 | Add funds to position | gas | [ ] |
| 15.15 | Remove funds from position | gas | [ ] |
| 15.16 | Pause position | gas | [ ] |
| 15.17 | Resume position | gas | [ ] |
| 15.18 | Withdraw history (buyer activity) | free | [ ] |
| 15.19 | Close position | gas | [ ] |
| 15.20 | Verify closed (list + list closed) | free | [ ] |
| **Phase 15b — Withdraw (Spritz)** | | | |
| 15b.1 | Withdraw accounts | free | [ ] |
| 15b.2 | Withdraw dry-run | free | [ ] |
| 15b.3 | Withdraw USDC to bank | ~$1 | [ ] |
| 15b.4 | Withdraw history | free | [ ] |
| **Phase 16 — Send** | | | |
| 16.1 | Send ETH | gas | [ ] |
| 16.2 | Send SOL | gas | [ ] |
| **Phase 17 — Final review** | | | |
| 17 | All histories + final balance | free | [ ] |
| **Phase 18 — Claim stETH (1-5 days later)** | | | |
| 18.1-18.3 | Claim Lido withdrawal | gas | [ ] |
