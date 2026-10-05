/**
 * The guard as the tools see it: the resolver module and the transport module are replaced, so
 * nothing here touches the network. Above each test: the change that turns it red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("../src/utils/pinned-request.js", () => ({ pinnedRequest: vi.fn() }));

import { lookup } from "node:dns/promises";
import { pinnedRequest, type TransportRequest } from "../src/utils/pinned-request.js";
import { BLOCKED_MESSAGE } from "../src/utils/safe-fetch.js";
import { fetchPage } from "../src/utils/html.js";
import { metaTags } from "../src/tools/meta-tags.js";
import { headingStructure } from "../src/tools/heading-structure.js";
import { robotsTxt } from "../src/tools/robots-txt.js";
import { sitemapCheck } from "../src/tools/sitemap-check.js";

const PUBLIC_IP = "8.8.8.8"; // never contacted: the transport is replaced
const lookupMock = vi.mocked(lookup) as unknown as ReturnType<typeof vi.fn>;
const transportMock = vi.mocked(pinnedRequest) as unknown as ReturnType<typeof vi.fn>;
/** What the tools' requests are answered with. Recorded calls are (url, { headers, method, addresses }). */
const fetchMock = vi.fn();
/** Global fetch is no longer used by this package; if anything calls it, the test fails. */
const rawFetchTrap = vi.fn(() => { throw new Error("global fetch must not be called"); });

function resolveTo(table: Record<string, string[]>) {
  lookupMock.mockImplementation(async (hostname: string) => {
    const addresses = table[hostname];
    if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    return addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
}

beforeEach(() => {
  lookupMock.mockReset();
  fetchMock.mockReset();
  rawFetchTrap.mockClear();
  transportMock.mockReset();
  transportMock.mockImplementation(async (request: TransportRequest) => {
    const response: Response = await fetchMock(request.url.href, { headers: request.headers, method: request.method, addresses: request.addresses });
    return { status: response.status, headers: response.headers, body: response.body, close: () => {} };
  });
  vi.stubGlobal("fetch", rawFetchTrap);
  vi.stubEnv("SEO_TOOLKIT_ALLOW_PRIVATE", "");
});

afterEach(() => {
  expect(rawFetchTrap).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchPage (meta_tags, heading_structure and every other page-fetching tool)", () => {
  // RED IF: src/utils/html.ts makes its own request (fetch or otherwise) instead of safeFetch().
  it.each([
    "http://127.0.0.1:8080/",
    "http://localhost:3000/",
    "http://2130706433/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
  ])("refuses %s without a request", async (url) => {
    resolveTo({});
    await expect(fetchPage(url)).rejects.toThrow(BLOCKED_MESSAGE);
    await expect(metaTags(url)).rejects.toThrow(BLOCKED_MESSAGE);
    await expect(headingStructure(url)).rejects.toThrow(BLOCKED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // RED IF: fetchPage stops resolving the hostname before fetching.
  it("refuses a public-looking hostname that resolves to a private address", async () => {
    resolveTo({ "intranet.example.com": ["10.1.2.3"] });
    await expect(fetchPage("https://intranet.example.com/")).rejects.toThrow(BLOCKED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // RED IF: the guard blocks public pages, or fetchPage's return shape changes.
  it("serves a public page with the same shape as before", async () => {
    resolveTo({ "example.com": [PUBLIC_IP] });
    fetchMock.mockResolvedValue(new Response("<html><title>Example</title><h1>Hi</h1></html>", {
      status: 200,
      headers: { "content-type": "text/html", "x-test": "1" },
    }));
    const page = await fetchPage("https://example.com/");
    expect(page.html).toContain("<title>Example</title>");
    expect(page.status).toBe(200);
    expect(page.headers["x-test"]).toBe("1");
    expect(page.redirected).toBe(false);
    expect(page.finalUrl).toBe("https://example.com/");
    expect(typeof page.responseTimeMs).toBe("number");
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ "User-Agent": "mcp-seo/1.0 (SEO analysis tool)" });
    expect(fetchMock.mock.calls[0][1].addresses).toEqual([{ address: PUBLIC_IP, family: 4 }]);
  });

  // RED IF: redirect hops made on behalf of a tool are not checked.
  it("refuses a public page that redirects to loopback", async () => {
    resolveTo({ "example.com": [PUBLIC_IP] });
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/secret" } }));
    await expect(metaTags("http://example.com/")).rejects.toThrow(BLOCKED_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("https to http", () => {
  // RED IF: a tool follows a redirect from https down to http.
  it("a tool refuses a redirect from https to http, in its normal error shape", async () => {
    resolveTo({ "example.com": [PUBLIC_IP] });
    fetchMock.mockImplementation(async () => new Response(null, { status: 301, headers: { location: "http://example.com/" } }));
    await expect(metaTags("https://example.com/")).rejects.toThrow("Redirect from https to http refused");
    const out = JSON.parse(await robotsTxt("https://example.com/"));
    expect(out.error).toContain("Redirect from https to http refused");
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["https://example.com/", "https://example.com/robots.txt"]);
  });
});

describe("robots_txt", () => {
  // RED IF: src/tools/robots-txt.ts goes back to calling fetch() directly, or the refusal throws
  // instead of coming back in the tool's { error } shape.
  it.each(["http://localhost:3000", "http://192.168.1.1/", "http://0x7f.1/", "file:///etc/passwd"])(
    "returns the error shape for %s without a request",
    async (url) => {
      resolveTo({});
      const out = JSON.parse(await robotsTxt(url));
      expect(out.error).toContain(BLOCKED_MESSAGE);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  // RED IF: the guard blocks public robots.txt fetches, or robots parsing changes.
  it("still parses a public robots.txt", async () => {
    resolveTo({ "example.com": [PUBLIC_IP] });
    fetchMock.mockResolvedValue(new Response("User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml\n", { status: 200 }));
    const out = JSON.parse(await robotsTxt("https://example.com/some/page"));
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/robots.txt");
    expect(out.found).toBe(true);
    expect(out.rules[0].disallow).toEqual(["/private"]);
    expect(out.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });
});

describe("sitemap_check", () => {
  // RED IF: src/tools/sitemap-check.ts goes back to calling fetch() directly.
  it.each(["http://127.0.0.1/sitemap.xml", "http://10.0.0.1/", "http://nas.local/sitemap.xml"])(
    "returns the error shape for %s without a request",
    async (url) => {
      resolveTo({});
      const out = JSON.parse(await sitemapCheck(url));
      expect(out.error).toContain(BLOCKED_MESSAGE);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  // RED IF: the guard blocks public sitemap fetches, or sitemap parsing changes.
  it("still reads a public sitemap", async () => {
    resolveTo({ "example.com": [PUBLIC_IP] });
    fetchMock.mockResolvedValue(new Response(
      '<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc><lastmod>2026-01-01</lastmod></url></urlset>',
      { status: 200 },
    ));
    const out = JSON.parse(await sitemapCheck("https://example.com/"));
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/sitemap.xml");
    expect(out.found).toBe(true);
    expect(out.urlCount).toBe(1);
  });
});

describe("opt-out reaches the tools only through the environment", () => {
  // RED IF: the tools stop honouring SEO_TOOLKIT_ALLOW_PRIVATE=1 set in the server's environment.
  it("lets a tool fetch loopback when the variable is set", async () => {
    vi.stubEnv("SEO_TOOLKIT_ALLOW_PRIVATE", "1");
    resolveTo({ localhost: ["127.0.0.1"] });
    fetchMock.mockResolvedValue(new Response("User-agent: *\nDisallow:\n", { status: 200 }));
    const out = JSON.parse(await robotsTxt("http://localhost:3000"));
    expect(out.found).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].addresses).toEqual([{ address: "127.0.0.1", family: 4 }]);
  });
});
