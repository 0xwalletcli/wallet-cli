#!/usr/bin/env node
import 'dotenv/config';       // load .env first
import './lib/netguard.js';   // lock down network egress before any deps load
import './lib/txtracker.js'; // SIGINT handler for pending transactions
import './providers/swap/cow.js';      // register CoW Swap provider
import './providers/swap/uniswap.js';  // register Uniswap provider
import './providers/swap/lifi.js';     // register LI.FI swap provider
import './providers/bridge/debridge.js'; // register deBridge provider
import './providers/bridge/lifi.js';   // register LI.FI bridge provider
import './providers/offramp/spritz.js'; // register Spritz offramp provider
import { Command } from 'commander';
import { type Network, HISTORY_LIMIT } from './config.js';
import { checkAuditGate } from './lib/auditgate.js';

function getNetwork(program: Command): Network {
  const n = program.opts().network;
  if (n !== 'mainnet' && n !== 'testnet') {
    console.error(`  Invalid network: "${n}". Must be "mainnet" or "testnet".`);
    process.exit(1);
  }
  return n;
}

const _start = performance.now();

function timed<T extends (...args: any[]) => Promise<any>>(fn: T): T {
  return (async (...args: any[]) => {
    await fn(...args);
    const elapsed = ((performance.now() - _start) / 1000).toFixed(1);
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    console.log(`  Done in ${elapsed}s  (${time})\n`);
    process.exit(0); // don't wait for HTTP keep-alive / WebSocket connections to drain
  }) as unknown as T;
}

const program = new Command();

program
  .name('wallet')
  .description('DeFi wallet CLI — swap, bridge, and manage funds without centralized exchanges')
  .version('0.1.0')
  .option('-n, --network <network>', 'mainnet or testnet', 'mainnet')
  .option('--dry-run', 'simulate without executing (default on mainnet)')
  .option('--run', 'execute for real (required on mainnet, alias: run)');

/** Resolve dry-run: defaults to true on mainnet, false on testnet. Explicit flag overrides. */
const _rawArgv = [...process.argv];
function getDryRun(program: Command): boolean {
  if (_rawArgv.includes('--dry-run') || _rawArgv.includes('dry-run')) return true;
  if (_rawArgv.includes('--run') || _rawArgv.includes('run')) return false;
  // No explicit flag — default based on network
  return getNetwork(program) === 'mainnet';
}

// wallet balance [target]
program
  .command('balance [target]')
  .description('Show balances ("full" for staking/withdrawal details, or pass an address/alias)')
  .action(timed(async (target?: string) => {
    const { balanceCommand } = await import('./commands/balance.js');
    const isFull = target === 'full';
    await balanceCommand(getNetwork(program), isFull ? undefined : target, isFull);
  }));

// wallet value <amount> <token> [target]
program
  .command('value <amount> <token> [target]')
  .description('Show USD value or convert between tokens (e.g., value 0.01 eth, value 10000 usdc eth)')
  .addHelpText('after', `
  Supported tokens:
    eth, weth, sol, wsol, wsol-eth, usdc, steth, jitosol

  Examples:
    wallet value 0.01 eth           Show USD value of 0.01 ETH
    wallet value 100 usdc           Show USD value of 100 USDC
    wallet value 1.5 steth          Show ETH + USD value of 1.5 stETH
    wallet value 10 jitosol         Show SOL + USD value of 10 JitoSOL
    wallet value 10000 usdc eth     How much ETH is 10,000 USDC?
    wallet value 7000 usdc sol      How much SOL is 7,000 USDC?
    wallet value 5 eth usdc         How much USDC is 5 ETH?
  `)
  .action(timed(async (amount: string, token: string, target?: string) => {
    const { valueCommand } = await import('./commands/value.js');
    await valueCommand(amount, token, getNetwork(program), target);
  }));

// wallet swap [args...]
program
  .command('swap [args...]')
  .description('Swap tokens via CoW Swap / Uniswap / LI.FI (e.g., swap 100 usdc eth)')
  .option('--route <id>', 'swap provider (cow, uniswap, lifi, or auto)')
  .addHelpText('after', `
  Supported pairs:
    usdc -> eth        Sell USDC for ETH (Ethereum)
    eth -> usdc        Sell ETH for USDC (Ethereum)
    usdc -> wsol-eth   Sell USDC for WSOL-ETH (Ethereum)
    wsol-eth -> usdc   Sell WSOL-ETH for USDC (Ethereum)
    eth -> wsol-eth    Sell ETH for WSOL-ETH (Ethereum)
    wsol-eth -> eth    Sell WSOL-ETH for ETH (Ethereum)
    usdc -> sol        Sell USDC for SOL (Solana, Jupiter)
    sol -> usdc        Sell SOL for USDC (Solana, Jupiter)

  Providers: CoW Swap, Uniswap, LI.FI (Ethereum) / Jupiter (Solana)
  Default: auto (compare all, select)
  Override: --route cow

  Subcommands:
    swap history              Recent swap orders
    swap status <orderId>     Check specific order
`)
  .action(timed(async (args: string[], cmdOpts: { route?: string }) => {
    if (args[0] === 'history') {
      const { swapHistoryCommand } = await import('./commands/swap.js');
      await swapHistoryCommand(getNetwork(program));
    } else if (args[0] === 'status') {
      if (!args[1]) { console.error('  Usage: wallet swap status <orderId>'); process.exit(1); }
      const { swapStatusCommand } = await import('./commands/swap.js');
      await swapStatusCommand(args[1], getNetwork(program));
    } else if (args.length === 3) {
      checkAuditGate(getNetwork(program), getDryRun(program));
      const { swapCommand } = await import('./commands/swap.js');
      await swapCommand(args[0], args[1], args[2], getNetwork(program), getDryRun(program), cmdOpts.route);
    } else {
      console.error('  Usage: wallet swap <amount> <from> <to>');
      console.error('         wallet swap history');
      console.error('         wallet swap status <orderId>');
      console.error('         wallet swap --help');
      process.exit(1);
    }
  }));

// wallet bridge [args...]
program
  .command('bridge [args...]')
  .description('Bridge via deBridge / LI.FI (e.g., bridge 1000 usdc sol)')
  .option('--to <address>', 'recipient address or address book name')
  .option('--route <id>', 'bridge provider (debridge, lifi, or auto)')
  .addHelpText('after', `
  Supported bridges:
    eth -> sol         Ethereum ETH to Solana SOL
    usdc -> sol        Ethereum USDC to Solana SOL
    usdc -> usdc-sol   Ethereum USDC to Solana USDC
    sol -> eth         Solana SOL to Ethereum ETH
    sol -> usdc        Solana SOL to Ethereum USDC
    usdc-sol -> usdc   Solana USDC to Ethereum USDC
    usdc-sol -> eth    Solana USDC to Ethereum ETH

  Providers: deBridge, LI.FI
  Default: auto (compare all, select)
  Override: --route debridge

  Subcommands:
    bridge history              Recent bridge orders
    bridge status <orderId>     Check specific order
`)
  .action(timed(async (args: string[], cmdOpts: { to?: string; route?: string }) => {
    if (args[0] === 'history') {
      const { bridgeHistoryCommand } = await import('./commands/bridge.js');
      await bridgeHistoryCommand(getNetwork(program));
    } else if (args[0] === 'status') {
      if (!args[1]) { console.error('  Usage: wallet bridge status <orderId>'); process.exit(1); }
      const { bridgeStatusCommand } = await import('./commands/bridge.js');
      await bridgeStatusCommand(args[1], getNetwork(program));
    } else if (args.length === 3) {
      checkAuditGate(getNetwork(program), getDryRun(program));
      const { bridgeCommand } = await import('./commands/bridge.js');
      await bridgeCommand(args[0], args[1], args[2], getNetwork(program), getDryRun(program), cmdOpts.to, cmdOpts.route);
    } else {
      console.error('  Usage: wallet bridge <amount> <from> <to>');
      console.error('         wallet bridge history');
      console.error('         wallet bridge status <orderId>');
      console.error('         wallet bridge --help');
      process.exit(1);
    }
  }));

// wallet buy [args...]
program
  .command('buy [args...]')
  .description('Buy tokens with USDC (e.g., buy 1 eth, buy 10 sol)')
  .option('--route <id>', 'swap provider (cow, uniswap, lifi, or auto)')
  .addHelpText('after', `
  Supported:
    eth        Buy ETH with USDC (Ethereum)
    sol        Buy SOL with USDC via Jupiter (Solana)
    wsol-eth   Buy WSOL-ETH with USDC (Wormhole SOL on Ethereum)

  Providers: CoW Swap, Uniswap, LI.FI (sell-only)
  Default: auto (compare all, select)
  Override: --route cow

  Subcommands:
    buy history    Recent buy orders
`)
  .action(timed(async (args: string[], cmdOpts: { route?: string }) => {
    if (args[0] === 'history') {
      const { buyHistoryCommand } = await import('./commands/buy.js');
      await buyHistoryCommand(getNetwork(program));
    } else if (args.length === 2) {
      checkAuditGate(getNetwork(program), getDryRun(program));
      const { buyCommand } = await import('./commands/buy.js');
      await buyCommand(args[0], args[1], getNetwork(program), getDryRun(program), cmdOpts.route);
    } else {
      console.error('  Usage: wallet buy <amount> <token>');
      console.error('         wallet buy history');
      console.error('         wallet buy --help');
      process.exit(1);
    }
  }));

// wallet send <amount> <token> <recipient>
program
  .command('send <amount> <token> <recipient>')
  .description('Send tokens to a wallet (e.g., send 0.5 eth coinbase-eth)')
  .action(timed(async (amount: string, token: string, recipient: string) => {
    checkAuditGate(getNetwork(program), getDryRun(program));
    const { sendCommand } = await import('./commands/send.js');
    await sendCommand(amount, token, recipient, getNetwork(program), getDryRun(program));
  }));

// wallet stake [args...]
program
  .command('stake [args...]')
  .description('Liquid stake ETH (Lido) or SOL (Jito)')
  .addHelpText('after', `
  Usage:
    stake <amount> eth      Stake ETH -> stETH via Lido (~3% APR)
    stake <amount> sol      Stake SOL -> JitoSOL via Jito (~7% APR)

  Subcommands:
    stake history           Recent staking transactions

  Examples:
    wallet stake 0.1 eth
    wallet stake 1 sol
`)
  .action(timed(async (args: string[]) => {
    if (args[0] === 'history') {
      const { stakeHistoryCommand } = await import('./commands/stake.js');
      await stakeHistoryCommand(getNetwork(program));
    } else if (args.length === 2) {
      checkAuditGate(getNetwork(program), getDryRun(program));
      const { stakeCommand } = await import('./commands/stake.js');
      await stakeCommand(args[0], args[1], getNetwork(program), getDryRun(program));
    } else {
      console.error('  Usage: wallet stake <amount> eth');
      console.error('         wallet stake <amount> sol');
      console.error('         wallet stake history');
      process.exit(1);
    }
  }));

// wallet mint <first> [second]  — accepts "mint sol 4" or "mint 4 sol" or "mint eth"
program
  .command('mint <first> [second]')
  .description('Get testnet tokens (e.g., mint eth, mint 4 sol) — testnet only')
  .action(timed(async (first: string, second?: string) => {
    const { mintCommand } = await import('./commands/mint.js');
    await mintCommand(first, getNetwork(program), second);
  }));

// wallet zap [args...]
program
  .command('zap [args...]')
  .description('Zap USDC into staked assets in one step (e.g., zap 100 usdc steth)')
  .option('--path <n>', 'select path for JitoSOL (1 or 2)')
  .option('--route <id>', 'swap/bridge provider (or auto)')
  .addHelpText('after', `
  Supported assets:
    steth      USDC -> ETH (swap) -> stETH (Lido, ~3% APR)
    jitosol    USDC -> SOL (bridge) -> JitoSOL (Jito, ~7% APR)

  JitoSOL paths:
    Path 1: USDC -> SOL (bridge direct) -> JitoSOL
    Path 2: USDC -> USDC-SOL (bridge) -> SOL (Jupiter) -> JitoSOL

  Providers: auto (compare all), or specify --route cow / --route debridge
  Mainnet only for JitoSOL.

  Examples:
    zap 100 usdc steth --run
    zap 5000 usdc jitosol --path 1 --run

  Subcommands:
    zap history    Recent zap operations
`)
  .action(timed(async (args: string[], cmdOpts: { path?: string; route?: string }) => {
    if (args[0] === 'history') {
      const { zapHistoryCommand } = await import('./commands/zap.js');
      await zapHistoryCommand(getNetwork(program));
    } else if (args.length === 3) {
      if (args[1].toLowerCase() !== 'usdc') {
        console.error('  Source must be "usdc". Usage: wallet zap <amount> usdc <asset>');
        process.exit(1);
      }
      checkAuditGate(getNetwork(program), getDryRun(program));
      const { zapCommand } = await import('./commands/zap.js');
      await zapCommand(args[0], args[2], getNetwork(program), getDryRun(program), cmdOpts.path, cmdOpts.route);
    } else {
      console.error('  Usage: wallet zap <amount> usdc <asset>');
      console.error('         wallet zap history');
      console.error('         wallet zap --help');
      process.exit(1);
    }
  }));

// wallet quote <amount>
program
  .command('quote <amount>')
  .description('Compare end-to-end costs of deploying USDC into staked assets')
  .action(timed(async (amount: string) => {
    const { quoteCommand } = await import('./commands/quote.js');
    await quoteCommand(amount, getNetwork(program));
  }));

// wallet health
program
  .command('health')
  .description('Check status of all third-party services, RPCs, and asset prices')
  .action(timed(async () => {
    const { healthCommand } = await import('./commands/health.js');
    await healthCommand();
  }));

// wallet unstake [args...]
program
  .command('unstake [args...]')
  .description('Unstake ETH (Lido) or SOL (Jito)')
  .addHelpText('after', `
  Usage:
    unstake <amount> steth      Unstake stETH -> ETH (Lido, 1-5 day queue)
    unstake claim steth         Claim finalized Lido withdrawals
    unstake <amount> jitosol    Unstake JitoSOL -> SOL (Jito, instant)

  Subcommands:
    unstake history             Recent unstakes + pending withdrawals

  Examples:
    wallet unstake 0.1 steth
    wallet unstake claim steth
    wallet unstake 1 jitosol
`)
  .action(timed(async (args: string[]) => {
    if (args[0] === 'history') {
      const { unstakeHistoryCommand } = await import('./commands/unstake.js');
      await unstakeHistoryCommand(getNetwork(program));
    } else if (args.length === 2) {
      checkAuditGate(getNetwork(program), getDryRun(program));
      const { unstakeCommand } = await import('./commands/unstake.js');
      await unstakeCommand(args[0], args[1], getNetwork(program), getDryRun(program));
    } else {
      console.error('  Usage: wallet unstake <amount> steth');
      console.error('         wallet unstake <amount> jitosol');
      console.error('         wallet unstake claim steth');
      console.error('         wallet unstake history');
      process.exit(1);
    }
  }));

// wallet txs
program
  .command('txs')
  .aliases(['tx', 'txn', 'txns'])
  .description('Show recent transactions for your wallets')
  .option('--limit <n>', 'transactions per chain', String(HISTORY_LIMIT))
  .action(timed(async (cmdOpts: { limit: string }) => {
    const { transactionsCommand } = await import('./commands/transactions.js');
    await transactionsCommand(getNetwork(program), parseInt(cmdOpts.limit, 10));
  }));

// wallet tokens
program
  .command('tokens')
  .description('Show supported tokens, addresses, and explorer links')
  .action(timed(async () => {
    const { tokensCommand } = await import('./commands/tokens.js');
    await tokensCommand(getNetwork(program));
  }));

// wallet wrap <amount> <token>
program
  .command('wrap <amount> <token>')
  .description('Wrap native assets (e.g., wrap 1 eth, wrap 5 sol)')
  .action(timed(async (amount: string, token: string) => {
    checkAuditGate(getNetwork(program), getDryRun(program));
    const { wrapCommand } = await import('./commands/wrap.js');
    await wrapCommand(amount, token, getNetwork(program), getDryRun(program));
  }));

// wallet unwrap [amount] <token>
program
  .command('unwrap <args...>')
  .description('Unwrap wrapped assets (e.g., unwrap weth, unwrap 0.5 weth, unwrap wsol)')
  .action(timed(async (args: string[]) => {
    checkAuditGate(getNetwork(program), getDryRun(program));
    const { unwrapCommand } = await import('./commands/wrap.js');
    let token: string, amount: string | undefined;
    if (args.length === 1) {
      token = args[0];
    } else if (args.length === 2) {
      amount = args[0];
      token = args[1];
    } else {
      console.error('  Usage: unwrap [amount] <token>  (e.g., unwrap weth, unwrap 0.5 weth)');
      process.exit(1);
    }
    await unwrapCommand(token, getNetwork(program), getDryRun(program), amount);
  }));

// wallet approve <token> <spender> <amount>
program
  .command('approve <token> <spender> <amount>')
  .description('Approve ERC-20 spending (e.g., approve usdc cow 1000)')
  .action(timed(async (token: string, spender: string, amount: string) => {
    checkAuditGate(getNetwork(program), getDryRun(program));
    const { approveCommand } = await import('./commands/approve.js');
    await approveCommand(token, spender, amount, getNetwork(program), getDryRun(program));
  }));

// wallet cancel [orderId]
program
  .command('cancel [orderId]')
  .description('Cancel a pending CoW Swap order (free, off-chain)')
  .action(timed(async (orderId?: string) => {
    const { cancelCommand } = await import('./commands/cancel.js');
    await cancelCommand(orderId, getNetwork(program));
  }));

// wallet withdraw [args...]
program
  .command('withdraw [args...]')
  .description('Withdraw USDC to bank account via off-ramp provider (e.g., withdraw 500)')
  .addHelpText('after', `
  Usage:
    withdraw <amount>          Withdraw USDC to linked bank account
    withdraw accounts          List linked accounts from provider
    withdraw history           Recent withdrawals

  Mainnet only. Configure provider: wallet config set offramp spritz
  Providers: Spritz Finance (requires SPRITZ_API_KEY in .env)
  More providers coming soon (Peer/ZKP2P, Transak, MoonPay).

  Examples:
    wallet withdraw 500
    wallet withdraw 1000 --run
    wallet withdraw accounts
    wallet withdraw history
`)
  .action(timed(async (args: string[]) => {
    if (args[0] === 'history') {
      const { withdrawHistoryCommand } = await import('./commands/withdraw.js');
      await withdrawHistoryCommand();
    } else if (args[0] === 'accounts') {
      const { withdrawAccountsCommand } = await import('./commands/withdraw.js');
      await withdrawAccountsCommand();
    } else if (args.length === 1) {
      checkAuditGate(getNetwork(program), getDryRun(program));
      const { withdrawCommand } = await import('./commands/withdraw.js');
      await withdrawCommand(args[0], getNetwork(program), getDryRun(program));
    } else {
      console.error('  Usage: wallet withdraw <amount>');
      console.error('         wallet withdraw accounts');
      console.error('         wallet withdraw history');
      console.error('         wallet withdraw --help');
      process.exit(1);
    }
  }));

// wallet audit
program
  .command('audit')
  .description('Run security audit of all integrations (required every 7 days for mainnet)')
  .action(timed(async () => {
    const { auditCommand } = await import('./commands/audit.js');
    await auditCommand(getNetwork(program));
  }));

// wallet address list
const addressCmd = program
  .command('address')
  .description('Manage address book');

addressCmd
  .command('list')
  .description('List saved addresses')
  .action(async () => {
    const { addressListCommand } = await import('./commands/address.js');
    addressListCommand();
  });

addressCmd
  .command('add <name>')
  .description('Add or update an address (e.g., address add alice --evm 0x... --solana ...)')
  .option('--evm <address>', 'EVM address')
  .option('--solana <address>', 'Solana address')
  .action(async (name: string, opts: { evm?: string; solana?: string }) => {
    const { addressAddCommand } = await import('./commands/address.js');
    addressAddCommand(name, opts);
  });

addressCmd
  .command('remove <name>')
  .description('Remove an address from the book')
  .action(async (name: string) => {
    const { addressRemoveCommand } = await import('./commands/address.js');
    addressRemoveCommand(name);
  });

// wallet config
const configCmd = program
  .command('config')
  .description('View or set CLI configuration');

configCmd
  .action(async () => {
    const { configShowCommand } = await import('./commands/config.js');
    configShowCommand();
  });

configCmd
  .command('set <key> <value> [extra]')
  .description('Set a config value')
  .addHelpText('after', `
  Keys:
    swap       auto, cow, uniswap, lifi
    bridge     auto, debridge, lifi
    signer     env, wc, browser

  Per-chain signer:
    config set signer evm wc            EVM via WalletConnect (MetaMask)
    config set signer solana browser    Solana via browser wallet (Phantom)
    config set signer solana env        Solana via .env keys

  Examples:
    config set swap cow
    config set bridge lifi
    config set signer evm wc
    config set signer solana browser
`)
  .action(async (key: string, value: string, extra?: string) => {
    const { configSetCommand } = await import('./commands/config.js');
    configSetCommand(key, value, extra);
  });

configCmd
  .command('reset')
  .description('Reset config to defaults (auto)')
  .action(async () => {
    const { configResetCommand } = await import('./commands/config.js');
    configResetCommand();
  });

// wallet connect [args...]
program
  .command('connect [args...]')
  .description('Connect a wallet (WalletConnect for EVM, browser for Solana)')
  .addHelpText('after', `
  Usage:
    wallet connect              Connect EVM via WalletConnect (mobile QR)
    wallet connect evm          Connect EVM via WalletConnect (mobile QR)
    wallet connect evm browser  Connect EVM via browser extension (MetaMask, Coinbase, Phantom)
    wallet connect solana       Connect Solana via browser extension (Phantom, Solflare, Backpack)

  EVM supports WalletConnect (mobile) and browser extension.
  Solana uses browser extension only.
`)
  .action(timed(async (args: string[]) => {
    const { connectCommand } = await import('./commands/connect.js');
    const chain = args[0];
    const method = args[1];
    await connectCommand(chain, { browser: method === 'browser' });
  }));

// wallet disconnect [wallet]
program
  .command('disconnect [wallet]')
  .description('Disconnect wallet session(s)')
  .addHelpText('after', `
  Usage:
    wallet disconnect           Disconnect all sessions (WC + browser)
    wallet disconnect evm       Disconnect EVM session(s) (WC + browser)
    wallet disconnect solana    Disconnect Solana browser session
    wallet disconnect metamask  Disconnect by wallet name (WC only)
`)
  .action(timed(async (wallet?: string) => {
    const { disconnectCommand } = await import('./commands/connect.js');
    await disconnectCommand(wallet);
  }));

// wallet keys [list]
const keysCmd = program
  .command('keys')
  .description('Show signing keys and WalletConnect sessions');

keysCmd
  .action(timed(async () => {
    const { keysListCommand } = await import('./commands/connect.js');
    await keysListCommand();
  }));

keysCmd
  .command('list')
  .description('List signing keys and WalletConnect sessions')
  .action(timed(async () => {
    const { keysListCommand } = await import('./commands/connect.js');
    await keysListCommand();
  }));

// Strip bare "run"/"dry-run" from argv so commander doesn't see them as extra positional args.
// getDryRun() reads from _rawArgv (saved before stripping). --run/--dry-run are handled by commander's .option().
const _stripped = new Set(['run', 'dry-run']);
process.argv = process.argv.filter(a => !_stripped.has(a));

program.parse();
