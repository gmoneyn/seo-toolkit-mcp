/**
 * Shared HTML utilities for SEO tools.
 * Uses native fetch + basic string parsing (no external DOM library).
 */

import { safeFetch } from "./safe-fetch.js";

export interface MetaTag {
  property?: string;
  name?: string;
  content: string;
}

export interface HeadingInfo {
  level: number;
  text: string;
}

/**
 * Fetch a page and return the HTML body as a string.
 * Public web addresses only (see safe-fetch.ts). Follows up to 5 redirects, times out at 15s,
 * and refuses bodies over 5 MB.
 */
export async function fetchPage(url: string): Promise<{ html: string; status: number; headers: Record<string, string>; redirected: boolean; finalUrl: string; responseTimeMs: number }> {
  const start = Date.now();
  const res = await safeFetch(url, {
    headers: { "User-Agent": "mcp-seo/1.0 (SEO analysis tool)" },
    timeoutMs: 15_000,
  });
  const html = await res.text();
  const responseTimeMs = Date.now() - start;

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });

  return { html, status: res.status, headers, redirected: res.redirected, finalUrl: res.url, responseTimeMs };
}

/**
 * Extract all <meta> tags from HTML.
 */
export function extractMetaTags(html: string): MetaTag[] {
  const tags: MetaTag[] = [];
  const regex = /<meta\s+([^>]*?)\/?>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const attrs = match[1];
    const property = getAttr(attrs, "property");
    const name = getAttr(attrs, "name");
    const content = getAttr(attrs, "content") ?? "";

    if (property || name) {
      tags.push({ property: property ?? undefined, name: name ?? undefined, content });
    }
  }

  return tags;
}

/**
 * Extract the <title> tag content.
 */
export function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : null;
}

/**
 * Extract canonical URL from <link rel="canonical">.
 */
export function extractCanonical(html: string): string | null {
  const match = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["'][^>]*\/?>/i)
    ?? html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["'][^>]*\/?>/i);
  return match ? match[1] : null;
}

/**
 * Extract all headings (H1-H6) from HTML.
 */
export function extractHeadings(html: string): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const regex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const level = parseInt(match[1], 10);
    const text = stripTags(match[2]).trim();
    if (text) {
      headings.push({ level, text });
    }
  }

  return headings;
}

/**
 * Extract all links from HTML.
 */
export function extractLinks(html: string): Array<{ href: string; text: string; isInternal: boolean }> {
  const links: Array<{ href: string; text: string; isInternal: boolean }> = [];
  const regex = /<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const href = getAttr(match[1], "href");
    const text = stripTags(match[2]).trim();
    if (href) {
      const isInternal = href.startsWith("/") || href.startsWith("#");
      links.push({ href, text, isInternal });
    }
  }

  return links;
}

/**
 * Strip HTML tags from a string.
 */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ");
}

/**
 * Get an attribute value from an HTML attribute string.
 */
function getAttr(attrs: string, name: string): string | null {
  const regex = new RegExp(`${name}=["']([^"']*)["']`, "i");
  const match = attrs.match(regex);
  return match ? match[1] : null;
}
