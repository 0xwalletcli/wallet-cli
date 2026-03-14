# Testnet Playbook

Dry run of the monthly flow on Sepolia + Solana devnet. No real money.

Testnet runs live by default (no `--run` needed). Use `--dry-run` to simulate.

## Constraints

- **deBridge**: mainnet only — no bridging on testnet
- **Jupiter**: mainnet only — no SOL swaps/buying on testnet
- **Jito staking**: mainnet only — no SOL staking on testnet
- **WSOL-ETH (Wormhole)**: mainnet only — no liquidity on Sepolia
- **Deposit (Peer)**: mainnet only — P2P deposits on Base
- **Withdraw (Spritz)**: mainnet only — off-ramp to bank
- **CoW Swap**: works on Sepolia (USDC <-> ETH)
- **Lido**: works on Sepolia (Holesky stETH)
- **SOL airdrop**: devnet only, max 2 SOL per request

---

## 0. Pre-flight

```bash
wallet health
wallet tokens -n testnet
wallet balance -n testnet
```

## 1. Mint testnet tokens

```bash
# Get Sepolia ETH (prints faucet URLs)
wallet mint eth -n testnet

# Get testnet USDC (prints Circle faucet URL)
wallet mint usdc -n testnet

# Airdrop devnet SOL (programmatic, instant)
wallet mint sol 4 -n testnet

# Verify
wallet balance -n testnet
```

## 2. Address book

```bash
wallet address add test-evm --evm 0x000000000000000000000000000000000000dEaD
wallet address list
```

## 3. Swap USDC -> ETH

```bash
wallet swap 5 usdc eth -n testnet
wallet swap 0.001 eth usdc -n testnet
wallet buy 0.001 eth -n testnet

# Use a specific provider
wallet swap 5 usdc eth -n testnet --route cow

# Check status
wallet swap history -n testnet
wallet buy history -n testnet
wallet balance -n testnet
```

## 4. Value check

```bash
wallet value 0.01 eth
wallet value 100 usdc
wallet value 0.01 steth
```

## 5. Send tokens

```bash
wallet send 0.001 eth 0x...some-address... -n testnet
wallet send 1 usdc 0x...some-address... -n testnet
wallet send 0.5 sol some-solana-address -n testnet
```

## 6. Stake ETH (Lido)

```bash
wallet stake 0.01 eth -n testnet
wallet balance -n testnet
wallet stake history -n testnet
```

## 7. Unstake ETH (Lido)

```bash
wallet unstake 0.01 steth -n testnet
wallet unstake history -n testnet
wallet balance -n testnet

# Once finalized, claim
wallet unstake claim steth -n testnet
```

## 8. Zap USDC -> stETH

```bash
wallet zap 10 usdc steth -n testnet --dry-run
wallet zap 10 usdc steth -n testnet
wallet balance -n testnet
wallet zap history -n testnet
```

## 9. Quote comparison

```bash
wallet quote 10000 -n testnet
```

## 10. Wrap / unwrap

```bash
wallet wrap 1 sol -n testnet
wallet wrap 0.01 eth -n testnet
wallet balance -n testnet
wallet unwrap wsol -n testnet
wallet unwrap weth -n testnet
```

## 11. ERC-20 approval

```bash
wallet approve usdc cow 100 -n testnet
```

## 12. Review

```bash
wallet swap history -n testnet
wallet buy history -n testnet
wallet stake history -n testnet
wallet unstake history -n testnet
wallet zap history -n testnet
wallet txs -n testnet
wallet balance -n testnet
wallet health
```

## 13. Check external wallets

```bash
wallet balance 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 -n testnet
wallet address add vitalik --evm 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
wallet balance vitalik -n testnet
```

## What you can't test on testnet

These are mainnet-only — test them with `--dry-run` on mainnet instead:

```bash
# Solana swaps (Jupiter)
wallet swap 100 usdc sol
wallet swap 1 sol usdc

# Bridge previews (dry-run, no real tx)
wallet bridge 100 usdc sol
wallet bridge 1 eth sol
wallet bridge 100 usdc usdc-sol

# Base bridge previews (dry-run)
wallet bridge 1000 usdc usdc-base
wallet bridge 0.5 eth eth-base
wallet bridge 500 usdc-base sol

# Base swaps (dry-run)
wallet swap 500 usdc-base eth-base
wallet swap 0.1 eth-base usdc-base

# Buy SOL (Jupiter)
wallet buy 1 sol

# Buy WSOL-ETH (CoW)
wallet buy 1 wsol-eth

# Jito staking/unstaking
wallet stake 1 sol
wallet unstake 1 jitosol

# Zap JitoSOL (deBridge + Jito)
wallet zap 10000 usdc jitosol

# Value of staked Solana assets
wallet value 10 jitosol
wallet value 100 usdc-base
wallet value 0.5 eth-base

# Quote with all paths
wallet quote 10000

# Swap WSOL-ETH pairs (no liquidity on Sepolia)
wallet swap 100 usdc wsol-eth
```

## Notes

- Bridging (including Base), Jupiter, and Jito are mainnet only — skip on testnet
- Zap stETH works on testnet (CoW + Lido both available on Sepolia)
- Testnet tokens have no value, experiment freely
- No audit is required for testnet commands
