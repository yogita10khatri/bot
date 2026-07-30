/**
 * Order signing interop: ethers v5 wallet against clob-client-v2.
 *
 * This is the riskiest part of the v1 → v2 migration. v2's README shows a viem
 * `WalletClient`, but its `ClobSigner` type also accepts anything exposing
 * `_signTypedData`/`getAddress`, which is what an ethers v5 `Wallet` provides.
 * The rest of this codebase (swaps, approvals, on-chain reads) is on ethers v5,
 * so TradingService keeps a single ethers wallet and hands it to v2 as the
 * signer.
 *
 * A mocked client cannot tell us whether that interop produces a signature the
 * exchange would actually accept, so these tests build and sign real orders
 * with the real v2 order builder and recover the signer from the EIP-712
 * digest. No network: the client's tick-size and neg-risk caches are pre-seeded
 * and the order version is pinned.
 */

import { describe, it, expect } from 'vitest';
import { Wallet, utils } from 'ethers';
import {
  ClobClient,
  Side,
  SignatureTypeV2,
  Chain,
  getContractConfig,
} from '@polymarket/clob-client-v2';

// Well-known Hardhat test key. Never used for anything real.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TOKEN_ID = '71321045679252212594626385532706912750332728571942532289631379312455583992563';

/** The EIP-712 struct v2 signs — CTF_EXCHANGE_V2_ORDER_STRUCT. */
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'metadata', type: 'bytes32' },
    { name: 'builder', type: 'bytes32' },
  ],
};

/**
 * A client whose market-data caches are pre-filled, so order construction and
 * signing happen entirely offline.
 */
function makeOfflineClient(): ClobClient {
  const client = new ClobClient({
    host: 'https://clob.polymarket.com',
    chain: Chain.POLYGON,
    signer: new Wallet(TEST_KEY),
    signatureType: SignatureTypeV2.EOA,
  });

  // Public caches on the client — seeding them short-circuits the lookups
  // createOrder would otherwise make.
  client.tickSizes[TOKEN_ID] = '0.01';
  client.negRisk[TOKEN_ID] = false;
  client.feeRates[TOKEN_ID] = 0;

  return client;
}

/** Recover the address that signed a v2 order. */
function recoverOrderSigner(order: any): string {
  const domain = {
    name: 'Polymarket CTF Exchange',
    version: '2',
    chainId: Chain.POLYGON,
    // version 2 + negRisk false on Polygon routes to the V2 exchange.
    verifyingContract: getContractConfig(Chain.POLYGON).exchangeV2,
  };

  const message = {
    salt: order.salt,
    maker: order.maker,
    signer: order.signer,
    tokenId: order.tokenId,
    makerAmount: order.makerAmount,
    takerAmount: order.takerAmount,
    side: order.side === 'BUY' ? 0 : 1,
    signatureType: order.signatureType,
    timestamp: order.timestamp,
    metadata: order.metadata,
    builder: order.builder,
  };

  const digest = utils._TypedDataEncoder.hash(domain, ORDER_TYPES, message);
  return utils.getAddress(utils.recoverAddress(digest, order.signature));
}

describe('ethers v5 signer against clob-client-v2', () => {
  it('signs a limit buy and the signature recovers to the wallet', async () => {
    const client = makeOfflineClient();

    const order = await client.createOrder(
      { tokenID: TOKEN_ID, price: 0.4, size: 10, side: Side.BUY },
      { tickSize: '0.01', negRisk: false, version: 2 }
    );

    expect(order.signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(utils.getAddress(order.maker)).toBe(TEST_ADDRESS);
    expect(utils.getAddress(order.signer)).toBe(TEST_ADDRESS);
    expect(order.signatureType).toBe(SignatureTypeV2.EOA);
    expect(order.side).toBe('BUY');

    // If the ethers signer were wired up wrongly — wrong domain, wrong struct,
    // wrong field order — this recovers to some other address.
    expect(recoverOrderSigner(order)).toBe(TEST_ADDRESS);
  });

  it('signs a limit sell and the signature recovers to the wallet', async () => {
    const client = makeOfflineClient();

    const order = await client.createOrder(
      { tokenID: TOKEN_ID, price: 0.6, size: 20, side: Side.SELL },
      { tickSize: '0.01', negRisk: false, version: 2 }
    );

    expect(order.side).toBe('SELL');
    expect(recoverOrderSigner(order)).toBe(TEST_ADDRESS);
  });

  it('converts price and size to six-decimal maker/taker amounts', async () => {
    const client = makeOfflineClient();

    // BUY 10 shares at $0.40 → pay 4 USDC, receive 10 outcome tokens.
    const order = await client.createOrder(
      { tokenID: TOKEN_ID, price: 0.4, size: 10, side: Side.BUY },
      { tickSize: '0.01', negRisk: false, version: 2 }
    );

    expect(order.makerAmount).toBe('4000000');
    expect(order.takerAmount).toBe('10000000');
  });

  it('rejects a price outside the tick-size bounds', async () => {
    const client = makeOfflineClient();

    // v2 validates the range [tick, 1 - tick]; prices inside it are rounded to
    // the tick rather than rejected.
    await expect(
      client.createOrder(
        { tokenID: TOKEN_ID, price: 1, size: 10, side: Side.BUY },
        { tickSize: '0.01', negRisk: false, version: 2 }
      )
    ).rejects.toThrow(/invalid price/);
  });

  it('carries an expiration through to the signed order', async () => {
    const client = makeOfflineClient();
    const expiration = Math.floor(Date.now() / 1000) + 3600;

    const order = await client.createOrder(
      { tokenID: TOKEN_ID, price: 0.4, size: 10, side: Side.BUY, expiration },
      { tickSize: '0.01', negRisk: false, version: 2 }
    );

    expect(order.expiration).toBe(String(expiration));
  });
});
