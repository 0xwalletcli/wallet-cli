import { Connection, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction, type Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, createCloseAccountInstruction, NATIVE_MINT } from '@solana/spl-token';
import { type Network, SOLANA_CONFIG, WSOL_CONFIG } from '../config.js';

let _connection: Connection | null = null;
let _currentNetwork: Network | null = null;

export function getConnection(network: Network): Connection {
  if (_connection && _currentNetwork === network) return _connection;
  _currentNetwork = network;
  _connection = new Connection(SOLANA_CONFIG[network].rpc);
  return _connection;
}

export async function getSolBalance(network: Network, address: string): Promise<number> {
  const conn = getConnection(network);
  const pubkey = new PublicKey(address);
  const lamports = await conn.getBalance(pubkey);
  return lamports / LAMPORTS_PER_SOL;
}

export async function getSplTokenBalance(network: Network, address: string, mint: string): Promise<number> {
  const conn = getConnection(network);
  const pubkey = new PublicKey(address);
  const mintPubkey = new PublicKey(mint);
  const ata = getAssociatedTokenAddressSync(mintPubkey, pubkey);
  try {
    const account = await getAccount(conn, ata);
    // Detect decimals: JitoSOL = 9, USDC = 6
    const decimals = mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ||
                     mint === '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
      ? 6 : 9;
    return Number(account.amount) / 10 ** decimals;
  } catch {
    return 0;
  }
}

export async function getWsolBalance(network: Network, address: string): Promise<number> {
  return getSplTokenBalance(network, address, WSOL_CONFIG.mint);
}

export async function wrapSol(
  network: Network,
  keypair: Keypair,
  amountSol: number,
): Promise<string> {
  const conn = getConnection(network);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, keypair.publicKey);

  const tx = new Transaction();

  // Create WSOL ATA if it doesn't exist
  let needsAta = false;
  try {
    await getAccount(conn, ata);
  } catch {
    needsAta = true;
  }

  if (needsAta) {
    tx.add(createAssociatedTokenAccountInstruction(
      keypair.publicKey,
      ata,
      keypair.publicKey,
      NATIVE_MINT,
    ));
  }

  // Transfer SOL to the ATA
  tx.add(SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: ata,
    lamports,
  }));

  // Sync the native balance
  tx.add(createSyncNativeInstruction(ata));

  const signature = await sendAndConfirmTransaction(conn, tx, [keypair]);
  return signature;
}

export async function unwrapSol(
  network: Network,
  keypair: Keypair,
): Promise<string> {
  const conn = getConnection(network);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, keypair.publicKey);

  // Close the WSOL account — lamports are returned to the owner
  const tx = new Transaction().add(
    createCloseAccountInstruction(ata, keypair.publicKey, keypair.publicKey),
  );

  const signature = await sendAndConfirmTransaction(conn, tx, [keypair]);
  return signature;
}

export async function sendSol(
  network: Network,
  from: Keypair,
  to: string,
  amountSol: number,
): Promise<string> {
  const conn = getConnection(network);
  const toPubkey = new PublicKey(to);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey,
      lamports,
    }),
  );

  const signature = await sendAndConfirmTransaction(conn, tx, [from]);
  return signature;
}
