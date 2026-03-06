import { Connection, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, createCloseAccountInstruction, NATIVE_MINT } from '@solana/spl-token';
import { type Network, SOLANA_CONFIG, WSOL_CONFIG } from '../config.js';
import type { Signer } from '../signers/types.js';

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
  signer: Signer,
  amountSol: number,
): Promise<string> {
  const conn = getConnection(network);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const solAddr = await signer.getSolanaAddress();
  if (!solAddr) throw new Error('No Solana address available');
  const pubkey = new PublicKey(solAddr);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, pubkey);

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
      pubkey,
      ata,
      pubkey,
      NATIVE_MINT,
    ));
  }

  // Transfer SOL to the ATA
  tx.add(SystemProgram.transfer({
    fromPubkey: pubkey,
    toPubkey: ata,
    lamports,
  }));

  // Sync the native balance
  tx.add(createSyncNativeInstruction(ata));

  return signer.signAndSendSolanaTransaction(conn, tx);
}

export async function unwrapSol(
  network: Network,
  signer: Signer,
): Promise<string> {
  const conn = getConnection(network);
  const solAddr = await signer.getSolanaAddress();
  if (!solAddr) throw new Error('No Solana address available');
  const pubkey = new PublicKey(solAddr);
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, pubkey);

  // Close the WSOL account — lamports are returned to the owner
  const tx = new Transaction().add(
    createCloseAccountInstruction(ata, pubkey, pubkey),
  );

  return signer.signAndSendSolanaTransaction(conn, tx);
}

export async function sendSol(
  network: Network,
  signer: Signer,
  to: string,
  amountSol: number,
): Promise<string> {
  const conn = getConnection(network);
  const solAddr = await signer.getSolanaAddress();
  if (!solAddr) throw new Error('No Solana address available');
  const fromPubkey = new PublicKey(solAddr);
  const toPubkey = new PublicKey(to);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey,
      lamports,
    }),
  );

  return signer.signAndSendSolanaTransaction(conn, tx);
}
