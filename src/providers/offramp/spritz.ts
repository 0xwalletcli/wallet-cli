import type { OfframpProvider, OfframpBankAccount, OfframpQuote, OfframpOrderSummary } from '../types.js';
import { registerOfframpProvider } from '../registry.js';
import { getSpritzClient, listBankAccounts, createPaymentRequest, getWeb3PaymentParams, getPaymentHistory } from '../../lib/spritz.js';
import { formatUSD } from '../../lib/format.js';

const spritzOfframpProvider: OfframpProvider = {
  id: 'spritz',
  displayName: 'Spritz Finance',

  isConfigured(): boolean {
    return !!(process.env.SPRITZ_API_KEY || process.env.SPRITZ_INTEGRATION_KEY);
  },

  async listAccounts(): Promise<OfframpBankAccount[]> {
    const accounts = await listBankAccounts();
    if (!accounts || !Array.isArray(accounts)) return [];
    return accounts.map((acct: any) => ({
      id: acct.id,
      label: acct.name || acct.institution?.name || acct.holder || 'Bank Account',
      institution: acct.institution?.name,
      accountNumber: acct.accountNumber,
      type: acct.bankAccountSubType || acct.bankAccountType || '',
    }));
  },

  async getQuote({ amount, bankAccountId, tokenAddress }): Promise<OfframpQuote> {
    const paymentRequest = await createPaymentRequest(bankAccountId, Number(amount), tokenAddress);
    const txParams = await getWeb3PaymentParams(paymentRequest, tokenAddress);
    const web3 = txParams as any;

    return {
      provider: 'spritz',
      amount,
      amountRaw: (BigInt(Math.round(Number(amount) * 1e6))).toString(),
      bankAccountId,
      bankAccountLabel: '',
      fee: 'included',
      estimatedTime: '~1 business day (ACH)',
      txParams: {
        to: web3.contractAddress,
        data: web3.calldata,
        value: web3.value || undefined,
        gasLimit: web3.suggestedGasLimit || undefined,
      },
      _raw: { paymentRequest, txParams },
    };
  },

  async getHistory(): Promise<OfframpOrderSummary[]> {
    const accounts = await listBankAccounts();
    if (!accounts || !Array.isArray(accounts)) return [];

    let allPayments: any[] = [];
    for (const acct of accounts) {
      try {
        const payments = await getPaymentHistory((acct as any).id);
        if (Array.isArray(payments)) allPayments = allPayments.concat(payments);
      } catch { /* skip */ }
    }

    return allPayments
      .sort((a: any, b: any) => {
        const dateA = new Date(a.createdAt || a.created || 0).getTime();
        const dateB = new Date(b.createdAt || b.created || 0).getTime();
        return dateB - dateA;
      })
      .slice(0, 10)
      .map((p: any) => ({
        id: p.id || '',
        amount: p.amount ? formatUSD(p.amount / 100) : '?',
        status: (p.status || 'unknown').toLowerCase(),
        createdAt: new Date(p.createdAt || p.created || 0).toISOString(),
        provider: 'spritz',
      }));
  },
};

registerOfframpProvider(spritzOfframpProvider);
export { spritzOfframpProvider };
