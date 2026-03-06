import { SpritzApiClient, Environment, PaymentNetwork } from '@spritz-finance/api-client';

let _client: ReturnType<typeof SpritzApiClient.initialize> | null = null;

export function getSpritzClient(): ReturnType<typeof SpritzApiClient.initialize> {
  if (_client) return _client;

  const apiKey = process.env.SPRITZ_API_KEY;
  const integrationKey = process.env.SPRITZ_INTEGRATION_KEY;

  if (!apiKey && !integrationKey) {
    console.error('  SPRITZ_API_KEY must be set in .env');
    process.exit(1);
  }

  _client = SpritzApiClient.initialize({
    environment: Environment.Production,
    ...(apiKey ? { apiKey } : {}),
    ...(integrationKey ? { integrationKey } : {}),
  });

  return _client;
}

export async function listBankAccounts() {
  const client = getSpritzClient();
  return client.bankAccount.list();
}

export async function createPaymentRequest(accountId: string, amount: number, tokenAddress?: string) {
  const client = getSpritzClient();
  return client.paymentRequest.create({
    accountId,
    amount,
    network: PaymentNetwork.Ethereum,
    ...(tokenAddress ? { tokenAddress } : {}),
  });
}

export async function getWeb3PaymentParams(paymentRequest: any, paymentTokenAddress: string) {
  const client = getSpritzClient();
  return client.paymentRequest.getWeb3PaymentParams({
    paymentRequest,
    paymentTokenAddress,
  });
}

export async function getPaymentHistory(accountId: string) {
  const client = getSpritzClient();
  return client.payment.listForAccount(accountId);
}
