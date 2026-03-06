# Mainnet Playbook

Monthly flow: USDC arrives on Ethereum. Deploy into staked assets (stETH + JitoSOL). Bridge to Base for low-fee operations.

Mainnet defaults to dry-run (safe). Every write command needs `--run` to execute.

---

## 0. Pre-flight

```bash
# Run the full audit — checks all prices, pools, APIs, contracts
# Required every 7 days; mainnet writes are blocked without it
wallet audit

# Quick health check — RPCs, APIs, staking rates, prices
wallet health

# Confirm USDC arrived
wallet balance
```

## 1. Deploy — Option A: Zap (2 commands)

Zap does swap+stake in one step. Fastest way to deploy.

```bash
# Dry-run first (default on mainnet — shows preview, no execution)
wallet zap <steth_amount> usdc steth
wallet zap <jitosol_amount> usdc jitosol

# Execute
wallet zap <steth_amount> usdc steth --run        # USDC -> ETH -> stETH via Lido
wallet zap <jitosol_amount> usdc jitosol --run     # USDC -> SOL -> JitoSOL via Jito
```

Compare paths before committing:

```bash
# Shows all 6 DeFi paths side by side with fees and yield projections
wallet quote <total_usdc>
```

## 1. Deploy — Option B: Individual (swap -> balance -> stake)

More control. Check values between steps.

### ETH side (USDC -> stETH)

```bash
# How much ETH can you get?
wallet value <steth_amount> usdc eth

# Swap USDC -> ETH (compares CoW/Uniswap/LI.FI, you select)
wallet swap <steth_amount> usdc eth --run

# Check what you got
wallet balance

# Stake all ETH -> stETH via Lido
wallet stake <eth_amount> eth --run       # e.g., wallet stake 4.2 eth --run
```

### SOL side (USDC -> JitoSOL)

```bash
# How much SOL can you get?
wallet value <jitosol_amount> usdc sol

# Swap USDC -> SOL on Solana (Jupiter)
wallet swap <jitosol_amount> usdc sol --run

# Check what you got
wallet balance

# Stake all SOL -> JitoSOL via Jito
wallet stake <sol_amount> sol --run       # e.g., wallet stake 50 sol --run
```

## 1. Deploy — Option C: Buy ETH, rest to SOL

Buy 5 ETH first, then convert remaining USDC to SOL and stake both.

```bash
# Check how much 5 ETH costs
wallet value 5 eth usdc

# Buy exactly 5 ETH with USDC
wallet buy 5 eth --run

# Stake ETH -> stETH via Lido
wallet stake 5 eth --run

# Check remaining USDC
wallet balance

# Swap remaining USDC -> SOL on Solana (Jupiter)
wallet swap <remaining_usdc> usdc sol --run    # e.g., wallet swap 5200 usdc sol --run

# Check what you got
wallet balance

# Stake all SOL -> JitoSOL via Jito
wallet stake <sol_amount> sol --run            # e.g., wallet stake 37 sol --run
```

## 2. Verify

```bash
# Full balance dashboard — staking rates, APR/APY, earned, projected yield
wallet balance full

# Recent transactions
wallet txs

# Staking history
wallet stake history
wallet zap history
```

---

## Exit flow: withdraw to bank or send to Coinbase

When you want to cash out:

### Option A: Withdraw USDC directly to bank (off-ramp)

No CEX needed — USDC goes straight to your linked bank account via configured off-ramp provider.

```bash
# List linked bank accounts
wallet withdraw accounts

# Withdraw USDC to bank (dry-run first)
wallet withdraw 5000
wallet withdraw 5000 --run

# Check status
wallet withdraw history
```

### Option B: Unstake + send to Coinbase

### Unstake ETH (Lido, 1-5 day queue)

```bash
# Request withdrawal
wallet unstake 2 steth --run

# Check pending withdrawals
wallet unstake history
wallet balance full            # "Pending withdrawals" section shows status

# Once finalized, claim the ETH
wallet unstake claim steth --run
```

### Unstake SOL (Jito, instant)

```bash
wallet unstake 20 jitosol --run
```

### Bridge SOL back to Ethereum (if needed)

```bash
wallet bridge 20 sol eth --run
wallet bridge history
```

### Move funds to Base (low gas fees)

```bash
# Bridge USDC or ETH from Ethereum to Base
wallet bridge 1000 usdc usdc-base --run
wallet bridge 0.5 eth eth-base --run

# Swap on Base (much cheaper gas)
wallet swap 500 usdc-base eth-base --run
wallet swap 0.1 eth-base usdc-base --run

# Bridge back when needed
wallet bridge 500 usdc-base usdc --run

# Send on Base
wallet send 100 usdc-base coinbase-eth --run
wallet send 0.1 eth-base coinbase-eth --run
```

### Send to Coinbase

```bash
# Set up address book (one-time)
wallet address add coinbase-eth --evm 0x...
wallet address add coinbase-sol --solana ...

# Send
wallet send 2 eth coinbase-eth --run
wallet send 5000 usdc coinbase-eth --run
wallet send 20 sol coinbase-sol --run

# Final balance check
wallet balance
```

---

## Deployment split

| Action | Protocol |
|--------|----------|
| USDC -> stETH | CoW/Uniswap/LI.FI + Lido (~3% APR) |
| USDC -> JitoSOL | deBridge/LI.FI/Jupiter + Jito (~7% APR) |
| ETH/USDC -> Base | deBridge/LI.FI bridge (low-fee operations) |
| Base swaps | LI.FI (ETH-BASE <-> USDC-BASE) |
| USDC -> Bank (off-ramp) | Multi-provider: Spritz (ACH), Peer/ZKP2P (P2P, coming soon) |

## Tips

- Always run `wallet audit` before your monthly session — it gates mainnet writes
- Run `wallet quote <amount>` to compare all staking paths + yield projections before committing
- Mainnet dry-runs are free (no gas) — preview everything before `--run`
- If a command gets stuck, Ctrl+C prints the pending tx hash + explorer link
- Lido unstaking takes 1-5 days (queue). Jito unstaking is instant.
- CoW Swap is gasless (solver pays gas), but you need ETH for bridge/stake/send
- Use `wallet config set swap cow` to pin a provider, or `--route cow` for a single command
