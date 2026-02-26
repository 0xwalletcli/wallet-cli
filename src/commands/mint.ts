import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { type Network, FAUCET_URLS, getEvmAccount, getSolanaAddress } from '../config.js';
import { getConnection, getSolBalance } from '../lib/solana.js';
import { formatToken } from '../lib/format.js';
import { validateAmount } from '../lib/prompt.js';

export async function mintCommand(first: string, network: Network, second?: string) {
  if (network !== 'testnet') {
    console.error('  Minting is testnet only. Use --network testnet');
    process.exit(1);
  }

  // Accept both "mint sol 4" and "mint 4 sol"
  let token: string;
  let amount: string | undefined;
  const tokens = ['sol', 'eth', 'usdc'];
  if (tokens.includes(first.toLowerCase())) {
    token = first.toUpperCase();
    amount = second;
  } else if (second && tokens.includes(second.toLowerCase())) {
    token = second.toUpperCase();
    amount = first;
  } else {
    console.error('  Supported: sol (airdrop), eth (faucet), usdc (faucet)');
    console.error('  Usage: wallet mint sol 4, wallet mint eth');
    process.exit(1);
  }

  if (token === 'SOL') {
    if (!amount) {
      console.error('  Usage: wallet mint sol <amount>');
      process.exit(1);
    }
    validateAmount(amount);
    await mintSol(amount, network);
  } else if (token === 'ETH') {
    mintEth();
  } else if (token === 'USDC') {
    mintUsdc();
  } else {
    console.error('  Supported: sol (airdrop), eth (faucet), usdc (faucet)');
    process.exit(1);
  }
}

async function mintSol(amount: string, network: Network) {
  const address = getSolanaAddress();
  if (!address) {
    console.error('  SOLANA_ADDRESS not set in .env');
    process.exit(1);
  }

  const amountNum = Number(amount);
  const pubkey = new PublicKey(address);
  const conn = getConnection(network);

  console.log(`\n  Airdrop: ${amount} SOL on devnet`);
  console.log(`  Wallet:  ${address}\n`);

  // Devnet limits to 2 SOL per request — loop if needed
  const maxPerRequest = 2;
  let remaining = amountNum;
  let batch = 1;

  while (remaining > 0) {
    const chunk = Math.min(remaining, maxPerRequest);
    const lamports = Math.round(chunk * LAMPORTS_PER_SOL);

    console.log(`  Requesting ${chunk} SOL (batch ${batch})...`);
    try {
      const sig = await conn.requestAirdrop(pubkey, lamports);
      await conn.confirmTransaction(sig);
      console.log(`  TX: ${sig}`);
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('429') || msg.includes('limit')) {
        console.error(`  Airdrop rate-limited. Try the web faucet instead:`);
        console.error(`  https://faucet.solana.com`);
      } else {
        console.error(`  Airdrop failed: ${msg}`);
      }
      if (remaining < amountNum) {
        console.log(`  Partial airdrop: ${amountNum - remaining} SOL received`);
      }
      break;
    }

    remaining -= chunk;
    batch++;
  }

  // Show updated balance
  const balance = await getSolBalance(network, address);
  console.log(`\n  New balance: ${formatToken(balance, 6)} SOL\n`);
}

function mintEth() {
  const account = getEvmAccount();
  console.log(`\n  Get Sepolia ETH from a faucet:\n`);
  console.log(`  Wallet: ${account.address}\n`);
  console.log(`  Google Cloud:  ${FAUCET_URLS.eth}`);
  console.log(`  Alchemy:       https://www.alchemy.com/faucets/ethereum-sepolia`);
  console.log(`  Infura:        https://www.infura.io/faucet/sepolia\n`);
  console.log(`  Paste your wallet address and request testnet ETH.\n`);
}

function mintUsdc() {
  const account = getEvmAccount();
  console.log(`\n  Get testnet USDC from Circle's faucet:\n`);
  console.log(`  Wallet: ${account.address}\n`);
  console.log(`  Circle Faucet: ${FAUCET_URLS.usdc}\n`);
  console.log(`  Select "Ethereum Sepolia" and paste your wallet address.\n`);
}
