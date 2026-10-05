/**
 * Connection pinning and the built-in HTTP client, on real sockets. Nothing in the request path
 * is stubbed: the real transport (src/utils/pinned-request.ts) talks to HTTP servers this file
 * starts on loopback. The only stand-in is the resolver, passed in as `lookup`, which is how a
 * test plays the part of a hostile DNS server.
 *
 * No packet leaves the machine. Every address a socket can be sent to here is a loopback
 * address, so the tests that need a connection run with the local-development opt-out set
 * (SEO_TOOLKIT_ALLOW_PRIVATE=1, passed in as `env`). The pin is the same code with or without
 * the opt-out: the opt-out only skips the public-address check.
 *
 * How the pin is proven without a public address: two servers, A and B, listen on the SAME
 * port on two DIFFERENT loopback addresses. The resolver answers A's address when the guard
 * asks, and B's address if anything asks again. "The socket went to an address that was not
 * checked" is then visible as "server B was reached".
 *
 * Above each test: the change that turns it red.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { safeFetch, BlockedUrlError, ResponseTooLargeError, MAX_RESPONSE_BYTES, type LookupFn } from "../src/utils/safe-fetch.js";
import { pinnedLookup } from "../src/utils/pinned-request.js";

const ALLOW = { SEO_TOOLKIT_ALLOW_PRIVATE: "1" };
const GUARD_ON = {};
const ADDRESS_A = "127.0.0.1";

interface Site {
  server: Server;
  hits: string[];
  headers: IncomingHttpHeaders[];
  open: Set<Socket>;
}
let a: Site;
let b: Site | undefined;
let addressB = "";
let port = 0;

const noise = randomBytes(12000); // does not compress, so "cut by 30 bytes" cuts real payload
const cut = (buffer: Buffer) => buffer.subarray(0, buffer.length - 30);

function site(name: string): Site {
  const made: Site = { server: createServer(), hits: [], headers: [], open: new Set() };
  made.server.on("connection", (socket) => {
    made.open.add(socket);
    socket.on("close", () => made.open.delete(socket));
  });
  made.server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    made.hits.push(`${req.method} ${req.url} host=${req.headers.host}`);
    made.headers.push(req.headers);
    const path = req.url ?? "/";
    const sendWhole = (headers: Record<string, string>, body: Buffer) => res.writeHead(200, { ...headers, "content-length": String(body.length) }).end(body);
    if (path === "/gzip") sendWhole({ "content-encoding": "gzip" }, gzipSync("gzip body ok"));
    else if (path === "/br") sendWhole({ "content-encoding": "br" }, brotliCompressSync("brotli body ok"));
    else if (path === "/deflate") sendWhole({ "content-encoding": "deflate" }, deflateSync("deflate body ok"));
    else if (path === "/gzip-whole") sendWhole({ "content-encoding": "gzip" }, gzipSync(noise));
    else if (path === "/gzip-cut") sendWhole({ "content-encoding": "gzip" }, cut(gzipSync(noise)));
    else if (path === "/br-cut") sendWhole({ "content-encoding": "br" }, cut(brotliCompressSync(noise)));
    else if (path === "/deflate-cut") sendWhole({ "content-encoding": "deflate" }, cut(deflateSync(noise)));
    else if (path === "/gzip-empty") sendWhole({ "content-encoding": "gzip" }, Buffer.alloc(0));
    else if (path === "/gzip-empty-chunked") res.writeHead(200, { "content-encoding": "gzip" }).end();
    else if (path === "/zstd") sendWhole({ "content-encoding": "zstd" }, Buffer.from("not really zstd"));
    else if (path === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.on("error", () => {});
      const chunk = Buffer.alloc(1024 * 1024, 97);
      let sent = 0;
      const pump = () => {
        while (sent < 6 && !res.destroyed) {
          sent++;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    } else if (path === "/bomb") {
      sendWhole({ "content-encoding": "gzip" }, gzipSync(Buffer.alloc(8 * 1024 * 1024, 0))); // ~8 KB on the wire, 8 MB decoded
    } else if (path === "/slow") {
      // never answers
    } else if (path === "/redirect-b") {
      res.writeHead(302, { location: `http://b.example.test:${port}/landed` }).end("moved");
    } else if (path === "/redirect-held") {
      res.writeHead(302, { location: "/count-open" }).write("this body is never finished");
    } else if (path === "/redirect-held-slow") {
      res.writeHead(302, { location: "/slow" }).write("this body is never finished");
    } else if (path === "/count-open") {
      setTimeout(() => res.writeHead(200).end(`open=${made.open.size}`), 100);
    } else if (path === "/declared-big") {
      res.writeHead(200, { "content-length": String(MAX_RESPONSE_BYTES * 2) }).write("x"); // and then nothing
    } else if (path === "/redirect-same") {
      res.writeHead(302, { location: "/landed" }).end("moved");
    } else if (path === "/img.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(MAX_RESPONSE_BYTES * 2) }).end();
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(`server=${name} host=${req.headers.host} path=${path}`);
    }
  });
  return made;
}

const listen = (server: Server, host: string, onPort: number) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(onPort, host, () => {
    server.off("error", reject);
    resolve((server.address() as AddressInfo).port);
  });
});
const close = (server: Server | undefined) => new Promise<void>((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections?.();
  server.close(() => resolve());
});
const urlHost = (address: string) => (address.includes(":") ? `[${address}]` : address);

/** A resolver that gives a different answer on each call; the last answer repeats. */
function sequenceLookup(...answers: string[][]) {
  const calls: string[] = [];
  const lookup: LookupFn = async (hostname) => {
    const answer = answers[Math.min(calls.length, answers.length - 1)];
    calls.push(hostname);
    return answer.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { lookup, calls };
}
/** A resolver with one fixed answer per hostname. */
function tableLookup(table: Record<string, string[]>) {
  const calls: string[] = [];
  const lookup: LookupFn = async (hostname) => {
    calls.push(hostname);
    const answer = table[hostname];
    if (!answer) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    return answer.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { lookup, calls };
}
const until = async (condition: () => boolean, ms = 1500) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  return condition();
};

beforeAll(async () => {
  a = site("A");
  port = await listen(a.server, ADDRESS_A, 0);
  // Server B: the same port on another loopback address (IPv6 loopback, else 127.0.0.2).
  for (const candidate of ["::1", "127.0.0.2"]) {
    const made = site("B");
    try {
      await listen(made.server, candidate, port);
      b = made;
      addressB = candidate;
      break;
    } catch {
      // not available on this machine: try the next one; with none, the A-versus-B tests skip by name
    }
  }
});
afterAll(async () => {
  await close(a.server);
  await close(b?.server);
});
beforeEach(() => {
  for (const s of [a, b]) {
    if (!s) continue;
    s.hits.length = 0;
    s.headers.length = 0;
  }
});

describe("the socket goes only to the address the guard was given", () => {
  // RED IF: the socket is connected to any address other than the one the guard resolved:
  //   - safe-fetch.ts looks the name up again after its check and pins THAT answer (the second
  //     answer is server B, so B is reached), or
  //   - the pinned `lookup` is dropped from the request in pinned-request.ts (the transport then
  //     asks the operating system, which does not know this name, and server A is never reached).
  it("rebinding: the resolver says A, then B. Only A is reached, and the name is resolved once", async (ctx) => {
    if (!b) return ctx.skip();
    const { lookup, calls } = sequenceLookup([ADDRESS_A], [addressB]);
    const res = await safeFetch(`http://rebind.example.test:${port}/`, {}, { lookup, env: ALLOW });
    expect(await res.text()).toBe(`server=A host=rebind.example.test:${port} path=/`);
    expect(b.hits).toEqual([]);
    expect(a.hits).toEqual([`GET / host=rebind.example.test:${port}`]);
    expect(calls).toEqual(["rebind.example.test"]);
  });

  // RED IF: the same, with the roles swapped, so the checked answer is the other address family
  // (IPv6 where this machine has IPv6 loopback). Catches a pin that only works for IPv4.
  it("rebinding the other way: the resolver says B, then A. Only B is reached", async (ctx) => {
    if (!b) return ctx.skip();
    const { lookup, calls } = sequenceLookup([addressB], [ADDRESS_A]);
    const res = await safeFetch(`http://rebind.example.test:${port}/`, {}, { lookup, env: ALLOW });
    expect(await res.text()).toBe(`server=B host=rebind.example.test:${port} path=/`);
    expect(a.hits).toEqual([]);
    expect(calls).toEqual(["rebind.example.test"]);
  });

  // RED IF: a redirect hop reuses the previous hop's addresses, or is resolved anywhere but the
  // injected lookup. Hop 1 resolves to A and hop 2 to B; with hop 1's pin reused, "/landed"
  // would arrive at server A.
  it("resolves and pins each redirect hop on its own", async (ctx) => {
    if (!b) return ctx.skip();
    const { lookup, calls } = tableLookup({ "a.example.test": [ADDRESS_A], "b.example.test": [addressB] });
    const res = await safeFetch(`http://a.example.test:${port}/redirect-b`, {}, { lookup, env: ALLOW });
    expect(await res.text()).toBe(`server=B host=b.example.test:${port} path=/landed`);
    expect(res.redirectCount).toBe(1);
    expect(calls).toEqual(["a.example.test", "b.example.test"]);
    expect(a.hits).toEqual([`GET /redirect-b host=a.example.test:${port}`]);
    expect(b.hits).toEqual([`GET /landed host=b.example.test:${port}`]);
  });

  // RED IF: an IP literal is not connected to as written (for IPv6: brackets left on).
  it("connects to an IP literal without asking the resolver", async (ctx) => {
    if (!b) return ctx.skip();
    const { lookup, calls } = tableLookup({});
    const res = await safeFetch(`http://${urlHost(addressB)}:${port}/`, {}, { lookup, env: ALLOW });
    expect(await res.text()).toBe(`server=B host=${urlHost(addressB)}:${port} path=/`);
    expect(calls).toEqual([]);
  });

  // RED IF: with the guard on (no opt-out), a hostname whose checked answer is loopback is
  // connected to anyway. Nothing is stubbed and the server is really listening.
  it("guard on: a hostname that resolves to loopback is refused before any connection", async () => {
    const { lookup } = tableLookup({ "rebind.example.test": [ADDRESS_A] });
    await expect(safeFetch(`http://rebind.example.test:${port}/`, {}, { lookup, env: GUARD_ON })).rejects.toThrow(BlockedUrlError);
    await expect(safeFetch(`http://${ADDRESS_A}:${port}/`, {}, { lookup, env: GUARD_ON })).rejects.toThrow(BlockedUrlError);
    expect(a.hits).toEqual([]);
  });

  // RED IF: the transport follows a redirect by itself.
  it('returns a 3xx untouched when redirect is "manual"', async () => {
    const { lookup } = tableLookup({ "a.example.test": [ADDRESS_A] });
    const res = await safeFetch(`http://a.example.test:${port}/redirect-b`, { redirect: "manual" }, { lookup, env: ALLOW });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("b.example.test");
    expect(a.hits.length).toBe(1);
  });
});

describe("pinnedLookup", () => {
  const ask = (addresses: Parameters<typeof pinnedLookup>[0], options: object) => new Promise<unknown[]>((resolve) => {
    (pinnedLookup(addresses) as unknown as (h: string, o: object, cb: (...args: unknown[]) => void) => void)("ignored.example", options, (...args) => resolve(args));
  });
  const both = [{ address: "8.8.8.8", family: 4 as const }, { address: "2606:4700:4700::1111", family: 6 as const }];

  // RED IF: the lookup consults the hostname it is given, returns an address that was not in the
  // checked list, or answers in the wrong shape for the `all` option net uses for happy eyeballs.
  it("answers only from the checked list, in both callback shapes", async () => {
    expect(await ask(both, { all: true })).toEqual([null, both]);
    expect(await ask(both, {})).toEqual([null, "8.8.8.8", 4]);
    expect(await ask(both, { all: false, family: 0 })).toEqual([null, "8.8.8.8", 4]);
  });

  // RED IF: an empty list falls through to a real DNS lookup instead of failing.
  it("fails when there is no checked address", async () => {
    const [error] = await ask([], { all: true });
    expect((error as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});

describe("the built-in client", () => {
  const table = () => tableLookup({ "site.example.test": [ADDRESS_A] });
  const get = (path: string, options = {}) => safeFetch(`http://site.example.test:${port}${path}`, options, { lookup: table().lookup, env: ALLOW });

  // RED IF: the matching decoder is removed from decoderFor() in pinned-request.ts, or the body is
  // handed back still compressed.
  it.each([["gzip", "/gzip", "gzip body ok"], ["brotli", "/br", "brotli body ok"], ["deflate", "/deflate", "deflate body ok"]])(
    "decodes %s and keeps the content-encoding header",
    async (_name, path, expected) => {
      const res = await get(path);
      expect(await res.text()).toBe(expected);
      expect(res.headers.get("content-encoding")).not.toBeNull();
    },
  );

  // RED IF: a decoder is created with a "sync flush" finish mode again (which accepts a stream
  // that stops early and returns whatever was decoded so far, or nothing).
  // The HTTP message itself is complete here (content-length matches); only the compressed
  // stream inside it is 30 bytes short.
  it.each([["gzip", "/gzip-cut"], ["brotli", "/br-cut"], ["deflate", "/deflate-cut"]])(
    "refuses a %s body that ends before the compressed stream does",
    async (_name, path) => {
      const settled = await get(path).then(async res => `served ${(await res.text()).length} bytes`, (e: Error) => `rejected: ${e.message}`);
      expect(settled).toMatch(/^rejected: /);
      expect(settled).not.toMatch(/larger than/);
    },
  );

  // RED IF: the truncation check above starts rejecting a compressed body that is whole (the
  // same 12000 bytes, not cut).
  it("serves the same gzip body when it is whole", async () => {
    const res = await get("/gzip-whole");
    expect((await res.text()).length).toBeGreaterThan(0);
    expect(res.status).toBe(200);
  });

  // RED IF: a complete response with a content-encoding header and no bytes at all becomes an
  // error instead of an empty body.
  it.each(["/gzip-empty", "/gzip-empty-chunked"])("treats %s (compressed, zero bytes) as an empty body", async (path) => {
    const res = await get(path);
    expect(await res.text()).toBe("");
  });

  // RED IF: an encoding that cannot be decoded is passed through as if it were text.
  it("refuses an encoding it does not decode", async () => {
    await expect(get("/zstd")).rejects.toThrow(/Unsupported content-encoding: zstd/);
  });

  // RED IF: a caller-supplied Host (or another header only the transport may set) reaches the
  // wire, the caller's User-Agent is dropped, or the request advertises an encoding it cannot decode.
  it("never lets the caller set Host, and sends the caller's other headers", async () => {
    await get("/headers", {
      headers: {
        Host: "internal.example",
        "Accept-Encoding": "zstd",
        "Content-Length": "5",
        "Transfer-Encoding": "chunked",
        "User-Agent": "mcp-seo/1.0 (SEO analysis tool)",
        "X-Extra": "kept",
      },
    });
    const seen = a.headers[0];
    expect(seen.host).toBe(`site.example.test:${port}`);
    expect(seen["accept-encoding"]).toBe("gzip, br");
    expect(seen["content-length"]).toBeUndefined();
    expect(seen["transfer-encoding"]).toBeUndefined();
    expect(seen["user-agent"]).toBe("mcp-seo/1.0 (SEO analysis tool)");
    expect(seen["x-extra"]).toBe("kept");
    expect(seen.accept).toBe("*/*");
  });

  // RED IF: credential headers are sent on to a different origin after a redirect.
  it("drops Authorization and Cookie when a redirect leaves the origin, on the wire", async (ctx) => {
    if (!b) return ctx.skip();
    const { lookup } = tableLookup({ "a.example.test": [ADDRESS_A], "b.example.test": [addressB] });
    const headers = { Authorization: "Bearer secret", Cookie: "sid=1", "Proxy-Authorization": "Basic x", "User-Agent": "ua" };
    await safeFetch(`http://a.example.test:${port}/redirect-b`, { headers }, { lookup, env: ALLOW });
    expect(a.headers[0]).toMatchObject({ authorization: "Bearer secret", cookie: "sid=1", "proxy-authorization": "Basic x" });
    expect(b.headers[0].authorization).toBeUndefined();
    expect(b.headers[0].cookie).toBeUndefined();
    expect(b.headers[0]["proxy-authorization"]).toBeUndefined();
    expect(b.headers[0]["user-agent"]).toBe("ua");
  });

  // RED IF: credential headers are dropped on a redirect that stays on the same origin.
  it("keeps Authorization and Cookie on a same-origin redirect", async () => {
    const { lookup } = tableLookup({ "a.example.test": [ADDRESS_A] });
    await safeFetch(`http://a.example.test:${port}/redirect-same`, { headers: { Authorization: "Bearer secret", Cookie: "sid=1" } }, { lookup, env: ALLOW });
    expect(a.hits.map(hit => hit.split(" ")[1])).toEqual(["/redirect-same", "/landed"]);
    expect(a.headers[1]).toMatchObject({ authorization: "Bearer secret", cookie: "sid=1" });
  });

  // RED IF: the size cap is not applied to the real stream (6 MB arrives chunked, no content-length).
  it("stops a 6 MB body at the 5 MB cap", async () => {
    await expect(get("/big")).rejects.toThrow(ResponseTooLargeError);
  });

  // RED IF: the cap counts bytes on the wire instead of decoded bytes (8 KB of gzip, 8 MB decoded).
  it("stops a decompression bomb at the 5 MB cap", async () => {
    await expect(get("/bomb")).rejects.toThrow(ResponseTooLargeError);
  });

  // RED IF: a redirect hop's response is not destroyed when its body is discarded. The server
  // holds that body open; the next hop reports how many connections the server has open 100 ms
  // after it arrives. With the hop destroyed that is 1 (itself); left open it is 2.
  it("drops a redirect hop's connection before the next hop, even when the server holds the body open", async () => {
    const res = await get("/redirect-held");
    expect(await res.text()).toBe("open=1");
  });

  // RED IF: safeFetch stops aborting its per-call controller in `finally`. For the two rows marked
  // (abort only), nothing else closes the connection: an oversized declared body is rejected
  // before it is read, and the server never finishes it.
  // Also red if a discarded body or a manual redirect is not destroyed explicitly.
  it.each([
    ["an oversized declared body the server never finishes (abort only)", () => get("/declared-big").catch((e: Error) => e.name)],
    ["a redirect whose body the server holds open", () => get("/redirect-held")],
    ["a discarded body", () => get("/big", { discardBody: true })],
    ["a redirect hop's body", () => get("/redirect-same")],
    ["a manual redirect", () => get("/redirect-same", { redirect: "manual" })],
    ["a body over the cap", () => get("/big").catch(() => undefined)],
    ["a body read to the end", () => get("/")],
  ])("leaves no open connection after %s", async (_name, run) => {
    await run();
    expect(await until(() => a.open.size === 0)).toBe(true);
  });

  // RED IF: the oversized declared body above stops being refused (the test would then be
  // measuring a different path).
  it("refuses an oversized declared body without reading it", async () => {
    await expect(get("/declared-big")).rejects.toThrow(ResponseTooLargeError);
  });

  // RED IF: a timeout that lands while an earlier hop's connection is still held open leaves that
  // connection behind, or tears it down with an error nobody handles.
  it("times out cleanly when a held-open redirect is followed by a hop that never answers", async () => {
    await expect(get("/redirect-held-slow", { timeoutMs: 200 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(await until(() => a.open.size === 0)).toBe(true);
  });

  // RED IF: the deadline no longer aborts the real request.
  it("times out a server that never answers", async () => {
    await expect(get("/slow", { timeoutMs: 150 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(await until(() => a.open.size === 0)).toBe(true);
  });

  // RED IF: HEAD stops being sent as HEAD, or a large declared content-length on a HEAD response
  // is mistaken for an oversized body.
  it("makes a HEAD request and does not read a body", async () => {
    const res = await get("/img.png", { method: "HEAD" });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("");
    expect(a.hits).toEqual([`HEAD /img.png host=site.example.test:${port}`]);
  });

  // RED IF: credentials in a URL start being sent (fetch refused such URLs; so does this).
  it("refuses a URL that carries credentials", async () => {
    const { lookup } = table();
    await expect(safeFetch(`http://user:pw@site.example.test:${port}/`, {}, { lookup, env: ALLOW })).rejects.toThrow(/credentials/);
    expect(a.hits).toEqual([]);
  });
});
