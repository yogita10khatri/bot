import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import https from 'https';
import net from 'net';
import { getProxyUrlFromEnv, installProxy, getInstalledProxy, redact, resetProxyStateForTests } from './proxy.js';

// installProxy() mutates process-wide globals, so every test that calls it has
// to put them back.
const ORIGINAL_HTTP_AGENT = http.globalAgent;
const ORIGINAL_HTTPS_AGENT = https.globalAgent;

function restoreGlobals(): void {
  http.globalAgent = ORIGINAL_HTTP_AGENT;
  https.globalAgent = ORIGINAL_HTTPS_AGENT;
  resetProxyStateForTests();
}

describe('getProxyUrlFromEnv', () => {
  it('returns undefined when nothing is configured', () => {
    expect(getProxyUrlFromEnv({})).toBeUndefined();
  });

  it('prefers PROXY_URL over the conventional proxy variables', () => {
    expect(
      getProxyUrlFromEnv({
        HTTPS_PROXY: 'http://fallback:8080',
        PROXY_URL: 'socks5://chosen:1080',
      })
    ).toBe('socks5://chosen:1080');
  });

  it('falls back through ALL_PROXY, HTTPS_PROXY, HTTP_PROXY in order', () => {
    expect(getProxyUrlFromEnv({ HTTP_PROXY: 'http://c:3' })).toBe('http://c:3');
    expect(getProxyUrlFromEnv({ HTTPS_PROXY: 'http://b:2', HTTP_PROXY: 'http://c:3' })).toBe('http://b:2');
    expect(
      getProxyUrlFromEnv({ ALL_PROXY: 'socks5://a:1', HTTPS_PROXY: 'http://b:2' })
    ).toBe('socks5://a:1');
  });

  it('ignores empty and whitespace-only values', () => {
    expect(getProxyUrlFromEnv({ PROXY_URL: '   ', HTTPS_PROXY: 'http://real:8080' })).toBe(
      'http://real:8080'
    );
  });
});

describe('redact', () => {
  it('hides the password but keeps the host visible', () => {
    expect(redact('socks5://alice:hunter2@proxy.example:1080')).toBe(
      'socks5://alice:****@proxy.example:1080'
    );
  });

  it('leaves credential-free URLs untouched', () => {
    expect(redact('socks5://proxy.example:1080')).toBe('socks5://proxy.example:1080');
  });
});

describe('installProxy', () => {
  afterEach(restoreGlobals);

  it('is a no-op when no proxy is configured', () => {
    const result = installProxy({ url: undefined });
    // No PROXY_URL in the test environment, so this must not patch anything.
    if (!getProxyUrlFromEnv()) {
      expect(result).toBeNull();
      expect(http.globalAgent).toBe(ORIGINAL_HTTP_AGENT);
      expect(https.globalAgent).toBe(ORIGINAL_HTTPS_AGENT);
    }
  });

  it('patches the http and https global agents', () => {
    installProxy({ url: 'socks5://127.0.0.1:1080' });
    expect(http.globalAgent).not.toBe(ORIGINAL_HTTP_AGENT);
    expect(https.globalAgent).not.toBe(ORIGINAL_HTTPS_AGENT);
  });

  it('reports the proxy with the password redacted', () => {
    const info = installProxy({ url: 'socks5://alice:hunter2@127.0.0.1:1080' });
    expect(info?.kind).toBe('socks');
    expect(info?.host).toBe('127.0.0.1');
    expect(info?.port).toBe(1080);
    expect(info?.url).not.toContain('hunter2');
    expect(getInstalledProxy()).toEqual(info);
  });

  it('recognises http proxies', () => {
    const info = installProxy({ url: 'http://127.0.0.1:8080' });
    expect(info?.kind).toBe('http');
    expect(info?.port).toBe(8080);
  });

  it('defaults a scheme-less value to SOCKS5 on port 1080', () => {
    const info = installProxy({ url: '127.0.0.1' });
    expect(info?.kind).toBe('socks');
    expect(info?.port).toBe(1080);
  });

  it('always bypasses loopback so the local dashboard stays reachable', () => {
    const info = installProxy({ url: 'socks5://127.0.0.1:1080' });
    expect(info?.bypass).toContain('localhost');
    expect(info?.bypass).toContain('127.0.0.1');
  });

  it('includes caller-supplied bypass hosts, normalised', () => {
    const info = installProxy({ url: 'socks5://127.0.0.1:1080', bypass: ['.Internal.Example'] });
    expect(info?.bypass).toContain('internal.example');
  });

  it('is idempotent — the first call wins', () => {
    const first = installProxy({ url: 'socks5://127.0.0.1:1080' });
    const second = installProxy({ url: 'http://127.0.0.1:9999' });
    expect(second).toBe(first);
    expect(second?.port).toBe(1080);
  });

  it('rejects an unsupported scheme', () => {
    expect(() => installProxy({ url: 'ftp://127.0.0.1:21' })).toThrow(/Unsupported proxy scheme/);
  });
});

describe('proxy agent routing', () => {
  afterEach(restoreGlobals);

  it('sends a bypassed host directly, without touching the proxy', async () => {
    // A real local server, and a proxy port with nothing listening on it. If
    // the bypass works the request succeeds; if it does not, the connection to
    // the dead proxy fails.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('direct');
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    try {
      installProxy({ url: 'socks5://127.0.0.1:1' }); // port 1: nothing there

      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/' }, res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('timed out')));
      });

      expect(body).toBe('direct');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('routes a non-bypassed host through the proxy, so a dead proxy fails the request', async () => {
    installProxy({ url: 'socks5://127.0.0.1:1' }); // port 1: nothing there

    await expect(
      new Promise<void>((resolve, reject) => {
        const req = http.get({ host: 'example.com', port: 80, path: '/' }, () => resolve());
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('timed out')));
      })
    ).rejects.toThrow();
  });
});
