/**
 * Guard tests. No real network: the resolver and the transport are stubs passed in as deps.
 * (The real transport, on real sockets, is exercised in pinning.test.ts.)
 * Above each test: the change to src/utils/safe-fetch.ts that turns it red.
 */
import { describe, it, expect, vi } from "vitest";
import {
  safeFetch,
  isPublicAddress,
  BlockedUrlError,
  ResponseTooLargeError,
  InsecureRedirectError,
  BLOCKED_MESSAGE,
  MAX_RESPONSE_BYTES,
  MAX_REDIRECTS,
  type LookupFn,
} from "../src/utils/safe-fetch.js";
import type { Transport, TransportRequest } from "../src/utils/pinned-request.js";

/** Stands in for "a public address". Nothing in this file opens a connection, so it is never contacted. */
const PUBLIC_IP = "8.8.8.8";

function stubLookup(table: Record<string, string[]>) {
  return vi.fn<LookupFn>(async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    return addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
}

/** A stand-in transport. Recorded calls are (url.href, request), so tests can read both. */
function stubTransport(handler: (url: string, request: TransportRequest) => Response | Promise<Response>) {
  return vi.fn(async (url: string, request: TransportRequest) => handler(url, request));
}
const via = (send: ReturnType<typeof stubTransport>): Transport => async (request) => {
  const response = await send(request.url.href, request);
  return { status: response.status, headers: response.headers, body: response.body, close: () => {} };
};

const ok = (body = "hello") => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { location } });
const noEnv = {};

describe("scheme", () => {
  // RED IF: the `url.protocol !== "http:" && url.protocol !== "https:"` check is removed or widened.
  it.each(["file:///etc/passwd", "ftp://example.com/", "data:text/html,hi", "gopher://example.com/"])(
    "refuses %s",
    async (url) => {
      const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
      const send = stubTransport(() => ok());
      await expect(safeFetch(url, {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(BlockedUrlError);
      expect(send).not.toHaveBeenCalled();
    },
  );
});

describe("hostnames", () => {
  // RED IF: any one of these is removed: the .localhost / .local / .internal suffixes, the
  // single-label rule (`!name.includes(".")`), or the trailing-dot strip before them.
  // NOT red if only the explicit `name === "localhost"` line goes: "localhost" is also a single
  // label, so that line is a second lock on the same door (red once both are removed).
  // The resolver stub answers PUBLIC for every name, so only the name rules can refuse these.
  it.each([
    "http://localhost/",
    "http://LOCALHOST:3000/",
    "http://localhost./",
    "http://app.localhost/",
    "http://printer.local/",
    "http://printer.local./",
    "http://db.internal/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://intranet/",
    "http://router:8080/admin",
  ])("refuses %s without resolving or fetching", async (url) => {
    const lookup = vi.fn<LookupFn>(async () => [{ address: PUBLIC_IP, family: 4 }]);
    const send = stubTransport(() => ok());
    await expect(safeFetch(url, {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(BLOCKED_MESSAGE);
    expect(lookup).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("resolved addresses", () => {
  // RED IF: the matching range line is removed from isPublicV4 / isPublicV6, the "only 2000::/3 can
  // be public" rule is removed (that one rule covers every IPv6 row outside global unicast), or
  // resolvePublicUrl stops resolving the hostname.
  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback (end of 127/8)", "127.255.255.254"],
    ["unspecified", "0.0.0.0"],
    ["private 10/8", "10.0.0.1"],
    ["private 172.16/12 (start)", "172.16.0.1"],
    ["private 172.16/12 (end)", "172.31.255.255"],
    ["private 192.168/16", "192.168.1.1"],
    ["link-local / cloud metadata", "169.254.169.254"],
    ["CGNAT (start)", "100.64.0.1"],
    ["CGNAT (end)", "100.127.255.255"],
    ["multicast", "224.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 link-local with zone", "fe80::1%lo0"],
    ["IPv6 link-local (end of fe80::/10)", "febf::1"],
    ["IPv6 unique-local fc00::/7", "fc00::1"],
    ["IPv6 unique-local fd..", "fd12:3456:789a::1"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv4-mapped loopback (dotted)", "::ffff:127.0.0.1"],
    ["IPv4-mapped private (dotted)", "::ffff:10.0.0.1"],
    ["IPv4-mapped metadata (hex)", "::ffff:a9fe:a9fe"],
    ["IPv4-mapped CGNAT (hex)", "::ffff:6440:1"],
    ["NAT64 of loopback", "64:ff9b::7f00:1"],
    ["NAT64 local-use prefix", "64:ff9b:1::808:808"],
    ["IPv4-translated loopback", "::ffff:0:7f00:1"],
    ["IPv4-compatible", "::8.8.8.8"],
    ["IETF protocol assignments 192.0.0.0/24", "192.0.0.8"],
    ["documentation TEST-NET-1", "192.0.2.1"],
    ["documentation TEST-NET-2", "198.51.100.1"],
    ["documentation TEST-NET-3", "203.0.113.1"],
    ["benchmarking 198.18/15 (start)", "198.18.0.1"],
    ["benchmarking 198.18/15 (end)", "198.19.255.255"],
    ["deprecated 6to4 relay anycast", "192.88.99.1"],
    ["AS112 192.31.196.0/24", "192.31.196.1"],
    ["AMT 192.52.193.0/24", "192.52.193.1"],
    ["AS112 192.175.48.0/24", "192.175.48.1"],
    ["reserved 240/4", "240.0.0.1"],
    ["Teredo 2001::/32", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["benchmarking 2001:2::/48", "2001:2::1"],
    ["ORCHID 2001:10::/28", "2001:10::1"],
    ["ORCHIDv2 2001:20::/28", "2001:20::1"],
    ["end of 2001::/23", "2001:1ff:ffff::1"],
    ["documentation 2001:db8::/32", "2001:db8::1"],
    ["6to4 of private", "2002:c0a8:101::1"],
    ["6to4 of a public address", "2002:808:808::1"],
    ["AS112 2620:4f:8000::/48", "2620:4f:8000::1"],
    ["documentation 3fff::/20 (start)", "3fff::1"],
    ["documentation 3fff::/20 (end)", "3fff:fff:ffff::1"],
    ["discard 100::/64", "100::1"],
    ["dummy prefix 100:0:0:1::/64", "100:0:0:1::1"],
    ["SRv6 5f00::/16", "5f00::1"],
    ["site-local fec0::/10", "fec0::1"],
    ["just below 2000::/3", "1fff:ffff::1"],
    ["just above 2000::/3", "4000::1"],
  ])("refuses a hostname resolving to %s (%s)", async (_label, address) => {
    const lookup = stubLookup({ "evil.example.com": [address] });
    const send = stubTransport(() => ok());
    await expect(safeFetch("http://evil.example.com/", {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(BlockedUrlError);
    expect(lookup).toHaveBeenCalledWith("evil.example.com", { all: true });
    expect(send).not.toHaveBeenCalled();
  });

  // RED IF: `addresses.some(...)` becomes "check only the first address" or `.every(...)`.
  it("refuses when ANY of several resolved addresses is private", async () => {
    const lookup = stubLookup({ "mixed.example.com": [PUBLIC_IP, "10.0.0.5"] });
    const send = stubTransport(() => ok());
    await expect(safeFetch("https://mixed.example.com/", {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(BlockedUrlError);
    expect(send).not.toHaveBeenCalled();
  });

  // RED IF: an empty resolver answer is treated as "nothing private, go ahead".
  it("refuses when the resolver returns no addresses", async () => {
    const lookup = stubLookup({ "empty.example.com": [] });
    const send = stubTransport(() => ok());
    await expect(safeFetch("https://empty.example.com/", {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(BlockedUrlError);
    expect(send).not.toHaveBeenCalled();
  });

  // RED IF: a resolver failure is swallowed and the request goes ahead unchecked.
  it("does not send when the resolver fails", async () => {
    const lookup = stubLookup({});
    const send = stubTransport(() => ok());
    await expect(safeFetch("https://nope.example.com/", {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(/ENOTFOUND/);
    expect(send).not.toHaveBeenCalled();
  });

  // RED IF: a range is WIDENED past its boundary (e.g. 172.16/12 written as 172/8, CGNAT as 100/8,
  // 2001::/23 as 2001::/16, 3fff::/20 as 3fff::/16). These are the nearest public neighbours of each
  // refused range, plus ordinary public addresses.
  it.each([
    "9.255.255.255", "11.0.0.1", "126.255.255.255", "128.0.0.1", "100.63.255.255", "100.128.0.1",
    "169.253.255.255", "169.255.0.1", "172.15.255.255", "172.32.0.1", "192.167.255.255", "192.169.0.1",
    "191.255.255.255", "192.0.1.1", "192.0.3.1", "192.31.195.1", "192.31.197.1", "192.52.192.1", "192.52.194.1",
    "192.88.98.1", "192.88.100.1", "192.175.47.1", "192.175.49.1", "198.17.255.255", "198.20.0.1",
    "198.51.99.1", "198.51.101.1", "203.0.112.1", "203.0.114.1", "223.255.255.255", "1.1.1.1", PUBLIC_IP,
    "2606:4700:4700::1111", "2001:4860:4860::8888", "2620:fe::fe", "::ffff:8.8.8.8", "64:ff9b::808:808",
    "2000::1", "3ffe:ffff::1", "2001:200::1", "2001:db7:ffff::1", "2001:db9::1", "2003::1",
    "2620:4f:7fff::1", "2620:4f:8001::1", "3fff:1000::1",
  ])("treats %s as public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  // RED IF: isPublicAddress stops failing closed on input it cannot parse.
  it.each(["", "not-an-ip", "999.1.1.1", "1.2.3", "example.com"])("treats unparseable %j as not public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("IP literals", () => {
  // RED IF: literals are judged by matching the raw string (e.g. /^127\./ or "localhost") instead of
  // the parsed URL's hostname, or the `isIP(host)` branch returns without calling isPublicAddress.
  it.each([
    ["dotted loopback", "http://127.0.0.1/"],
    ["decimal integer", "http://2130706433/"],
    ["hex + short form", "http://0x7f.1/"],
    ["short form", "http://127.1/"],
    ["octal integer", "http://017700000001/"],
    ["octal octet", "http://0177.0.0.1/"],
    ["hex integer", "http://0x7f000001/"],
    ["zero", "http://0/"],
    ["decimal private (10.0.0.1)", "http://167772161/"],
    ["decimal metadata (169.254.169.254)", "http://2852039166/latest/meta-data/"],
    ["private with port", "http://192.168.0.1:8080/"],
    ["CGNAT", "http://100.64.0.1/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv6 loopback, long form", "http://[0:0:0:0:0:0:0:1]/"],
    ["IPv6 link-local", "http://[fe80::1]/"],
    ["IPv6 unique-local", "http://[fd00::1]/"],
    ["IPv4-mapped (dotted)", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped (hex)", "http://[::ffff:7f00:1]/"],
    ["IPv4-mapped private", "https://[::ffff:192.168.1.1]/"],
    ["loopback behind a userinfo decoy", "http://example.com@127.0.0.1/"],
    ["loopback behind a backslash decoy", "http://127.0.0.1\\@example.com/"],
    ["loopback with a trailing dot", "http://127.0.0.1./"],
  ])("refuses %s: %s", async (_label, url) => {
    const lookup = vi.fn<LookupFn>(async () => [{ address: PUBLIC_IP, family: 4 }]);
    const send = stubTransport(() => ok());
    await expect(safeFetch(url, {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(BLOCKED_MESSAGE);
    expect(send).not.toHaveBeenCalled();
  });

  // RED IF: every IP literal is refused (over-blocking), or a literal is not pinned to itself.
  it("allows a public IP literal without resolving", async () => {
    const lookup = stubLookup({});
    const send = stubTransport(() => ok("by ip"));
    const res = await safeFetch(`http://${PUBLIC_IP}/`, {}, { lookup, transport: via(send), env: noEnv });
    expect(await res.text()).toBe("by ip");
    expect(lookup).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1].addresses).toEqual([{ address: PUBLIC_IP, family: 4 }]);
  });
});

describe("what is checked is what is fetched", () => {
  // RED IF: the transport is handed a URL built from the caller's raw string instead of the parsed
  // URL the guard judged; a second parse by another component may disagree with the first.
  it("passes the parsed, normalised URL to the transport, not the raw input", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    const send = stubTransport(() => ok());
    await safeFetch("HTTP://EXAMPLE.com:80\\a\\..\\b", {}, { lookup, transport: via(send), env: noEnv });
    expect(send.mock.calls[0][0]).toBe("http://example.com/b");
    expect(lookup).toHaveBeenCalledWith("example.com", { all: true });
  });
});

describe("allowed public fetch", () => {
  // RED IF: the guard refuses a public hostname, the hostname is resolved more than once, or the
  // transport is handed anything other than exactly the addresses that were checked.
  it("fetches a public URL, resolving once and pinning the transport to the checked addresses", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP, "2606:4700:4700::1111"] });
    const send = stubTransport(() => ok("<title>hi</title>"));
    const res = await safeFetch("https://example.com/page", { headers: { "User-Agent": "t" } }, { lookup, transport: via(send), env: noEnv });

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("<title>hi</title>");
    expect(res.url).toBe("https://example.com/page");
    expect(res.redirected).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const [calledUrl, request] = send.mock.calls[0];
    expect(calledUrl).toBe("https://example.com/page");
    expect(request.method).toBe("GET");
    expect(request.headers).toEqual({ "User-Agent": "t" });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request.addresses).toEqual([
      { address: PUBLIC_IP, family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });
});

describe("redirects", () => {
  // RED IF: resolvePublicUrl is called once before the loop instead of on every hop.
  it("refuses a redirect from a public URL to http://127.0.0.1 and never requests it", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    const send = stubTransport(() => redirectTo("http://127.0.0.1/admin"));
    await expect(safeFetch("http://example.com/", {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(BLOCKED_MESSAGE);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("http://example.com/");

    const secure = stubTransport(() => redirectTo("https://127.0.0.1/admin"));
    await expect(safeFetch("https://example.com/", {}, { lookup, transport: via(secure), env: noEnv })).rejects.toThrow(BLOCKED_MESSAGE);
    expect(secure).toHaveBeenCalledTimes(1);
  });

  // RED IF: redirect targets are checked as literals only and their hostnames are not resolved.
  it.each([301, 302, 303, 307, 308])("refuses a %i redirect to a hostname that resolves private", async (status) => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP], "rebound.example.net": ["192.168.1.1"] });
    const send = stubTransport(() => redirectTo("https://rebound.example.net/", status));
    await expect(safeFetch("https://example.com/", {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(BlockedUrlError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  // RED IF: the https-to-http check in assertRedirectAllowed is removed. The target here is a
  // PUBLIC host, so only that rule can refuse it; the http hop must never be requested.
  it("refuses a redirect from https to http, even to a public host", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP], "plain.example.org": [PUBLIC_IP] });
    const send = stubTransport(() => redirectTo("http://plain.example.org/"));
    await expect(safeFetch("https://example.com/", {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(InsecureRedirectError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  // RED IF: the rule is written too broadly and also refuses http to https, or http to http.
  it("still follows http to https and http to http", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP], "www.example.com": [PUBLIC_IP] });
    const send = stubTransport((url) => {
      if (url === "http://example.com/") return redirectTo("http://www.example.com/");
      if (url === "http://www.example.com/") return redirectTo("https://www.example.com/");
      return ok("upgraded");
    });
    const res = await safeFetch("http://example.com/", {}, { lookup, transport: via(send), env: noEnv });
    expect(await res.text()).toBe("upgraded");
    expect(res.url).toBe("https://www.example.com/");
  });

  // RED IF: Authorization, Cookie or Proxy-Authorization is sent on after a redirect to a different
  // origin (another host, another port, or another scheme), or comes back on a later hop that
  // returns to the first origin. Other headers must keep travelling.
  it.each([
    ["another host", "https://other.example.org/x"],
    ["another port", "https://example.com:8443/x"],
  ])("drops credential headers when a redirect goes to %s", async (_label, target) => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP], "other.example.org": [PUBLIC_IP] });
    const send = stubTransport((url) => {
      if (url === "https://example.com/start") return redirectTo(target);
      if (url === target) return redirectTo("https://example.com/back");
      return ok("done");
    });
    const headers = { Authorization: "Bearer s3cret", cookie: "sid=1", "Proxy-Authorization": "Basic x", "User-Agent": "ua" };
    await safeFetch("https://example.com/start", { headers }, { lookup, transport: via(send), env: noEnv });
    expect(send.mock.calls.map(([url, request]) => [url, request.headers])).toEqual([
      ["https://example.com/start", headers],
      [target, { "User-Agent": "ua" }],
      ["https://example.com/back", { "User-Agent": "ua" }],
    ]);
  });

  // RED IF: a scheme change alone (http to https on the same host) is not treated as a new origin.
  it("drops credential headers when a redirect changes only the scheme", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    const send = stubTransport((url) => (url === "http://example.com/" ? redirectTo("https://example.com/") : ok()));
    await safeFetch("http://example.com/", { headers: { Cookie: "sid=1", Accept: "text/html" } }, { lookup, transport: via(send), env: noEnv });
    expect(send.mock.calls[1][1].headers).toEqual({ Accept: "text/html" });
  });

  // RED IF: credential headers are dropped on a redirect that stays on the same origin (over-stripping).
  it("keeps credential headers on a same-origin redirect", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    const send = stubTransport((url) => (url === "https://example.com/a" ? redirectTo("/b") : ok()));
    const headers = { Authorization: "Bearer s3cret", Cookie: "sid=1" };
    await safeFetch("https://example.com/a", { headers }, { lookup, transport: via(send), env: noEnv });
    expect(send.mock.calls[1][1].headers).toEqual(headers);
  });

  // RED IF: a redirect to a non-http scheme is followed.
  it("refuses a redirect to file:", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    const send = stubTransport(() => redirectTo("file:///etc/passwd"));
    await expect(safeFetch("https://example.com/", {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(BlockedUrlError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  // RED IF: redirects are no longer followed at all, or a relative Location is not resolved
  // against the current URL.
  it("follows a public redirect chain (relative and absolute) and reports the final URL", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP], "www.example.org": [PUBLIC_IP] });
    const send = stubTransport((url) => {
      if (url === "https://example.com/a") return redirectTo("/b", 301);
      if (url === "https://example.com/b") return redirectTo("https://www.example.org/c");
      return ok("landed");
    });
    const res = await safeFetch("https://example.com/a", {}, { lookup, transport: via(send), env: noEnv });
    expect(await res.text()).toBe("landed");
    expect(res.url).toBe("https://www.example.org/c");
    expect(res.redirected).toBe(true);
    expect(res.redirectCount).toBe(2);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  // RED IF: a later hop is sent with the FIRST hop's addresses (each hop must be resolved, checked
  // and pinned on its own), or a hop's hostname is resolved more than once.
  it("pins every redirect hop to that hop's own checked addresses", async () => {
    const lookup = stubLookup({ "a.example.com": [PUBLIC_IP], "b.example.net": ["9.9.9.9", "2620:fe::fe"] });
    const send = stubTransport((url) => (url === "https://a.example.com/" ? redirectTo("https://b.example.net/x") : ok("b")));
    const res = await safeFetch("https://a.example.com/", {}, { lookup, transport: via(send), env: noEnv });
    expect(await res.text()).toBe("b");
    expect(send.mock.calls.map(([url, request]) => [url, request.addresses])).toEqual([
      ["https://a.example.com/", [{ address: PUBLIC_IP, family: 4 }]],
      ["https://b.example.net/x", [{ address: "9.9.9.9", family: 4 }, { address: "2620:fe::fe", family: 6 }]],
    ]);
    expect(lookup.mock.calls.map(call => call[0])).toEqual(["a.example.com", "b.example.net"]);
  });

  // RED IF: MAX_REDIRECTS is raised above 5, or the hop limit check is removed (the loop would then
  // run until the stub's counter assertion below fails).
  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    expect(MAX_REDIRECTS).toBe(5);
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    let n = 0;
    const send = stubTransport(() => {
      n++;
      if (n > 50) throw new Error("runaway redirect loop");
      return redirectTo(`https://example.com/hop${n}`);
    });
    await expect(safeFetch("https://example.com/", {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(/Too many redirects/);
    expect(send).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  // RED IF: the limit is off by one in the strict direction (5 redirects must still succeed).
  it(`allows exactly ${MAX_REDIRECTS} redirects`, async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    let n = 0;
    const send = stubTransport(() => (++n <= MAX_REDIRECTS ? redirectTo(`https://example.com/hop${n}`) : ok("end")));
    const res = await safeFetch("https://example.com/", {}, { lookup, transport: via(send), env: noEnv });
    expect(await res.text()).toBe("end");
    expect(res.redirectCount).toBe(MAX_REDIRECTS);
  });

  // RED IF: redirect: "manual" starts following the redirect instead of returning the 3xx response.
  it('returns the 3xx response itself when redirect is "manual"', async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    const send = stubTransport(() => redirectTo("http://127.0.0.1/"));
    const res = await safeFetch("https://example.com/", { redirect: "manual" }, { lookup, transport: via(send), env: noEnv });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1/");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("size cap", () => {
  const streamOf = (totalBytes: number, chunk = 64 * 1024) => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) return controller.close();
        const size = Math.min(chunk, totalBytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(97));
      },
    });
  };

  // RED IF: the running-total check in readCapped is removed or MAX_RESPONSE_BYTES is raised.
  // No content-length header here, so only the streamed count can catch it.
  it("refuses a body one byte over 5 MB", async () => {
    expect(MAX_RESPONSE_BYTES).toBe(5 * 1024 * 1024);
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    const send = stubTransport(() => new Response(streamOf(MAX_RESPONSE_BYTES + 1), { status: 200 }));
    await expect(safeFetch("https://example.com/big", {}, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(ResponseTooLargeError);
  });

  // RED IF: the comparison becomes `>=` (a body of exactly 5 MB must still be served).
  it("serves a body of exactly 5 MB", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    const send = stubTransport(() => new Response(streamOf(MAX_RESPONSE_BYTES), { status: 200 }));
    const res = await safeFetch("https://example.com/big", {}, { lookup, transport: via(send), env: noEnv });
    expect((await res.text()).length).toBe(MAX_RESPONSE_BYTES);
  });

  // RED IF: the declared content-length pre-check is removed (the stream here would hang forever
  // if read, so only the header check can refuse it before the timeout).
  it("refuses on a declared content-length over the cap without reading the body", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    const never = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const send = stubTransport(() => new Response(never, { status: 200, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }));
    await expect(safeFetch("https://example.com/big", { timeoutMs: 2000 }, { lookup, transport: via(send), env: noEnv })).rejects.toThrow(ResponseTooLargeError);
  });
});

describe("timeout", () => {
  // RED IF: the deadline timer is removed or its signal is no longer passed to the transport.
  it("aborts a request that never answers", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    let sawSignal: AbortSignal | undefined;
    const send = stubTransport((_url, request) => {
      sawSignal = request.signal;
      return new Promise<Response>(() => {});
    });
    await expect(safeFetch("https://example.com/slow", { timeoutMs: 30 }, { lookup, transport: via(send), env: noEnv })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(sawSignal?.aborted).toBe(true);
  });

  // RED IF: the deadline stops covering the body read (headers arrive, body stalls).
  it("aborts a body that stalls", async () => {
    const lookup = stubLookup({ "example.com": [PUBLIC_IP] });
    const never = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const send = stubTransport(() => new Response(never, { status: 200 }));
    await expect(safeFetch("https://example.com/stall", { timeoutMs: 30 }, { lookup, transport: via(send), env: noEnv })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  // RED IF: the deadline stops covering a resolver that never answers.
  it("aborts a DNS lookup that never answers", async () => {
    const lookup = vi.fn<LookupFn>(() => new Promise(() => {}));
    const send = stubTransport(() => ok());
    await expect(safeFetch("https://example.com/", { timeoutMs: 30 }, { lookup, transport: via(send), env: noEnv })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("SEO_TOOLKIT_ALLOW_PRIVATE opt-out", () => {
  // RED IF: the environment variable is ignored (opt-out no longer works for local development).
  it("allows a loopback URL when the variable is exactly 1", async () => {
    const lookup = stubLookup({});
    const send = stubTransport(() => ok("local dev"));
    const res = await safeFetch("http://127.0.0.1:3000/", {}, { lookup, transport: via(send), env: { SEO_TOOLKIT_ALLOW_PRIVATE: "1" } });
    expect(await res.text()).toBe("local dev");
    expect(send).toHaveBeenCalledTimes(1);
  });

  // RED IF: the check is loosened from `=== "1"` to any set / truthy value, or the default flips to allow.
  it.each([undefined, "", "0", "false", "true", "yes", " 1"])("stays closed when the variable is %j", async (value) => {
    const lookup = stubLookup({});
    const send = stubTransport(() => ok());
    await expect(
      safeFetch("http://127.0.0.1:3000/", {}, { lookup, transport: via(send), env: { SEO_TOOLKIT_ALLOW_PRIVATE: value } }),
    ).rejects.toThrow(BlockedUrlError);
    expect(send).not.toHaveBeenCalled();
  });

  // RED IF: the opt-out also switches off the scheme check (it must not unlock file: / data:).
  it("still refuses non-http schemes with the opt-out set", async () => {
    const send = stubTransport(() => ok());
    await expect(
      safeFetch("file:///etc/passwd", {}, { lookup: stubLookup({}), transport: via(send), env: { SEO_TOOLKIT_ALLOW_PRIVATE: "1" } }),
    ).rejects.toThrow(BlockedUrlError);
    expect(send).not.toHaveBeenCalled();
  });

  // RED IF: safeFetch stops reading process.env by default (the documented way a user sets it).
  it("reads process.env when no env is injected", async () => {
    const send = stubTransport(() => ok("from process.env"));
    vi.stubEnv("SEO_TOOLKIT_ALLOW_PRIVATE", "1");
    try {
      const res = await safeFetch("http://127.0.0.1:3000/", {}, { lookup: stubLookup({}), transport: via(send) });
      expect(await res.text()).toBe("from process.env");
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(safeFetch("http://127.0.0.1:3000/", {}, { lookup: stubLookup({}), transport: via(send) })).rejects.toThrow(BlockedUrlError);
  });
});
