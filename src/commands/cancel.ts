import { type Network, COW_CONFIG } from '../config.js';
import { resolveSigner } from '../signers/index.js';
import { cancelCowOrder } from '../providers/swap/cow.js';
import { confirm } from '../lib/prompt.js';

const COW_EXPLORER: Record<Network, string> = {
  mainnet: 'https://explorer.cow.fi/orders',
  testnet: 'https://explorer.cow.fi/sepolia/orders',
};

export async function cancelCommand(orderId: string | undefined, network: Network) {
  const cow = COW_CONFIG[network];
  const signer = await resolveSigner();
  const account = await signer.getEvmAccount();

  // If no orderId, find the most recent open/signing order
  if (!orderId) {
    console.log('\n  Finding open orders...');
    const res = await fetch(`${cow.api}/api/v1/account/${account.address}/orders?limit=10`);
    if (!res.ok) {
      console.error(`  Failed to fetch orders: ${await res.text()}`);
      process.exit(1);
    }
    const orders = (await res.json()) as { uid: string; status: string; creationDate: string }[];
    const open = orders.filter(o => o.status === 'open' || o.status === 'presignaturePending');
    if (open.length === 0) {
      console.log('  No open orders to cancel.\n');
      return;
    }
    orderId = open[0].uid;
    console.log(`  Found open order: ${orderId.slice(0, 20)}...`);
  }

  console.log(`\n  Order: ${orderId}`);
  console.log(`  URL:   ${COW_EXPLORER[network]}/${orderId}\n`);

  const ok = await confirm('  Cancel this order? [y/N] ');
  if (!ok) {
    console.log('  Aborted.\n');
    return;
  }

  console.log('  Signing cancellation...');
  await cancelCowOrder(orderId, network);
  console.log('  Order cancelled.\n');
}
