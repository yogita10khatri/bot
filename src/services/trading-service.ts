/**
 * TradingService
 *
 * Trading service using the official @polymarket/clob-client-v2.
 *
 * Provides:
 * - Order creation (limit, market)
 * - Order management (cancel, query)
 * - Rewards tracking
 * - Balance management
 *
 * Note: Market data methods have been moved to MarketService.
 */

import {
  ApiError,
  ClobClient,
  Side as ClobSide,
  OrderType as ClobOrderType,
  AssetType,
  Chain,
  SignatureTypeV2,
  type ApiKeyCreds,
  type OpenOrder,
  type OrderResponse,
  type Trade as ClobTrade,
  type TickSize,
} from '@polymarket/clob-client-v2';

import { Wallet } from 'ethers';
import { RateLimiter, ApiType } from '../core/rate-limiter.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { CACHE_TTL } from '../core/unified-cache.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type { Side, OrderType } from '../core/types.js';

// Chain IDs
export const POLYGON_MAINNET = 137;
export const POLYGON_AMOY = 80002;

// CLOB Host
const CLOB_HOST = 'https://clob.polymarket.com';

// ============================================================================
// Polymarket Order Minimums
// ============================================================================
// These are enforced by Polymarket's CLOB API. Orders below these limits will
// be rejected with errors like:
// - "invalid amount for a marketable BUY order ($X), min size: $1"
// - "Size (X) lower than the minimum: 5"
//
// Strategies should ensure orders meet these requirements BEFORE sending.
// ============================================================================

/** Minimum order value in USDC (price * size >= MIN_ORDER_VALUE) */
export const MIN_ORDER_VALUE_USDC = 1;

/** Minimum order size in shares */
export const MIN_ORDER_SIZE_SHARES = 5;

// ============================================================================
// Types
// ============================================================================

// Side and OrderType are imported from core/types.ts
// Re-export for backward compatibility
export type { Side, OrderType } from '../core/types.js';

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface TradingServiceConfig {
  /** Private key for signing */
  privateKey: string;
  /** Chain ID (default: Polygon mainnet 137) */
  chainId?: number;
  /** Pre-generated API credentials (optional) */
  credentials?: ApiCredentials;
  /** CLOB host override (default: https://clob.polymarket.com) */
  host?: string;
  /**
   * Signature type. EOA (0) is correct when the private key is the wallet that
   * holds the funds. Use POLY_PROXY (1) or POLY_GNOSIS_SAFE (2) together with
   * `funderAddress` when trading from a Polymarket proxy/safe wallet.
   *
   * clob-client-v2 only: v1 inferred this from the constructor arity.
   */
  signatureType?: SignatureTypeV2;
  /** Address holding the funds, when it differs from the signing key. */
  funderAddress?: string;
  /**
   * Retry once on transient network errors (5xx, timeouts). Useful over a VPN,
   * where a re-keying tunnel can drop a single request. Default: true.
   */
  retryOnError?: boolean;
}

// Order types
export interface LimitOrderParams {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD';
  expiration?: number;
}

export interface MarketOrderParams {
  tokenId: string;
  side: Side;
  amount: number;
  price?: number;
  orderType?: 'FOK' | 'FAK';
}

export interface Order {
  id: string;
  status: string;
  tokenId: string;
  side: Side;
  price: number;
  originalSize: number;
  filledSize: number;
  remainingSize: number;
  associateTrades: string[];
  createdAt: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  orderIds?: string[];
  errorMsg?: string;
  transactionHashes?: string[];
  /**
   * IDs of the trades created when the order matched. clob-client-v2 resolves
   * `transactionHashes` on a best-effort basis; when a hash is not available
   * yet the fill can still be followed through these IDs.
   */
  tradeIds?: string[];
}

export interface TradeInfo {
  id: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  fee: number;
  timestamp: number;
}

// Rewards types
export interface UserEarning {
  date: string;
  conditionId: string;
  assetAddress: string;
  makerAddress: string;
  earnings: number;
  assetRate: number;
}

export interface MarketReward {
  conditionId: string;
  question: string;
  marketSlug: string;
  eventSlug: string;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  tokens: Array<{ tokenId: string; outcome: string; price: number }>;
  rewardsConfig: Array<{
    assetAddress: string;
    startDate: string;
    endDate: string;
    ratePerDay: number;
    totalRewards: number;
  }>;
}

// ============================================================================
// Response helpers
// ============================================================================

/**
 * Shape clob-client-v2 returns instead of throwing when the API rejects a
 * request (the client is constructed without `throwOnError`).
 */
interface ClobErrorBody {
  error?: string;
  status?: number;
}

/**
 * Normalize a clob-client-v2 `OrderResponse` into our `OrderResult`.
 *
 * v2 dropped the `orderIDs` array that v1 returned and added `tradeIDs`. It
 * also reports API failures as `{ error, status }` objects rather than throwing
 * (this client is constructed without `throwOnError`), so an error body arrives
 * here as a response with no `orderID`.
 */
function toOrderResult(result: OrderResponse): OrderResult {
  // On the error path the body is `{ error, status }` — note that `status`
  // there is an HTTP code, whereas on a successful `OrderResponse` it is the
  // order status string. Only read it inside this branch.
  const errorBody = result as unknown as ClobErrorBody;
  if (errorBody?.error) {
    return {
      success: false,
      errorMsg: `${errorBody.error}${errorBody.status ? ` (HTTP ${errorBody.status})` : ''}`,
    };
  }

  const success =
    result.success === true ||
    (result.success !== false &&
      ((result.orderID !== undefined && result.orderID !== '') ||
        (result.transactionsHashes !== undefined && result.transactionsHashes.length > 0)));

  return {
    success,
    orderId: result.orderID,
    // v2 posts one order per call, so the plural form kept for backward
    // compatibility carries at most a single ID.
    orderIds: result.orderID ? [result.orderID] : undefined,
    errorMsg: result.errorMsg,
    transactionHashes: result.transactionsHashes,
    tradeIds: result.tradeIDs,
  };
}

/** Turn a thrown value into a message, unwrapping v2's `ApiError` extras. */
function describeClobError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Normalize a cancel response. The CLOB answers with
 * `{ canceled: string[], not_canceled: Record<string, string> }`; v1 callers
 * relied on `result.canceled` being truthy, which was also true for an empty
 * array. Here `success` means at least one order was actually cancelled and
 * none were rejected.
 */
function toCancelResult(
  result: { canceled?: string[]; not_canceled?: Record<string, string> } & ClobErrorBody,
  label: string
): OrderResult {
  if (result?.error) {
    return {
      success: false,
      errorMsg: `${label}: ${result.error}${result.status ? ` (HTTP ${result.status})` : ''}`,
    };
  }

  const canceled = Array.isArray(result?.canceled) ? result.canceled : [];
  const notCanceled = result?.not_canceled ?? {};
  const rejections = Object.entries(notCanceled);

  if (rejections.length > 0) {
    return {
      success: false,
      errorMsg: `${label}: ${rejections.map(([id, reason]) => `${id}: ${reason}`).join('; ')}`,
    };
  }

  return { success: canceled.length > 0 };
}

/**
 * Smallest approval across the spender contracts in v2's `allowances` map.
 * Returns `'0'` for an empty map, which is the correct conservative reading:
 * nothing has been approved.
 */
function minAllowance(allowances: Record<string, string>): string {
  const values = Object.values(allowances);
  if (values.length === 0) return '0';

  return values.reduce((smallest, current) => {
    try {
      return BigInt(current) < BigInt(smallest) ? current : smallest;
    } catch {
      // Non-numeric (e.g. "unlimited") — fall back to string comparison rather
      // than throwing away the whole lookup.
      return current < smallest ? current : smallest;
    }
  });
}

/**
 * v2 returns API errors as `{ error, status }` objects rather than throwing, so
 * a failed list request arrives where an array was expected.
 */
function assertArrayResponse(value: unknown, method: string): asserts value is unknown[] {
  if (Array.isArray(value)) return;

  const body = value as { error?: string; status?: number } | undefined;
  throw new PolymarketError(
    ErrorCode.INVALID_RESPONSE,
    `${method} failed: ${body?.error ?? 'unexpected response'}${
      body?.status ? ` (HTTP ${body.status})` : ''
    }`
  );
}

// ============================================================================
// TradingService Implementation
// ============================================================================

export class TradingService {
  private clobClient: ClobClient | null = null;
  private wallet: Wallet;
  private chainId: Chain;
  private host: string;
  private credentials: ApiCredentials | null = null;
  private initialized = false;
  private tickSizeCache: Map<string, string> = new Map();
  private negRiskCache: Map<string, boolean> = new Map();

  constructor(
    private rateLimiter: RateLimiter,
    private cache: UnifiedCache,
    private config: TradingServiceConfig
  ) {
    this.wallet = new Wallet(config.privateKey);
    this.chainId = (config.chainId || POLYGON_MAINNET) as Chain;
    this.host = config.host || CLOB_HOST;
    this.credentials = config.credentials || null;
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Options shared by both the L1-only and the fully-authenticated client.
   *
   * The signer is an ethers v5 `Wallet`. clob-client-v2 accepts either a viem
   * `WalletClient` or anything exposing `_signTypedData`/`getAddress`, and the
   * rest of this codebase (swap, approvals, on-chain reads) is on ethers v5,
   * so we keep one wallet object for everything.
   */
  private clientOptions() {
    return {
      host: this.host,
      chain: this.chainId,
      signer: this.wallet,
      signatureType: this.config.signatureType ?? SignatureTypeV2.EOA,
      ...(this.config.funderAddress ? { funderAddress: this.config.funderAddress } : {}),
      retryOnError: this.config.retryOnError ?? true,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create CLOB client with L1 auth (wallet)
    this.clobClient = new ClobClient(this.clientOptions());

    // Get or create API credentials
    // We use derive-first strategy (opposite of official createOrDeriveApiKey)
    // because most users already have a key, avoiding unnecessary 400 error logs.
    if (!this.credentials) {
      const creds = await this.deriveOrCreateApiKey();
      this.credentials = {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      };
    }

    // Re-initialize with L2 auth (credentials)
    this.clobClient = new ClobClient({
      ...this.clientOptions(),
      creds: {
        key: this.credentials.key,
        secret: this.credentials.secret,
        passphrase: this.credentials.passphrase,
      },
    });

    this.initialized = true;
  }

  /**
   * Try to derive existing API key first, create new one if not exists.
   * This is the reverse of official createOrDeriveApiKey() to avoid
   * 400 "Could not create api key" error log for existing keys.
   */
  private async deriveOrCreateApiKey(): Promise<ApiKeyCreds> {
    // v2 returns errors as `{ error, status }` objects rather than throwing
    // (unless `throwOnError` is set), so a failed derive shows up as a response
    // with no `key` rather than as an exception.
    const derived = await this.clobClient!.deriveApiKey();
    if (derived?.key) {
      return derived;
    }

    // Derive failed (key doesn't exist), create new key (first-time users)
    const created = await this.clobClient!.createApiKey();
    if (!created?.key) {
      throw new PolymarketError(
        ErrorCode.AUTH_FAILED,
        'Failed to create or derive API key. Wallet may not be registered on Polymarket, ' +
          'or the request was geoblocked — run `npm run check:vpn` to verify your exit IP.'
      );
    }
    return created;
  }

  private async ensureInitialized(): Promise<ClobClient> {
    if (!this.initialized || !this.clobClient) {
      await this.initialize();
    }
    return this.clobClient!;
  }

  // ============================================================================
  // Trading Helpers
  // ============================================================================

  /**
   * Get tick size for a token
   */
  async getTickSize(tokenId: string): Promise<TickSize> {
    if (this.tickSizeCache.has(tokenId)) {
      return this.tickSizeCache.get(tokenId)! as TickSize;
    }

    const client = await this.ensureInitialized();
    const tickSize = await client.getTickSize(tokenId);
    this.tickSizeCache.set(tokenId, tickSize);
    return tickSize;
  }

  /**
   * Check if token is neg risk
   */
  async isNegRisk(tokenId: string): Promise<boolean> {
    if (this.negRiskCache.has(tokenId)) {
      return this.negRiskCache.get(tokenId)!;
    }

    const client = await this.ensureInitialized();
    const negRisk = await client.getNegRisk(tokenId);
    this.negRiskCache.set(tokenId, negRisk);
    return negRisk;
  }

  // ============================================================================
  // Order Creation
  // ============================================================================

  /**
   * Create and post a limit order
   *
   * Note: Polymarket enforces minimum order requirements:
   * - Minimum size: 5 shares (MIN_ORDER_SIZE_SHARES)
   * - Minimum value: $1 USDC (MIN_ORDER_VALUE_USDC)
   *
   * Orders below these limits will be rejected by the API.
   */
  async createLimitOrder(params: LimitOrderParams): Promise<OrderResult> {
    // Validate minimum order requirements before sending to API
    if (params.size < MIN_ORDER_SIZE_SHARES) {
      return {
        success: false,
        errorMsg: `Order size (${params.size}) is below Polymarket minimum (${MIN_ORDER_SIZE_SHARES} shares)`,
      };
    }

    const orderValue = params.price * params.size;
    if (orderValue < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order value ($${orderValue.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const [tickSize, negRisk] = await Promise.all([
          this.getTickSize(params.tokenId),
          this.isNegRisk(params.tokenId),
        ]);

        const orderType = params.orderType === 'GTD' ? ClobOrderType.GTD : ClobOrderType.GTC;

        const result = await client.createAndPostOrder(
          {
            tokenID: params.tokenId,
            side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
            price: params.price,
            size: params.size,
            expiration: params.expiration || 0,
          },
          { tickSize, negRisk },
          orderType
        );

        return toOrderResult(result);
      } catch (error) {
        return {
          success: false,
          errorMsg: `Order failed: ${describeClobError(error)}`,
        };
      }
    });
  }

  /**
   * Create and post a market order
   *
   * Note: Polymarket enforces minimum order requirements:
   * - Minimum value: $1 USDC (MIN_ORDER_VALUE_USDC)
   *
   * Market orders below this limit will be rejected by the API.
   */
  async createMarketOrder(params: MarketOrderParams): Promise<OrderResult> {
    // Validate minimum order value before sending to API
    if (params.amount < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order amount ($${params.amount.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const [tickSize, negRisk] = await Promise.all([
          this.getTickSize(params.tokenId),
          this.isNegRisk(params.tokenId),
        ]);

        const orderType = params.orderType === 'FAK' ? ClobOrderType.FAK : ClobOrderType.FOK;

        const result = await client.createAndPostMarketOrder(
          {
            tokenID: params.tokenId,
            side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
            amount: params.amount,
            price: params.price,
            // v2 uses this to pick the marketable price when `price` is absent,
            // so it has to match the order type passed below.
            orderType,
          },
          { tickSize, negRisk },
          orderType
        );

        return toOrderResult(result);
      } catch (error) {
        return {
          success: false,
          errorMsg: `Market order failed: ${describeClobError(error)}`,
        };
      }
    });
  }

  // ============================================================================
  // Order Management
  // ============================================================================

  async cancelOrder(orderId: string): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrder({ orderID: orderId });
        return { ...toCancelResult(result, 'Cancel failed'), orderId };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel failed: ${describeClobError(error)}`
        );
      }
    });
  }

  async cancelOrders(orderIds: string[]): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrders(orderIds);
        return { ...toCancelResult(result, 'Cancel orders failed'), orderIds };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel orders failed: ${describeClobError(error)}`
        );
      }
    });
  }

  async cancelAllOrders(): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelAll();
        return toCancelResult(result, 'Cancel all failed');
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel all failed: ${describeClobError(error)}`
        );
      }
    });
  }

  async getOpenOrders(marketId?: string): Promise<Order[]> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const orders = await client.getOpenOrders(marketId ? { market: marketId } : undefined);
      assertArrayResponse(orders, 'getOpenOrders');

      return orders.map((o: OpenOrder) => {
        const originalSize = Number(o.original_size) || 0;
        const filledSize = Number(o.size_matched) || 0;
        return {
          id: o.id,
          status: o.status,
          tokenId: o.asset_id,
          side: o.side.toUpperCase() as Side,
          price: Number(o.price) || 0,
          originalSize,
          filledSize,
          remainingSize: originalSize - filledSize,
          associateTrades: o.associate_trades || [],
          createdAt: o.created_at,
        };
      });
    });
  }

  async getTrades(marketId?: string): Promise<TradeInfo[]> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const trades = await client.getTrades(marketId ? { market: marketId } : undefined);
      assertArrayResponse(trades, 'getTrades');

      return trades.map((t: ClobTrade) => ({
        id: t.id,
        tokenId: t.asset_id,
        side: t.side as Side,
        price: Number(t.price) || 0,
        size: Number(t.size) || 0,
        fee: Number(t.fee_rate_bps) || 0,
        timestamp: Number(t.match_time) || Date.now(),
      }));
    });
  }

  // ============================================================================
  // Rewards
  // ============================================================================

  async isOrderScoring(orderId: string): Promise<boolean> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.isOrderScoring({ order_id: orderId });
      return result.scoring;
    });
  }

  async areOrdersScoring(orderIds: string[]): Promise<Record<string, boolean>> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      return await client.areOrdersScoring({ orderIds });
    });
  }

  async getEarningsForDay(date: string): Promise<UserEarning[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const earnings = await client.getEarningsForUserForDay(date);
      assertArrayResponse(earnings, 'getEarningsForUserForDay');
      return earnings.map(e => ({
        date: e.date,
        conditionId: e.condition_id,
        assetAddress: e.asset_address,
        makerAddress: e.maker_address,
        earnings: e.earnings,
        assetRate: e.asset_rate,
      }));
    });
  }

  async getCurrentRewards(): Promise<MarketReward[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const rewards = await client.getCurrentRewards();
      assertArrayResponse(rewards, 'getCurrentRewards');
      return rewards.map(r => ({
        conditionId: r.condition_id,
        question: r.question,
        marketSlug: r.market_slug,
        eventSlug: r.event_slug,
        rewardsMaxSpread: r.rewards_max_spread,
        rewardsMinSize: r.rewards_min_size,
        tokens: r.tokens.map(t => ({
          tokenId: t.token_id,
          outcome: t.outcome,
          price: t.price,
        })),
        rewardsConfig: r.rewards_config.map(c => ({
          assetAddress: c.asset_address,
          startDate: c.start_date,
          endDate: c.end_date,
          ratePerDay: c.rate_per_day,
          totalRewards: c.total_rewards,
        })),
      }));
    });
  }

  // ============================================================================
  // Balance & Allowance
  // ============================================================================

  /**
   * Balance and allowance for collateral (USDC) or a conditional token.
   *
   * clob-client-v2 replaced v1's single `allowance` string with an
   * `allowances` map keyed by spender contract (the CTF exchange, the neg-risk
   * exchange, and so on). `allowance` is kept for backward compatibility and
   * reports the **smallest** approval in that map, because an order routed
   * through the least-approved exchange is the one that fails. Read
   * `allowances` when you need the per-contract breakdown.
   */
  async getBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<{ balance: string; allowance: string; allowances: Record<string, string> }> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.getBalanceAllowance({
        asset_type: assetType === 'CONDITIONAL' ? AssetType.CONDITIONAL : AssetType.COLLATERAL,
        token_id: tokenId,
      });

      const body = result as typeof result & { error?: string; status?: number };
      if (body?.error) {
        throw new PolymarketError(
          ErrorCode.INVALID_RESPONSE,
          `getBalanceAllowance failed: ${body.error}${body.status ? ` (HTTP ${body.status})` : ''}`
        );
      }

      const allowances = result.allowances ?? {};

      return {
        balance: result.balance,
        allowance: minAllowance(allowances),
        allowances,
      };
    });
  }

  async updateBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<void> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      await client.updateBalanceAllowance({
        asset_type: assetType === 'CONDITIONAL' ? AssetType.CONDITIONAL : AssetType.COLLATERAL,
        token_id: tokenId,
      });
    });
  }

  // ============================================================================
  // Account Info
  // ============================================================================

  getAddress(): string {
    return this.wallet.address;
  }

  getWallet(): Wallet {
    return this.wallet;
  }

  getCredentials(): ApiCredentials | null {
    return this.credentials;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getClobClient(): ClobClient | null {
    return this.clobClient;
  }

}
