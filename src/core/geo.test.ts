import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkGeo, assertTradingRegion, formatGeoResult, DEFAULT_BLOCKED_COUNTRIES } from './geo.js';

const REAL_FETCH = globalThis.fetch;

/** Minimal `fetch` stand-in that answers by URL substring. */
function stubFetch(routes: Record<string, { status?: number; body?: unknown } | Error>): void {
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    const match = Object.keys(routes).find(key => url.includes(key));

    if (!match) throw new Error(`unexpected request to ${url}`);
    const route = routes[match]!;
    if (route instanceof Error) throw route;

    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body,
    } as Response;
  }) as typeof fetch;
}

const NL = { ip: '203.0.113.10', country: 'Netherlands', country_code: 'NL' };
const IN = { ip: '198.51.100.7', country: 'India', country_code: 'IN' };

describe('checkGeo', () => {
  beforeEach(() => {
    delete process.env.BLOCKED_COUNTRIES;
  });

  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
    delete process.env.BLOCKED_COUNTRIES;
  });

  it('passes when the exit is in a permitted country and the CLOB answers', async () => {
    stubFetch({
      'ipwho.is': { body: NL },
      'ipapi.co': { body: { ip: NL.ip, country_name: 'Netherlands', country_code: 'NL' } },
      'clob.polymarket.com': { status: 200 },
    });

    const result = await checkGeo();

    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.clobReachable).toBe(true);
    expect(result.exitIp?.countryCode).toBe('NL');
    expect(result.problems).toEqual([]);
  });

  it('fails when the exit IP is in a restricted country', async () => {
    stubFetch({
      'ipwho.is': { body: IN },
      'ipapi.co': { body: { ip: IN.ip, country_name: 'India', country_code: 'IN' } },
      'clob.polymarket.com': { status: 200 },
    });

    const result = await checkGeo();

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.problems.join(' ')).toMatch(/India \(IN\).*restricts/);
  });

  it('flags a leak when two lookups report different exit IPs', async () => {
    stubFetch({
      'ipwho.is': { body: NL },
      'ipapi.co': { body: { ip: '198.51.100.99', country_name: 'India', country_code: 'IN' } },
      'clob.polymarket.com': { status: 200 },
    });

    const result = await checkGeo();

    expect(result.inconsistent).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/partially tunnelled/);
  });

  it('reports the CLOB as unreachable when it does not answer', async () => {
    stubFetch({
      'ipwho.is': { body: NL },
      'ipapi.co': { body: { ip: NL.ip, country_name: 'Netherlands', country_code: 'NL' } },
      'clob.polymarket.com': new Error('ECONNREFUSED'),
    });

    const result = await checkGeo();

    expect(result.clobReachable).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('reports a dead tunnel when no lookup can be reached', async () => {
    stubFetch({
      'ipwho.is': new Error('ETIMEDOUT'),
      'ipapi.co': new Error('ETIMEDOUT'),
      'clob.polymarket.com': { status: 200 },
    });

    const result = await checkGeo();

    expect(result.ok).toBe(false);
    expect(result.exitIp).toBeNull();
    expect(result.problems.join(' ')).toMatch(/Exit IP lookup failed/);
  });

  it('falls through to the second lookup when the first is down', async () => {
    stubFetch({
      'ipwho.is': new Error('ETIMEDOUT'),
      'ipapi.co': { body: { ip: NL.ip, country_name: 'Netherlands', country_code: 'NL' } },
      'clob.polymarket.com': { status: 200 },
    });

    const result = await checkGeo();

    expect(result.source).toBe('ipapi.co');
    expect(result.exitIp?.countryCode).toBe('NL');
    expect(result.ok).toBe(true);
  });

  it('honours a BLOCKED_COUNTRIES override', async () => {
    process.env.BLOCKED_COUNTRIES = 'NL';
    stubFetch({
      'ipwho.is': { body: NL },
      'ipapi.co': { body: { ip: NL.ip, country_name: 'Netherlands', country_code: 'NL' } },
      'clob.polymarket.com': { status: 200 },
    });

    const result = await checkGeo();
    expect(result.blocked).toBe(true);
  });

  it('disables the country check when BLOCKED_COUNTRIES is empty', async () => {
    process.env.BLOCKED_COUNTRIES = '';
    stubFetch({
      'ipwho.is': { body: IN },
      'ipapi.co': { body: { ip: IN.ip, country_name: 'India', country_code: 'IN' } },
      'clob.polymarket.com': { status: 200 },
    });

    const result = await checkGeo();
    expect(result.blocked).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('lists India among the default restricted countries', () => {
    expect(DEFAULT_BLOCKED_COUNTRIES).toContain('IN');
    expect(DEFAULT_BLOCKED_COUNTRIES).toContain('US');
  });
});

describe('assertTradingRegion', () => {
  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
    delete process.env.SKIP_GEO_CHECK;
  });

  it('throws when the exit country is restricted', async () => {
    stubFetch({
      'ipwho.is': { body: IN },
      'ipapi.co': { body: { ip: IN.ip, country_name: 'India', country_code: 'IN' } },
      'clob.polymarket.com': { status: 200 },
    });

    await expect(assertTradingRegion()).rejects.toThrow(/refusing to trade/);
  });

  it('returns instead of throwing when SKIP_GEO_CHECK is set', async () => {
    process.env.SKIP_GEO_CHECK = 'true';
    stubFetch({
      'ipwho.is': { body: IN },
      'ipapi.co': { body: { ip: IN.ip, country_name: 'India', country_code: 'IN' } },
      'clob.polymarket.com': { status: 200 },
    });

    const result = await assertTradingRegion();
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it('resolves when everything is in order', async () => {
    stubFetch({
      'ipwho.is': { body: NL },
      'ipapi.co': { body: { ip: NL.ip, country_name: 'Netherlands', country_code: 'NL' } },
      'clob.polymarket.com': { status: 200 },
    });

    await expect(assertTradingRegion()).resolves.toMatchObject({ ok: true });
  });
});

describe('formatGeoResult', () => {
  it('summarises a passing check on one line', async () => {
    stubFetch({
      'ipwho.is': { body: NL },
      'ipapi.co': { body: { ip: NL.ip, country_name: 'Netherlands', country_code: 'NL' } },
      'clob.polymarket.com': { status: 200 },
    });

    const line = formatGeoResult(await checkGeo());
    globalThis.fetch = REAL_FETCH;

    expect(line).toContain('✓');
    expect(line).toContain('203.0.113.10');
    expect(line).toContain('Netherlands');
    expect(line).toContain('CLOB reachable');
  });
});
