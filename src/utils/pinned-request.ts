/**
 * The one place this package opens a network connection.
 *
 * A request is made with Node's built-in http / https client and a custom `lookup` that answers
 * only with the addresses safe-fetch.ts has already resolved and checked. The connection never
 * resolves the hostname a second time, so the address that was checked is the address that is
 * used (this is what closes DNS rebinding). The original hostname is still used for the Host
 * header, for TLS SNI and for certificate verification.
 *
 * Redirects are never followed here; safe-fetch.ts follows them one checked hop at a time.
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export interface TransportRequest {
  url: URL;
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  signal: AbortSignal;
  /** The addresses the hostname resolved to, all already checked. The connection may use only these. */
  addresses: PinnedAddress[];
}

export interface TransportResponse {
  status: number;
  headers: Headers;
  /** Decoded body bytes, or null when the response has no body. */
  body: AsyncIterable<Uint8Array> | null;
  /** Drop the connection. Called whenever the body is not read to its end. Safe to call twice. */
  close(): void;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** Request headers Node's fetch sent by default; kept so sites answer as they did before. */
const DEFAULT_HEADERS: Record<string, string> = {
  accept: "*/*",
  "accept-language": "*",
  "sec-fetch-mode": "cors",
  "user-agent": "node",
};

/** Only encodings decoded below are advertised. */
const ACCEPT_ENCODING = "gzip, br";

/**
 * Headers a caller may never set: they decide which server the request is for and how its bytes
 * are framed, and those come from the URL and from this file alone.
 */
const TRANSPORT_OWNED_HEADERS = new Set(["host", "accept-encoding", "connection", "content-length", "transfer-encoding"]);

/**
 * A `lookup` for net / tls that never asks DNS: it hands back the checked addresses and nothing else.
 */
export function pinnedLookup(addresses: PinnedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    process.nextTick(() => {
      if (addresses.length === 0) {
        callback(Object.assign(new Error("No checked address to connect to"), { code: "ENOTFOUND" }), "", 0);
        return;
      }
      if (typeof options === "object" && options !== null && options.all === true) {
        callback(null, addresses.map(a => ({ address: a.address, family: a.family })));
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  };
}

/**
 * Decoders run with zlib's default finish mode: a compressed stream that ends before the
 * decompressor has seen its end is an error, never a short body.
 */
function decoderFor(encoding: string): Transform | null {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return null;
  }
}

/**
 * The decoded body of a compressed response. One case is not an error: a complete response
 * that carried no bytes at all is an empty body (servers send that with a content-encoding
 * header still attached).
 */
function decodedBody(res: IncomingMessage, decoders: Transform[]): AsyncIterable<Uint8Array> {
  let wireBytes = 0;
  res.on("data", (chunk: Buffer) => {
    wireBytes += chunk.length;
  });
  const decoded = pipeline([res, ...decoders], () => {}) as unknown as Readable;
  return {
    [Symbol.asyncIterator]() {
      const inner = decoded[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          try {
            return await inner.next();
          } catch (error) {
            if (res.complete && wireBytes === 0) return { done: true, value: undefined };
            throw error;
          }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          res.destroy();
          await inner.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function toHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    try {
      headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
    } catch {
      // a header name or value the Headers class rejects is dropped rather than failing the response
    }
  }
  return headers;
}

/** Make one request, connecting only to `request.addresses`. Never follows a redirect. */
export const pinnedRequest: Transport = (request) => new Promise<TransportResponse>((resolve, reject) => {
  const { url } = request;
  if (url.username !== "" || url.password !== "") {
    reject(new TypeError("Request cannot be made to a URL that includes credentials"));
    return;
  }

  const isHttps = url.protocol === "https:";
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;

  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
  for (const [name, value] of Object.entries(request.headers)) {
    const key = name.toLowerCase();
    if (!TRANSPORT_OWNED_HEADERS.has(key)) headers[key] = value;
  }
  headers["accept-encoding"] = ACCEPT_ENCODING;

  const options: RequestOptions = {
    protocol: url.protocol,
    hostname,
    port: url.port !== "" ? Number(url.port) : isHttps ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
    agent: false, // one connection per request: every connection goes through the pinned lookup
    signal: request.signal,
    lookup: pinnedLookup(request.addresses),
  };
  if (isHttps && isIP(hostname) === 0) options.servername = hostname.replace(/\.$/, "");

  const outgoing = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
    const status = res.statusCode ?? 0;
    const responseHeaders = toHeaders(res);
    // A response nobody is reading can still be torn down by the caller's abort signal. Whoever
    // reads the body sees that error through the stream; this keeps it from being unhandled.
    res.on("error", () => {});
    const close = () => {
      res.destroy();
    };

    const bodiless = request.method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200);
    if (bodiless) {
      close();
      resolve({ status, headers: responseHeaders, body: null, close });
      return;
    }

    const encodings = (responseHeaders.get("content-encoding") ?? "")
      .toLowerCase()
      .split(",")
      .map(part => part.trim())
      .filter(part => part !== "" && part !== "identity");

    const decoders: Transform[] = [];
    for (const encoding of encodings.reverse()) {
      const decoder = decoderFor(encoding);
      if (!decoder) {
        close();
        reject(new Error(`Unsupported content-encoding: ${encoding}`));
        return;
      }
      decoders.push(decoder);
    }

    const body: AsyncIterable<Uint8Array> = decoders.length === 0 ? res : decodedBody(res, decoders);
    resolve({ status, headers: responseHeaders, body, close });
  });

  outgoing.on("error", reject);
  outgoing.end();
});
