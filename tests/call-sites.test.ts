/**
 * Structural checks: every outbound request goes through safeFetch, and the version is the same
 * everywhere it is declared.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

/** Calls that open a network connection without going through the guard. */
const RAW_NETWORK_CALL = /(?<![A-Za-z0-9_$])fetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|from\s+["'](?:node:)?(?:http|https|http2|net|tls|dgram)["']|require\(\s*["'](?:node:)?(?:http|https|http2|net|tls|dgram)["']\s*\)|from\s+["'](?:undici|axios|got|node-fetch)["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** The only two files allowed to import anything network-shaped. Each has its own assertions below. */
const NETWORK_FILES = new Set(["utils/safe-fetch.ts", "utils/pinned-request.ts"]);
const read = (file: string) => readFileSync(join(srcDir, ...file.split("/")), "utf8");
const codeOnly = (text: string) => text.split("\n").filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line)).join("\n");

describe("outbound call sites", () => {
  // RED IF: a tool calls fetch() (or another network client) directly instead of safeFetch().
  it("no source file outside safe-fetch.ts / pinned-request.ts makes a raw network call", () => {
    const files = sourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(5);
    const offenders = files
      .filter(file => !NETWORK_FILES.has(relative(srcDir, file).split(sep).join("/")))
      .flatMap(file => readFileSync(file, "utf8").split("\n")
        .map((line, i) => ({ where: `${relative(root, file)}:${i + 1}`, line }))
        .filter(({ line }) => RAW_NETWORK_CALL.test(line)))
      .map(({ where, line }) => `${where}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  // RED IF: the pattern above stops matching the calls it exists to catch (a scanner that cannot
  // fail), or starts flagging the guarded call.
  it("the scanner matches raw calls and does not match the guarded one", () => {
    for (const raw of [
      "const res = await fetch(url, {",
      "await globalThis.fetch(x)",
      "response = await fetch (url)",
      'import http from "node:http";',
      'import { request } from "https";',
      'const net = require("net")',
      'import { fetch as f } from "undici";',
    ]) {
      expect(RAW_NETWORK_CALL.test(raw), raw).toBe(true);
    }
    for (const guarded of [
      "const res = await safeFetch(robotsUrl, {",
      "send({",
      'import { fetchPage } from "../utils/html.js";',
      "const { html } = await fetchPage(url);",
      'import { isIP } from "node:net-utils";',
    ]) {
      expect(RAW_NETWORK_CALL.test(guarded), guarded).toBe(false);
    }
  });

  // RED IF: safe-fetch.ts opens a connection itself, or grows a second send path that skips
  // resolvePublicUrl. It may hand a request to the transport in exactly one place.
  it("safe-fetch.ts opens no connection itself and sends through exactly one place", () => {
    const code = codeOnly(read("utils/safe-fetch.ts"));
    expect(code.match(/(?<![A-Za-z0-9_$])fetch\s*\(/g)).toBeNull();
    expect(code.match(/from\s+["'](?:node:)?(?:http|https|http2|tls|dgram)["']/g)).toBeNull();
    expect(code.match(/from\s+["']node:net["']/g)?.length).toBe(1);
    expect(code).toContain('import { isIP } from "node:net";');
    expect(code.match(/(?<![A-Za-z0-9_$.])send\(/g)?.length).toBe(1);
    expect(code.match(/resolvePublicUrl\(current, lookup, allowPrivate\)/g)?.length).toBe(1);
  });

  // RED IF: pinned-request.ts gains a request that does not carry the pinned lookup: a second
  // http(s) request call, or the one call losing `lookup: pinnedLookup(request.addresses)`.
  it("pinned-request.ts makes exactly one request, and it carries the pinned lookup", () => {
    const code = codeOnly(read("utils/pinned-request.ts"));
    expect(code.match(/(?<![A-Za-z0-9_$])fetch\s*\(/g)).toBeNull();
    expect(code.match(/\(isHttps \? httpsRequest : httpRequest\)\(options,/g)?.length).toBe(1);
    expect(code.match(/(?<![A-Za-z0-9_$])https?Request\s*\(/g)).toBeNull();
    expect(code.match(/\blookup: pinnedLookup\(request\.addresses\),/g)?.length).toBe(1);
    expect(code.match(/\bagent: false\b/g)?.length).toBe(1);
  });
});

describe("version", () => {
  // RED IF: package.json is bumped without the lockfile or the server's own version string
  // (src/index.ts said 1.0.0 while the package was at 1.0.2 before this check existed).
  it("is the same in package.json, package-lock.json and the server declaration", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const declared = /new McpServer\(\{\s*name:\s*"([^"]+)",\s*version:\s*"([^"]+)"/.exec(readFileSync(join(srcDir, "index.ts"), "utf8"));

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(declared?.[1]).toBe(pkg.name);
    expect(declared?.[2]).toBe(pkg.version);
  });
});
