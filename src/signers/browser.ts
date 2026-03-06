import { createServer } from 'node:http';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { PublicKey, VersionedTransaction, Transaction, type Connection } from '@solana/web3.js';
import { toAccount } from 'viem/accounts';
import { createWalletClient, type LocalAccount, type Chain, type HttpTransport, type WalletClient } from 'viem';
import type { Signer } from './types.js';

// ── Session persistence ──

const SESSION_DIR = join(homedir(), '.wallet-cli', 'browser-sessions');
const SOLANA_SESSION_FILE = join(SESSION_DIR, 'solana.json');
const EVM_SESSION_FILE = join(SESSION_DIR, 'evm.json');
const BRIDGE_PORT = 18457;

export interface BrowserSession {
  publicKey: string;
  walletName: string;
  connectedAt: number;
}

export interface EvmBrowserSession {
  address: string;
  walletName: string;
  connectedAt: number;
}

function ensureDir() {
  mkdirSync(SESSION_DIR, { recursive: true });
}

// Solana session
export function saveBrowserSession(session: BrowserSession): void {
  ensureDir();
  writeFileSync(SOLANA_SESSION_FILE, JSON.stringify(session, null, 2));
}

export function loadBrowserSession(): BrowserSession | null {
  if (!existsSync(SOLANA_SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SOLANA_SESSION_FILE, 'utf-8'));
  } catch { return null; }
}

export function deleteBrowserSession(): void {
  if (existsSync(SOLANA_SESSION_FILE)) {
    try { unlinkSync(SOLANA_SESSION_FILE); } catch {}
  }
}

// EVM session
export function saveEvmBrowserSession(session: EvmBrowserSession): void {
  ensureDir();
  writeFileSync(EVM_SESSION_FILE, JSON.stringify(session, null, 2));
}

export function loadEvmBrowserSession(): EvmBrowserSession | null {
  if (!existsSync(EVM_SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(EVM_SESSION_FILE, 'utf-8'));
  } catch { return null; }
}

export function deleteEvmBrowserSession(): void {
  if (existsSync(EVM_SESSION_FILE)) {
    try { unlinkSync(EVM_SESSION_FILE); } catch {}
  }
}

// ── HTML page ──

interface PageConfig {
  chain: 'evm' | 'solana';
  mode: string; // 'connect' | 'sign' | 'eth_sendTransaction' | 'personal_sign' | 'eth_signTypedData_v4'
  data?: string;
  hint?: string;
}

function getPageHtml(config: PageConfig): string {
  const cfgJson = JSON.stringify(config);
  const subtitle = config.mode === 'connect'
    ? `Connect your ${config.chain === 'evm' ? 'EVM' : 'Solana'} wallet`
    : config.chain === 'evm' ? 'Approve transaction' : 'Sign transaction';

  return `<!DOCTYPE html>
<html><head><title>wallet-cli</title><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#111;color:#eee;font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh}
.c{text-align:center;max-width:420px;padding:2rem}
h2{margin-bottom:8px}
.sub{color:#888;margin-bottom:24px;font-size:.9rem}
.s{padding:12px;border-radius:8px;margin:12px 0}
.ok{background:#0a2e1a;border:1px solid #22c55e;color:#22c55e}
.err{background:#2e0a0a;border:1px solid #ef4444;color:#ef4444}
.wait{background:#0a1a2e;border:1px solid #3b82f6;color:#3b82f6}
button{display:block;width:100%;padding:12px;margin:8px 0;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:16px;cursor:pointer}
button:hover{background:#252525}
button:disabled{opacity:.4;cursor:not-allowed}
.mono{font-family:monospace;font-size:12px;word-break:break-all;color:#666;margin-top:8px}
</style></head><body>
<div class="c">
<h2>wallet-cli</h2>
<p class="sub">${subtitle}</p>
<div id="st" class="s wait">Detecting wallets...</div>
<div id="ws"></div>
</div>
<script id="cfg" type="application/json">${cfgJson}</script>
<script>
var cfg=JSON.parse(document.getElementById('cfg').textContent);
var CHAIN=cfg.chain,MODE=cfg.mode,DATA=cfg.data||'',HINT=cfg.hint||'';
function el(id){return document.getElementById(id)}
function status(msg,cls){el('st').textContent=msg;el('st').className='s '+cls}
function post(d){return fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})}

function evmProviders(){
  var p=[];
  if(window.ethereum&&window.ethereum.providers){
    window.ethereum.providers.forEach(function(prov){
      if(prov.isMetaMask&&!prov.isBraveWallet)p.push({n:'MetaMask',p:prov});
      else if(prov.isCoinbaseWallet)p.push({n:'Coinbase Wallet',p:prov});
      else if(prov.isPhantom)p.push({n:'Phantom',p:prov});
    });
  }
  if(!p.length&&window.ethereum){
    if(window.ethereum.isMetaMask)p.push({n:'MetaMask',p:window.ethereum});
    else if(window.ethereum.isCoinbaseWallet)p.push({n:'Coinbase Wallet',p:window.ethereum});
    else if(window.ethereum.isPhantom)p.push({n:'Phantom',p:window.ethereum});
    else p.push({n:'Wallet',p:window.ethereum});
  }
  if(!p.length&&window.phantom&&window.phantom.ethereum&&window.phantom.ethereum.isPhantom)
    p.push({n:'Phantom',p:window.phantom.ethereum});
  return p;
}

function solProviders(){
  var p=[];
  if(window.phantom&&window.phantom.solana&&window.phantom.solana.isPhantom)p.push({n:'Phantom',p:window.phantom.solana});
  if(window.solflare&&window.solflare.isSolflare)p.push({n:'Solflare',p:window.solflare});
  if(window.backpack)p.push({n:'Backpack',p:window.backpack});
  if(window.coinbaseSolana)p.push({n:'Coinbase Wallet',p:window.coinbaseSolana});
  if(!p.length&&window.solana)p.push({n:'Wallet',p:window.solana});
  return p;
}

async function goEvm(name,prov){
  try{
    status('Connecting to '+name+'...','wait');
    var accts=await prov.request({method:'eth_requestAccounts'});
    if(!accts||!accts.length)throw new Error('No accounts returned');
    var addr=accts[0];
    if(MODE==='connect'){
      await post({address:addr,walletName:name});
      status('Connected! You can close this tab.','ok');
      el('ws').innerHTML='<div class="mono">'+addr+'</div>';
    }else if(MODE==='eth_sendTransaction'){
      status('Approve the transaction in '+name+'...','wait');
      var tx=JSON.parse(DATA);
      tx.from=addr;
      var hash=await prov.request({method:'eth_sendTransaction',params:[tx]});
      await post({hash:hash});
      status('Transaction sent! You can close this tab.','ok');
      el('ws').innerHTML='<div class="mono">'+hash+'</div>';
    }else if(MODE==='personal_sign'){
      status('Sign the message in '+name+'...','wait');
      var sig=await prov.request({method:'personal_sign',params:[DATA,addr]});
      await post({signature:sig});
      status('Signed! You can close this tab.','ok');
    }else if(MODE==='eth_signTypedData_v4'){
      status('Sign the typed data in '+name+'...','wait');
      var sig=await prov.request({method:'eth_signTypedData_v4',params:[addr,DATA]});
      await post({signature:sig});
      status('Signed! You can close this tab.','ok');
    }
  }catch(e){status('Error: '+e.message,'err')}
}

async function goSol(name,prov){
  try{
    status('Connecting to '+name+'...','wait');
    await prov.connect();
    if(MODE==='connect'){
      var pk=prov.publicKey.toString();
      await post({publicKey:pk,walletName:name});
      status('Connected! You can close this tab.','ok');
      el('ws').innerHTML='<div class="mono">'+pk+'</div>';
    }else{
      status('Approve the transaction in '+name+'...','wait');
      var bytes=Uint8Array.from(atob(DATA),function(c){return c.charCodeAt(0)});
      var signed;
      try{signed=await prov.signTransaction(solanaWeb3.VersionedTransaction.deserialize(bytes))}
      catch(e1){signed=await prov.signTransaction(solanaWeb3.Transaction.from(bytes))}
      var arr=signed.serialize();
      var b64=btoa(String.fromCharCode.apply(null,arr));
      await post({signedTransaction:b64});
      status('Signed! You can close this tab.','ok');
    }
  }catch(e){status('Error: '+e.message,'err')}
}

function loadSolanaLib(cb){
  var s=document.createElement('script');
  s.src='https://cdn.jsdelivr.net/npm/@solana/web3.js@1/lib/index.iife.min.js';
  s.onload=cb;
  s.onerror=function(){status('Failed to load Solana library. Check internet connection.','err')};
  document.head.appendChild(s);
}

function init(){
  var ps,goFn;
  if(CHAIN==='evm'){ps=evmProviders();goFn=goEvm}
  else{ps=solProviders();goFn=goSol}
  if(!ps.length){
    status(CHAIN==='evm'
      ?'No EVM wallet found. Install MetaMask, Coinbase Wallet, or Phantom.'
      :'No Solana wallet found. Install Phantom, Solflare, or Backpack.','err');
    return;
  }
  if(HINT){var pref=ps.find(function(x){return x.n===HINT});if(pref){goFn(pref.n,pref.p);return}}
  if(ps.length===1){goFn(ps[0].n,ps[0].p);return}
  status(MODE==='connect'?'Select a wallet':'Select wallet to approve','wait');
  ps.forEach(function(w){var btn=document.createElement('button');btn.textContent=w.n;btn.onclick=function(){btn.disabled=true;goFn(w.n,w.p)};el('ws').appendChild(btn)});
}

setTimeout(function(){
  if(CHAIN==='solana'&&MODE!=='connect'){loadSolanaLib(init)}
  else{init()}
},500);
</script></body></html>`;
}

// ── Bridge server ──

function startBridge(config: PageConfig): Promise<any> {
  return new Promise((resolve, reject) => {
    const html = getPageHtml(config);

    const server = createServer((req, res) => {
      if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && req.url === '/result') {
        let body = '';
        req.on('data', (c: Buffer) => body += c);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
          server.close();
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${BRIDGE_PORT} in use. Is another wallet-cli instance running?`));
      } else {
        reject(err);
      }
    });

    server.listen(BRIDGE_PORT, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${BRIDGE_PORT}`;
      console.log(`\n  Open in your browser: ${url}\n`);
      if (config.mode === 'connect') {
        console.log(`  Connect your ${config.chain === 'evm' ? 'EVM' : 'Solana'} wallet in the browser page.`);
      } else {
        console.log('  Approve the transaction in your wallet.');
      }
      console.log('  Waiting...\n');
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Browser bridge timed out (5 minutes)'));
    }, 5 * 60 * 1000);

    const origResolve = resolve;
    resolve = (val: any) => { clearTimeout(timer); origResolve(val); };
  });
}

// ── Solana public API ──

export async function connectViaBrowser(): Promise<BrowserSession> {
  const result = await startBridge({ chain: 'solana', mode: 'connect' });
  const session: BrowserSession = {
    publicKey: result.publicKey,
    walletName: result.walletName,
    connectedAt: Date.now(),
  };
  saveBrowserSession(session);
  return session;
}

export async function signViaBrowser(txBase64: string, walletHint?: string): Promise<string> {
  const result = await startBridge({ chain: 'solana', mode: 'sign', data: txBase64, hint: walletHint });
  return result.signedTransaction;
}

// ── EVM public API ──

export async function connectEvmViaBrowser(): Promise<EvmBrowserSession> {
  const result = await startBridge({ chain: 'evm', mode: 'connect' });
  const session: EvmBrowserSession = {
    address: result.address,
    walletName: result.walletName,
    connectedAt: Date.now(),
  };
  saveEvmBrowserSession(session);
  return session;
}

async function sendEvmTransaction(txParams: Record<string, string>, walletHint?: string): Promise<string> {
  const result = await startBridge({
    chain: 'evm',
    mode: 'eth_sendTransaction',
    data: JSON.stringify(txParams),
    hint: walletHint,
  });
  return result.hash;
}

async function signEvmMessage(msgHex: string, walletHint?: string): Promise<string> {
  const result = await startBridge({
    chain: 'evm',
    mode: 'personal_sign',
    data: msgHex,
    hint: walletHint,
  });
  return result.signature;
}

async function signEvmTypedData(typedDataJson: string, walletHint?: string): Promise<string> {
  const result = await startBridge({
    chain: 'evm',
    mode: 'eth_signTypedData_v4',
    data: typedDataJson,
    hint: walletHint,
  });
  return result.signature;
}

// ── BrowserSigner (EVM + Solana) ──

export class BrowserSigner implements Signer {
  readonly type = 'browser' as const;
  readonly label: string;
  private evmSession: EvmBrowserSession | null;
  private solSession: BrowserSession | null;

  constructor(evmSession: EvmBrowserSession | null, solSession: BrowserSession | null) {
    this.evmSession = evmSession;
    this.solSession = solSession;
    const parts: string[] = [];
    if (evmSession) parts.push(`EVM: ${evmSession.walletName}`);
    if (solSession) parts.push(`Solana: ${solSession.walletName}`);
    this.label = `Browser (${parts.join(', ') || 'none'})`;
  }

  // ── EVM ──

  async getEvmAddress(): Promise<`0x${string}` | null> {
    if (!this.evmSession) return null;
    return this.evmSession.address as `0x${string}`;
  }

  async getEvmAccount(): Promise<LocalAccount> {
    if (!this.evmSession) throw new Error('No EVM browser session. Run "wallet connect evm browser".');
    const address = this.evmSession.address as `0x${string}`;
    const hint = this.evmSession.walletName;

    return toAccount({
      address,

      async signMessage({ message }) {
        const msgHex = typeof message === 'string'
          ? `0x${Buffer.from(message).toString('hex')}`
          : typeof message === 'object' && 'raw' in message
            ? (typeof message.raw === 'string' ? message.raw : `0x${Buffer.from(message.raw).toString('hex')}`)
            : `0x${Buffer.from(message as any).toString('hex')}`;

        return await signEvmMessage(msgHex, hint) as `0x${string}`;
      },

      async signTransaction(_transaction) {
        // MetaMask doesn't support eth_signTransaction — use sendTransaction instead
        throw new Error('signTransaction not supported via browser. Use sendTransaction.');
      },

      async signTypedData(typedData) {
        const data = JSON.stringify({
          types: typedData.types,
          primaryType: typedData.primaryType,
          domain: typedData.domain,
          message: typedData.message,
        });
        return await signEvmTypedData(data, hint) as `0x${string}`;
      },
    });
  }

  async getEvmWalletClient(chain: Chain, transport: HttpTransport): Promise<WalletClient<HttpTransport, Chain, LocalAccount>> {
    if (!this.evmSession) throw new Error('No EVM browser session. Run "wallet connect evm browser".');
    const account = await this.getEvmAccount();
    const walletClient = createWalletClient({ account, chain, transport });
    const hint = this.evmSession.walletName;

    // Monkey-patch sendTransaction and writeContract to use browser bridge.
    // MetaMask doesn't support eth_signTransaction — it only supports
    // eth_sendTransaction which signs AND broadcasts from the wallet side.
    // viem's writeContract with a LocalAccount calls signTransaction internally,
    // so we must also patch writeContract to go through the browser bridge.
    const sendViaBrowser = async (args: any) => {
      const txParams: Record<string, string> = {
        to: args.to,
        data: args.data || '0x',
        value: args.value ? `0x${args.value.toString(16)}` : '0x0',
      };
      if (args.gas) txParams.gas = `0x${args.gas.toString(16)}`;
      return await sendEvmTransaction(txParams, hint) as `0x${string}`;
    };

    walletClient.sendTransaction = sendViaBrowser as any;

    // writeContract: encode the call data ourselves and send via browser
    const origWriteContract = walletClient.writeContract;
    walletClient.writeContract = (async (args: any) => {
      const { encodeFunctionData } = await import('viem');
      const data = encodeFunctionData({
        abi: args.abi,
        functionName: args.functionName,
        args: args.args,
      });
      return sendViaBrowser({
        to: args.address,
        data,
        value: args.value,
        gas: args.gas,
      });
    }) as typeof origWriteContract;

    return walletClient;
  }

  // ── Solana ──

  async getSolanaAddress(): Promise<string | null> {
    if (!this.solSession) return null;
    return this.solSession.publicKey;
  }

  async signSolanaVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    if (!this.solSession) throw new Error('No Solana browser session. Run "wallet connect solana".');
    const serialized = Buffer.from(tx.serialize()).toString('base64');
    const signedBase64 = await signViaBrowser(serialized, this.solSession.walletName);
    return VersionedTransaction.deserialize(Buffer.from(signedBase64, 'base64'));
  }

  async signAndSendSolanaTransaction(conn: Connection, tx: Transaction): Promise<string> {
    if (!this.solSession) throw new Error('No Solana browser session. Run "wallet connect solana".');
    const pubkey = new PublicKey(this.solSession.publicKey);
    if (!tx.feePayer) tx.feePayer = pubkey;
    if (!tx.recentBlockhash) {
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
    }

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const signedBase64 = await signViaBrowser(serialized, this.solSession.walletName);
    const signedTx = Transaction.from(Buffer.from(signedBase64, 'base64'));

    const signature = await conn.sendRawTransaction(signedTx.serialize());
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
    return signature;
  }
}
