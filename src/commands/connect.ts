export async function connectCommand(chain?: string): Promise<void> {
  const { connectWallet } = await import('../signers/walletconnect.js');
  await connectWallet(chain);
}

export async function disconnectCommand(target?: string): Promise<void> {
  const { disconnectWallet } = await import('../signers/walletconnect.js');
  await disconnectWallet(target);
}

export async function keysListCommand(): Promise<void> {
  console.log('\n  ── Signing Keys ─────────────────────────\n');

  const evmKey = process.env.EVM_PRIVATE_KEY ? 'configured' : 'not set';
  const solKey = process.env.SOLANA_PRIVATE_KEY ? 'configured' : 'not set';
  const solAddr = process.env.SOLANA_ADDRESS || 'not set';

  console.log(`  EVM_PRIVATE_KEY:     ${evmKey}`);
  console.log(`  SOLANA_PRIVATE_KEY:  ${solKey}`);
  console.log(`  SOLANA_ADDRESS:      ${solAddr}`);

  console.log('\n  ── WalletConnect Sessions ────────────────\n');

  const { listWcSessions } = await import('../signers/walletconnect.js');
  const sessions = listWcSessions();

  if (sessions.length === 0) {
    console.log('  No active sessions. Run "wallet connect" to pair a wallet.');
  } else {
    for (const s of sessions) {
      const expiry = new Date(s.expiry * 1000).toLocaleDateString();
      console.log(`  ${s.peerName}`);
      if (s.evmAddress) console.log(`    EVM:    ${s.evmAddress}`);
      if (s.solAddress) console.log(`    Solana: ${s.solAddress}`);
      console.log(`    Expiry: ${expiry}`);
      console.log('');
    }
  }

  const { loadConfig } = await import('../lib/config.js');
  const config = loadConfig();
  console.log(`\n  Active signer: ${config.signer || 'env'}  (wallet config set signer <env|wc>)\n`);
}
