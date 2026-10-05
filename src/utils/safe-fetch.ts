/**
 * Outbound request guard. EVERY network request in this package goes through safeFetch().
 *
 * This server runs on the user's own machine, and the URLs it fetches come from a model that
 * may be reading hostile page content. The guard keeps a tool call from being pointed at the
 * user's machine or private network:
 *   - http and https only;
 *   - local-style hostnames refused (localhost, *.localhost, *.local, *.internal, single-label);
 *   - the hostname is resolved and refused if ANY address is loopback, unspecified, private,
 *     link-local, CGNAT, unique-local, multicast, or any other block in the IANA IPv4 / IPv6
 *     special-purpose registries (documentation, benchmarking, Teredo, 6to4, discard, ...).
 *     For IPv6 only global unicast (2000::/3) can be public at all. IP literals are judged the
 *     same way after the URL parser has normalised them, so decimal / octal / hex spellings
 *     are covered;
 *   - the connection is pinned: it may only use the addresses that were just checked, and the
 *     hostname is never resolved a second time (see pinned-request.ts), so a name that answers
 *     public first and private second (DNS rebinding) cannot move the connection;
 *   - redirects are followed here, never by the HTTP client: at most MAX_REDIRECTS hops, and
 *     every hop is resolved, checked and pinned on its own. A redirect from https to http is
 *     refused, and credential headers are dropped when a redirect leaves the origin;
 *   - the response body is capped at MAX_RESPONSE_BYTES and the whole call has a deadline.
 *
 * Local development: set SEO_TOOLKIT_ALLOW_PRIVATE=1 in the server's environment to allow
 * private addresses. It is deliberately not a tool argument.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pinnedRequest, type PinnedAddress, type Transport, type TransportResponse } from "./pinned-request.js";

export const BLOCKED_MESSAGE = "This tool only fetches public web addresses";
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const ALLOW_PRIVATE_ENV = "SEO_TOOLKIT_ALLOW_PRIVATE";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal"];

export class BlockedUrlError extends Error {
  constructor() {
    super(BLOCKED_MESSAGE);
    this.name = "BlockedUrlError";
  }
}

export class InsecureRedirectError extends Error {
  constructor() {
    super("Redirect from https to http refused");
    this.name = "InsecureRedirectError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor() {
    super(`Response is larger than the ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB limit`);
    this.name = "ResponseTooLargeError";
  }
}

export type LookupFn = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>;

export interface SafeFetchDeps {
  lookup?: LookupFn;
  transport?: Transport;
  env?: Record<string, string | undefined>;
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  /** Total budget for the call: DNS, every redirect hop and the body. */
  timeoutMs?: number;
  /** "follow" (default) follows redirects here, checking each hop. "manual" returns the 3xx response. */
  redirect?: "follow" | "manual";
  /** Skip reading the body (text() returns ""). */
  discardBody?: boolean;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Final URL after any redirects. */
  url: string;
  redirected: boolean;
  redirectCount: number;
  text(): Promise<string>;
}

// --- address classification ---

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every(o => o <= 255) ? octets : null;
}

function isPublicV4(o: number[]): boolean {
  const [a, b, c] = o;
  if (a === 0) return false;                          // 0.0.0.0/8 unspecified / "this network"
  if (a === 10) return false;                         // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a === 127) return false;                        // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false;           // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;  // 172.16.0.0/12 private
  if (a === 192 && b === 168) return false;           // 192.168.0.0/16 private
  if (a === 192 && b === 0 && c === 0) return false;  // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false;  // 192.0.2.0/24 documentation (TEST-NET-1)
  if (a === 192 && b === 31 && c === 196) return false; // 192.31.196.0/24 AS112
  if (a === 192 && b === 52 && c === 193) return false; // 192.52.193.0/24 AMT
  if (a === 192 && b === 88 && c === 99) return false;  // 192.88.99.0/24 deprecated 6to4 relay anycast
  if (a === 192 && b === 175 && c === 48) return false; // 192.175.48.0/24 AS112 direct delegation
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // 198.51.100.0/24 documentation (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return false;  // 203.0.113.0/24 documentation (TEST-NET-3)
  if (a >= 224) return false;                         // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
  return true;
}

/** Expand an IPv6 address (already validated by net.isIP) to its 8 hextets. */
function parseV6(input: string): number[] | null {
  let s = input;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const groups = [...head, ...new Array<string>(fill).fill("0"), ...rest];
  const hextets = groups.map(g => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return hextets.some(Number.isNaN) ? null : hextets;
}

function isPublicV6(h: number[]): boolean {
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  // Two forms outside global unicast are how ordinary IPv4 sites can appear: judge them by the IPv4 inside.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isPublicV4(embedded(h[6], h[7])); // ::ffff:0:0/96 IPv4-mapped
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isPublicV4(embedded(h[6], h[7])); // 64:ff9b::/96 NAT64
  }
  // Only global unicast can be public. This one rule refuses ::, ::1, IPv4-compatible and
  // IPv4-translated forms, 64:ff9b:1::/48, 100::/64 (discard), 100:0:0:1::/64, 5f00::/16,
  // fc00::/7 (unique-local), fe80::/10 (link-local), fec0::/10 (site-local) and ff00::/8 (multicast).
  if ((h[0] & 0xe000) !== 0x2000) return false; // outside 2000::/3
  if (h[0] === 0x2001 && h[1] < 0x0200) return false;   // 2001::/23 IETF protocol assignments: Teredo 2001::/32, 2001:2::/48, 2001:10::/28, 2001:20::/28, ...
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // 2001:db8::/32 documentation
  if (h[0] === 0x2002) return false;                    // 2002::/16 6to4
  if (h[0] === 0x2620 && h[1] === 0x004f && h[2] === 0x8000) return false; // 2620:4f:8000::/48 AS112
  if (h[0] === 0x3fff && h[1] < 0x1000) return false;   // 3fff::/20 documentation
  return true;
}

/** True only for an IP address this package may connect to. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  let bare = address.trim();
  if (bare.startsWith("[") && bare.endsWith("]")) bare = bare.slice(1, -1);
  const zone = bare.indexOf("%");
  if (zone !== -1) bare = bare.slice(0, zone);
  const family = isIP(bare);
  if (family === 4) {
    const octets = parseV4(bare);
    return octets ? isPublicV4(octets) : false;
  }
  if (family === 6) {
    const hextets = parseV6(bare);
    return hextets ? isPublicV6(hextets) : false;
  }
  return false;
}

// --- URL check ---

/**
 * Resolve the URL's host and return the addresses a connection to it may use.
 * Throws BlockedUrlError unless the URL is http(s) and EVERY address is public.
 * `url` must be a parsed URL: the parser has already normalised odd IPv4 spellings.
 * With `allowPrivate` the name and address checks are skipped; the scheme check and the
 * resolve-once-then-pin behaviour are not.
 */
export async function resolvePublicUrl(url: URL, lookup: LookupFn, allowPrivate: boolean): Promise<PinnedAddress[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError();

  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const literal = isIP(host);
  if (literal !== 0) {
    if (!allowPrivate && !isPublicAddress(host)) throw new BlockedUrlError();
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }

  if (!allowPrivate) {
    const name = host.endsWith(".") ? host.slice(0, -1) : host;
    if (
      name === "" ||
      name === "localhost" ||
      !name.includes(".") ||
      BLOCKED_SUFFIXES.some(suffix => name.endsWith(suffix))
    ) {
      throw new BlockedUrlError();
    }
  }

  const addresses = await lookup(host, { all: true });
  if (!allowPrivate && (addresses.length === 0 || addresses.some(a => !isPublicAddress(a.address)))) {
    throw new BlockedUrlError();
  }
  if (addresses.length === 0) throw new Error(`Could not resolve ${host}`);
  return addresses.map(a => ({ address: a.address, family: isIP(a.address.split("%")[0]) === 6 ? 6 : 4 }));
}

// --- redirects ---

/** Headers that carry credentials. They are not sent on to a different origin. */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** Throw unless following a redirect from `from` to `to` is allowed. (The address check is separate.) */
export function assertRedirectAllowed(from: URL, to: URL): void {
  if (from.protocol === "https:" && to.protocol === "http:") throw new InsecureRedirectError();
}

function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
}

// --- fetch ---

async function readCapped(res: TransportResponse): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ResponseTooLargeError();
  }
  if (!res.body) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving this loop by throwing closes the stream (and with it the connection).
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      throw new ResponseTooLargeError();
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch a public http(s) URL. Throws BlockedUrlError for anything else, ResponseTooLargeError
 * past the size cap, and a TimeoutError when the deadline passes.
 */
export async function safeFetch(input: string, options: SafeFetchOptions = {}, deps: SafeFetchDeps = {}): Promise<SafeResponse> {
  const lookup = deps.lookup ?? (dnsLookup as LookupFn);
  const send = deps.transport ?? pinnedRequest;
  const env = deps.env ?? process.env;
  const allowPrivate = env[ALLOW_PRIVATE_ENV] === "1";
  const method = options.method ?? "GET";
  const follow = (options.redirect ?? "follow") === "follow";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let current = new URL(input);
  let hopHeaders: Record<string, string> = { ...(options.headers ?? {}) };

  const controller = new AbortController();
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  timedOut.catch(() => {});
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, timeoutMs);

  try {
    let redirectCount = 0;
    for (;;) {
      // Resolve and check this hop, then connect only to what was checked.
      const addresses = await Promise.race([resolvePublicUrl(current, lookup, allowPrivate), timedOut]);

      const res = await Promise.race([
        send({
          url: current,
          method,
          headers: hopHeaders,
          signal: controller.signal,
          addresses,
        }),
        timedOut,
      ]);

      const location = res.headers.get("location");
      if (follow && REDIRECT_STATUSES.has(res.status) && location) {
        res.close(); // this hop's body is not read: drop its connection now, not at the end of the call
        if (redirectCount >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects (limit is ${MAX_REDIRECTS})`);
        }
        const next = new URL(location, current);
        assertRedirectAllowed(current, next);
        if (next.origin !== current.origin) hopHeaders = withoutCredentials(hopHeaders);
        current = next;
        redirectCount++;
        continue;
      }

      let bytes: Uint8Array;
      if (options.discardBody || method === "HEAD") {
        bytes = new Uint8Array(0); // not read; the per-call abort below drops the connection
      } else {
        bytes = await Promise.race([readCapped(res), timedOut]);
      }
      const body = new TextDecoder().decode(bytes);

      return {
        status: res.status,
        ok: res.status >= 200 && res.status <= 299,
        headers: res.headers,
        url: current.href,
        redirected: redirectCount > 0,
        redirectCount,
        text: async () => body,
      };
    }
  } finally {
    clearTimeout(timer);
    // Whatever this call left outstanding (a held-open body, a rejected oversized response, a
    // decoder pipeline) is destroyed here, whether the call returned or threw.
    controller.abort();
  }
}
