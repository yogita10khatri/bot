/**
 * End-to-end check of the `fetch` (undici) proxy path.
 *
 * This is the transport used by the Gamma API, the Data API and the subgraph
 * client. undici ignores `https.globalAgent`, so it needs its own dispatcher —
 * and a misconfigured dispatcher fails silently by sending the request
 * directly, which is precisely the leak this whole module exists to prevent.
 *
 * Rather than trusting the wiring, these tests stand up a real SOCKS5 server
 * and assert that traffic actually passes through it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import https from 'https';
import net from 'net';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { installProxy, resetProxyStateForTests } from './proxy.js';

const ORIGINAL_HTTP_AGENT = http.globalAgent;
const ORIGINAL_HTTPS_AGENT = https.globalAgent;
const ORIGINAL_DISPATCHER = getGlobalDispatcher();

function restoreGlobals(): void {
  http.globalAgent = ORIGINAL_HTTP_AGENT;
  https.globalAgent = ORIGINAL_HTTPS_AGENT;
  setGlobalDispatcher(ORIGINAL_DISPATCHER);
  resetProxyStateForTests();
}

/**
 * Minimal SOCKS5 server: no-auth handshake, CONNECT only.
 *
 * Records every destination it is asked for, so a test can prove that traffic
 * went through it and arrived with the right host and port. Name resolution is
 * stubbed to loopback — the point is to observe the tunnel, not to resolve DNS.
 */
function createSocks5Server(): Promise<{
  port: number;
  destinations: () => Array<{ host: string; port: number }>;
  close: () => Promise<void>;
}> {
  const destinations: Array<{ host: string; port: number }> = [];

  const server = net.createServer(client => {
    client.once('data', greeting => {
      // Client greeting: VER=0x05, NMETHODS, METHODS...
      if (greeting[0] !== 0x05) return client.destroy();
      client.write(Buffer.from([0x05, 0x00])); // no authentication required

      client.once('data', request => {
        // Request: VER, CMD, RSV, ATYP, ADDR, PORT
        const [version, command, , addressType] = request;
        if (version !== 0x05 || command !== 0x01) return client.destroy();

        let host: string;
        let offset: number;
        if (addressType === 0x01) {
          host = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
          offset = 8;
        } else if (addressType === 0x03) {
          const length = request[4]!;
          host = request.subarray(5, 5 + length).toString();
          offset = 5 + length;
        } else {
          return client.destroy();
        }
        const port = request.readUInt16BE(offset);
        destinations.push({ host, port });

        // Every origin in these tests is on loopback; resolving the requested
        // name is not what is under test.
        const upstream = net.connect(port, '127.0.0.1', () => {
          // Success reply with a dummy BND.ADDR/BND.PORT.
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
      });
    });

    client.on('error', () => {
      /* client went away mid-handshake */
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        destinations: () => destinations,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

function createOriginServer(body: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(body);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

describe('fetch over a SOCKS5 proxy', () => {
  afterEach(restoreGlobals);

  it('routes global fetch through the proxy for non-bypassed hosts', async () => {
    const socks = await createSocks5Server();
    const origin = await createOriginServer('through-the-proxy');

    try {
      installProxy({
        url: `socks5://127.0.0.1:${socks.port}`,
        // 127.0.0.1 is bypassed by default, so address the origin by a name
        // that resolves to it but is not on the bypass list.
        bypass: [],
      });

      // A hostname that is not on the bypass list, so it takes the proxied
      // path. The stub proxy relays it to the loopback origin.
      const response = await fetch(`http://origin.test:${origin.port}/`);
      const body = await response.text();

      expect(body).toBe('through-the-proxy');
      // Proof the request went through the tunnel, with the destination intact.
      expect(socks.destinations()).toEqual([{ host: 'origin.test', port: origin.port }]);
    } finally {
      await origin.close();
      await socks.close();
    }
  });

  it('sends bypassed hosts directly, without touching the proxy', async () => {
    // Proxy port with nothing listening: if the bypass fails, so does the fetch.
    const origin = await createOriginServer('direct');

    try {
      installProxy({ url: 'socks5://127.0.0.1:1' });

      const response = await fetch(`http://127.0.0.1:${origin.port}/`);
      expect(await response.text()).toBe('direct');
    } finally {
      await origin.close();
    }
  });

  it('fails the fetch when the proxy is unreachable, rather than leaking direct', async () => {
    const origin = await createOriginServer('should-not-be-reachable');

    try {
      installProxy({ url: 'socks5://127.0.0.1:1', bypass: [] });

      await expect(fetch(`http://origin.test:${origin.port}/`)).rejects.toThrow();
    } finally {
      await origin.close();
    }
  });
});
