/**
 * Migration tests for the clob-client-v2 port.
 *
 * These pin the behaviours that changed between @polymarket/clob-client v5 and
 * @polymarket/clob-client-v2:
 *
 *  - the constructor takes one options object instead of positional arguments
 *  - `getBalanceAllowance` returns an `allowances` map, not a single string
 *  - API errors come back as `{ error, status }` objects instead of throwing
 *  - `OrderResponse` lost `orderIDs` and gained `tradeIDs`
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const clobClientCalls: any[] = [];
const clientMock = {
  deriveApiKey: vi.fn(),
  createApiKey: vi.fn(),
  getTickSize: vi.fn(async () => '0.01'),
  getNegRisk: vi.fn(async () => false),
  createAndPostOrder: vi.fn(),
  createAndPostMarketOrder: vi.fn(),
  cancelOrder: vi.fn(),
  cancelOrders: vi.fn(),
  cancelAll: vi.fn(),
  getOpenOrders: vi.fn(),
  getTrades: vi.fn(),
  getBalanceAllowance: vi.fn(),
  updateBalanceAllowance: vi.fn(),
};

vi.mock('@polymarket/clob-client-v2', async () => {
  const actual = await vi.importActual<any>('@polymarket/clob-client-v2');
  return {
    ...actual,
    ClobClient: vi.fn(function (options: any) {
      clobClientCalls.push(options);
      return clientMock;
    }),
  };
});

const { TradingService } = await import('./trading-service.js');
const { RateLimiter } = await import('../core/rate-limiter.js');
const { createUnifiedCache } = await import('../core/unified-cache.js');
const { AssetType, SignatureTypeV2 } = await import('@polymarket/clob-client-v2');

// Throwaway key — never used to sign anything that leaves the process.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CREDS = { key: 'k', secret: 'c2VjcmV0', passphrase: 'p' };

function makeService(config: Record<string, unknown> = {}) {
  return new TradingService(new RateLimiter(), createUnifiedCache(), {
    privateKey: TEST_KEY,
    ...config,
  } as any);
}

beforeEach(() => {
  clobClientCalls.length = 0;
  for (const fn of Object.values(clientMock)) (fn as any).mockClear?.();
  clientMock.deriveApiKey.mockResolvedValue(CREDS);
  clientMock.getTickSize.mockResolvedValue('0.01');
  clientMock.getNegRisk.mockResolvedValue(false);
});

describe('initialization', () => {
  it('constructs the client with a v2 options object, not positional args', async () => {
    await makeService().initialize();

    expect(clobClientCalls.length).toBeGreaterThan(0);
    const options = clobClientCalls[0];
    expect(options).toMatchObject({
      host: 'https://clob.polymarket.com',
      chain: 137,
      signatureType: SignatureTypeV2.EOA,
    });
    // The signer is an ethers v5 Wallet, which v2 accepts via `_signTypedData`.
    expect(typeof options.signer._signTypedData).toBe('function');
  });

  it('derives an existing API key before trying to create one', async () => {
    await makeService().initialize();

    expect(clientMock.deriveApiKey).toHaveBeenCalled();
    expect(clientMock.createApiKey).not.toHaveBeenCalled();

    // Second construction carries the L2 credentials.
    expect(clobClientCalls[1].creds).toEqual(CREDS);
  });

  it('creates a key when none exists yet', async () => {
    clientMock.deriveApiKey.mockResolvedValue({ error: 'not found', status: 400 });
    clientMock.createApiKey.mockResolvedValue(CREDS);

    await makeService().initialize();

    expect(clientMock.createApiKey).toHaveBeenCalled();
  });

  it('fails with a geoblock hint when neither derive nor create works', async () => {
    clientMock.deriveApiKey.mockResolvedValue({ error: 'forbidden', status: 403 });
    clientMock.createApiKey.mockResolvedValue({ error: 'forbidden', status: 403 });

    await expect(makeService().initialize()).rejects.toThrow(/geoblocked|check:vpn/);
  });

  it('passes a funder address and signature type through for proxy wallets', async () => {
    await makeService({
      signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
      funderAddress: '0x1234567890123456789012345678901234567890',
    }).initialize();

    expect(clobClientCalls[0]).toMatchObject({
      signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
      funderAddress: '0x1234567890123456789012345678901234567890',
    });
  });
});

describe('createLimitOrder', () => {
  it('maps a successful v2 OrderResponse', async () => {
    clientMock.createAndPostOrder.mockResolvedValue({
      success: true,
      orderID: 'order-1',
      errorMsg: '',
      status: 'live',
      tradeIDs: ['trade-1'],
      transactionsHashes: ['0xabc'],
      takingAmount: '10',
      makingAmount: '10',
    });

    const result = await makeService().createLimitOrder({
      tokenId: 't',
      side: 'BUY',
      price: 0.4,
      size: 10,
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe('order-1');
    expect(result.tradeIds).toEqual(['trade-1']);
    expect(result.transactionHashes).toEqual(['0xabc']);
    // v2 posts one order per call; the legacy plural field mirrors orderId.
    expect(result.orderIds).toEqual(['order-1']);
  });

  it('treats a v2 error body as a failure rather than a success', async () => {
    // v2 returns errors as objects instead of throwing. Reading `success` off
    // such a body yields undefined, which the old truthiness check would have
    // let through.
    clientMock.createAndPostOrder.mockResolvedValue({ error: 'not enough balance', status: 400 });

    const result = await makeService().createLimitOrder({
      tokenId: 't',
      side: 'BUY',
      price: 0.4,
      size: 10,
    });

    expect(result.success).toBe(false);
    expect(result.errorMsg).toContain('not enough balance');
    expect(result.errorMsg).toContain('400');
  });

  it('rejects sub-minimum orders without calling the API', async () => {
    const result = await makeService().createLimitOrder({
      tokenId: 't',
      side: 'BUY',
      price: 0.4,
      size: 1,
    });

    expect(result.success).toBe(false);
    expect(clientMock.createAndPostOrder).not.toHaveBeenCalled();
  });

  it('passes tickSize and negRisk as v2 create options', async () => {
    clientMock.getTickSize.mockResolvedValue('0.001');
    clientMock.getNegRisk.mockResolvedValue(true);
    clientMock.createAndPostOrder.mockResolvedValue({ success: true, orderID: 'o' });

    await makeService().createLimitOrder({ tokenId: 't', side: 'SELL', price: 0.4, size: 10 });

    const [, options] = clientMock.createAndPostOrder.mock.calls[0]!;
    expect(options).toEqual({ tickSize: '0.001', negRisk: true });
  });
});

describe('createMarketOrder', () => {
  it('sets orderType on the order body as well as the call argument', async () => {
    // v2 uses the body's orderType to pick the marketable price when `price`
    // is omitted, so the two have to agree.
    clientMock.createAndPostMarketOrder.mockResolvedValue({ success: true, orderID: 'o' });

    await makeService().createMarketOrder({
      tokenId: 't',
      side: 'BUY',
      amount: 25,
      orderType: 'FAK',
    });

    const [body, , orderType] = clientMock.createAndPostMarketOrder.mock.calls[0]!;
    expect(body.orderType).toBe('FAK');
    expect(orderType).toBe('FAK');
  });
});

describe('cancel', () => {
  it('reports success only when an order was actually cancelled', async () => {
    clientMock.cancelOrder.mockResolvedValue({ canceled: ['order-1'], not_canceled: {} });

    const result = await makeService().cancelOrder('order-1');
    expect(result.success).toBe(true);
  });

  it('reports failure for an empty canceled list', async () => {
    // The old code did `result.canceled ?? false`, which made `[]` truthy and
    // reported a no-op cancel as a success.
    clientMock.cancelOrder.mockResolvedValue({ canceled: [], not_canceled: {} });

    const result = await makeService().cancelOrder('order-1');
    expect(result.success).toBe(false);
  });

  it('surfaces the reason when the CLOB refuses to cancel', async () => {
    clientMock.cancelOrder.mockResolvedValue({
      canceled: [],
      not_canceled: { 'order-1': 'order already matched' },
    });

    const result = await makeService().cancelOrder('order-1');
    expect(result.success).toBe(false);
    expect(result.errorMsg).toContain('order already matched');
  });
});

describe('getBalanceAllowance', () => {
  it('collapses the v2 allowances map to the smallest approval', async () => {
    clientMock.getBalanceAllowance.mockResolvedValue({
      balance: '1000000',
      allowances: {
        '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E': '5000000',
        '0xC5d563A36AE78145C45a50134d48A1215220f80a': '2000000',
      },
    });

    const result = await makeService().getBalanceAllowance('COLLATERAL');

    expect(result.balance).toBe('1000000');
    // The least-approved exchange is the one an order can fail on.
    expect(result.allowance).toBe('2000000');
    expect(Object.keys(result.allowances)).toHaveLength(2);
  });

  it('reports zero allowance when nothing has been approved', async () => {
    clientMock.getBalanceAllowance.mockResolvedValue({ balance: '0', allowances: {} });

    const result = await makeService().getBalanceAllowance('COLLATERAL');
    expect(result.allowance).toBe('0');
  });

  it('sends the v2 AssetType enum', async () => {
    clientMock.getBalanceAllowance.mockResolvedValue({ balance: '0', allowances: {} });

    await makeService().getBalanceAllowance('CONDITIONAL', 'token-1');

    expect(clientMock.getBalanceAllowance).toHaveBeenCalledWith({
      asset_type: AssetType.CONDITIONAL,
      token_id: 'token-1',
    });
  });

  it('throws on a v2 error body instead of returning undefined fields', async () => {
    clientMock.getBalanceAllowance.mockResolvedValue({ error: 'unauthorized', status: 401 });

    await expect(makeService().getBalanceAllowance('COLLATERAL')).rejects.toThrow(/unauthorized/);
  });
});

describe('list endpoints', () => {
  it('maps open orders', async () => {
    clientMock.getOpenOrders.mockResolvedValue([
      {
        id: 'o1',
        status: 'LIVE',
        asset_id: 't1',
        side: 'buy',
        price: '0.42',
        original_size: '100',
        size_matched: '30',
        associate_trades: ['tr1'],
        created_at: 1700000000,
      },
    ]);

    const [order] = await makeService().getOpenOrders();

    expect(order).toMatchObject({
      id: 'o1',
      tokenId: 't1',
      side: 'BUY',
      price: 0.42,
      originalSize: 100,
      filledSize: 30,
      remainingSize: 70,
    });
  });

  it('turns a v2 error body into a thrown error rather than a map() crash', async () => {
    clientMock.getOpenOrders.mockResolvedValue({ error: 'unauthorized', status: 401 });

    await expect(makeService().getOpenOrders()).rejects.toThrow(/getOpenOrders failed.*unauthorized/);
  });

  it('maps trades', async () => {
    clientMock.getTrades.mockResolvedValue([
      {
        id: 'tr1',
        asset_id: 't1',
        side: 'SELL',
        price: '0.55',
        size: '12',
        fee_rate_bps: '20',
        match_time: '1700000000',
      },
    ]);

    const [trade] = await makeService().getTrades();

    expect(trade).toMatchObject({ id: 'tr1', side: 'SELL', price: 0.55, size: 12, fee: 20 });
  });
});
