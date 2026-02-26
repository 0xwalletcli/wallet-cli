import { type Network, EXPLORERS } from '../config.js';

let _lastTx: { hash: string; chain: 'evm' | 'solana'; network: Network } | null = null;

/** Record a pending tx so SIGINT can display it */
export function trackTx(hash: string, chain: 'evm' | 'solana', network: Network) {
  _lastTx = { hash, chain, network };
}

/** Clear after tx is confirmed */
export function clearTx() {
  _lastTx = null;
}

function getTxUrl(tx: { hash: string; chain: 'evm' | 'solana'; network: Network }): string {
  const explorer = EXPLORERS[tx.network];
  if (tx.chain === 'evm') {
    return `${explorer.evm}/tx/${tx.hash}`;
  }
  const cluster = tx.network === 'testnet' ? '?cluster=devnet' : '';
  return `${explorer.solana}/tx/${tx.hash}${cluster}`;
}

// Handle Ctrl+C — print pending tx before exit
process.on('SIGINT', () => {
  console.log('\n');
  if (_lastTx) {
    console.log(`  Interrupted! Pending transaction:`);
    console.log(`  TX:  ${_lastTx.hash}`);
    console.log(`  URL: ${getTxUrl(_lastTx)}`);
    console.log(`\n  The transaction may still confirm. Check the URL above.\n`);
  }
  process.exit(130);
});
