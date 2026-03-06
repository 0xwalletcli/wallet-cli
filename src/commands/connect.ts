export async function connectCommand(chain?: string, opts?: { browser?: boolean }): Promise<void> {
  if (chain === 'solana' || chain === 'sol') {
    // Check if already connected via browser
    const { loadBrowserSession, connectViaBrowser } = await import('../signers/browser.js');
    const existing = loadBrowserSession();
    if (existing) {
      console.log(`\n  Solana already connected via ${existing.walletName} (browser).`);
      console.log(`  Solana: ${existing.publicKey}`);
      console.log('  Run "wallet disconnect solana" first to reconnect.\n');
      return;
    }

    const session = await connectViaBrowser();
    console.log(`\n  Connected to ${session.walletName}!`);
    console.log(`  Solana: ${session.publicKey}\n`);
    console.log('  Set as signer: wallet config set signer solana browser\n');
    return;
  }

  // EVM via browser extension
  if (opts?.browser) {
    const { loadEvmBrowserSession, connectEvmViaBrowser } = await import('../signers/browser.js');
    const existing = loadEvmBrowserSession();
    if (existing) {
      console.log(`\n  EVM already connected via ${existing.walletName} (browser).`);
      console.log(`  EVM: ${existing.address}`);
      console.log('  Run "wallet disconnect evm" first to reconnect.\n');
      return;
    }

    const session = await connectEvmViaBrowser();
    console.log(`\n  Connected to ${session.walletName}!`);
    console.log(`  EVM: ${session.address}\n`);
    console.log('  Set as signer: wallet config set signer evm browser\n');
    return;
  }

  // EVM (or unspecified) — use WalletConnect
  const { connectWallet } = await import('../signers/walletconnect.js');
  await connectWallet(chain);
}

export async function disconnectCommand(target?: string): Promise<void> {
  const isEvmTarget = target && ['evm', 'ethereum', 'eth'].includes(target.toLowerCase());
  const isSolTarget = target && ['solana', 'sol'].includes(target.toLowerCase());

  // Handle browser sessions (Solana)
  if (!target || isSolTarget) {
    const { loadBrowserSession, deleteBrowserSession } = await import('../signers/browser.js');
    const session = loadBrowserSession();
    if (session) {
      deleteBrowserSession();
      console.log(`  Disconnected ${session.walletName} (Solana browser session).`);
    }
    if (isSolTarget) {
      console.log('');
      const { resetSigner } = await import('../signers/index.js');
      resetSigner();
      return;
    }
  }

  // Handle browser sessions (EVM)
  if (!target || isEvmTarget) {
    const { loadEvmBrowserSession, deleteEvmBrowserSession } = await import('../signers/browser.js');
    const session = loadEvmBrowserSession();
    if (session) {
      deleteEvmBrowserSession();
      console.log(`  Disconnected ${session.walletName} (EVM browser session).`);
    }
  }

  // Handle WC sessions
  const { disconnectWallet } = await import('../signers/walletconnect.js');
  await disconnectWallet(target);
}

export async function keysListCommand(): Promise<void> {
  console.log('\n  -- Signing Keys ----------------------------------------\n');

  const evmKey = process.env.EVM_PRIVATE_KEY ? 'configured' : 'not set';
  const solKey = process.env.SOLANA_PRIVATE_KEY ? 'configured' : 'not set';

  console.log(`  EVM_PRIVATE_KEY:     ${evmKey}`);
  console.log(`  SOLANA_PRIVATE_KEY:  ${solKey}`);

  console.log('\n  -- WalletConnect Sessions --------------------------------\n');

  const { listWcSessions } = await import('../signers/walletconnect.js');
  const sessions = listWcSessions();

  if (sessions.length === 0) {
    console.log('  No active WC sessions.');
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

  console.log('  -- Browser Sessions ------------------------------------\n');

  const { loadBrowserSession, loadEvmBrowserSession } = await import('../signers/browser.js');

  const evmBrowser = loadEvmBrowserSession();
  if (evmBrowser) {
    console.log(`  ${evmBrowser.walletName} (EVM browser)`);
    console.log(`    EVM: ${evmBrowser.address}`);
    console.log(`    Connected: ${new Date(evmBrowser.connectedAt).toLocaleDateString()}`);
    console.log('');
  }

  const solBrowser = loadBrowserSession();
  if (solBrowser) {
    console.log(`  ${solBrowser.walletName} (Solana browser)`);
    console.log(`    Solana: ${solBrowser.publicKey}`);
    console.log(`    Connected: ${new Date(solBrowser.connectedAt).toLocaleDateString()}`);
    console.log('');
  }

  if (!evmBrowser && !solBrowser) {
    console.log('  No active browser sessions.');
  }

  const { loadConfig, getSignerConfig } = await import('../lib/config.js');
  const sc = getSignerConfig(loadConfig());
  console.log(`\n  Active signer:  EVM: ${sc.evm}  |  Solana: ${sc.solana}`);
  console.log('  (wallet config set signer evm wc | wallet config set signer solana browser)\n');
}
