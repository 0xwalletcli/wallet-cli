export function formatUSD(value: number, decimals = 2): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function formatToken(value: number, decimals = 6): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: decimals });
}

export function formatAddress(address: string, chars = 6): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

/** Format gas fee from USD string: "5.23" -> "~$5.23 gas", "0" -> "gas only" */
export function formatGasFee(gasFeeUSD: string | undefined, compact = false): string | null {
  if (!gasFeeUSD) return null;
  const n = Number(gasFeeUSD);
  if (isNaN(n) || n <= 0) return null;
  return compact ? `~$${n.toFixed(2)} gas` : `~$${n.toFixed(2)} gas (ETH)`;
}

/** Terminal clickable hyperlink (OSC 8). Shows `label` as clickable text linking to `url`. */
export function link(url: string, label: string): string {
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

/** Shortened tx hash as a clickable terminal link. */
export function txLink(hash: string, explorerBase: string): string {
  const short = hash.slice(0, 8) + '...' + hash.slice(-4);
  return link(`${explorerBase}/tx/${hash}`, short);
}

export function parseTokenAmount(amount: string, decimals: number): bigint {
  const parts = amount.split('.');
  const whole = parts[0] || '0';
  const frac = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole + frac);
}
