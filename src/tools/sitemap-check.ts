/**
 * sitemap_check — Validate a sitemap.xml URL.
 * Reports: URL count, format, last modified dates, and common issues.
 */

import { safeFetch } from "../utils/safe-fetch.js";

interface SitemapAnalysis {
  url: string;
  found: boolean;
  format: "xml" | "index" | "text" | "unknown";
  urlCount: number;
  sampleUrls: string[];
  lastModDates: string[];
  childSitemaps: string[];
  issues: string[];
  summary: string;
}

export async function sitemapCheck(url: string): Promise<string> {
  let sitemapUrl: string;
  try {
    // If it looks like a domain (no path to sitemap), try /sitemap.xml
    const parsed = new URL(url);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      sitemapUrl = `${parsed.protocol}//${parsed.host}/sitemap.xml`;
    } else {
      sitemapUrl = url;
    }
  } catch {
    return JSON.stringify({ error: `Invalid URL: ${url}` });
  }

  let text: string;
  let status: number;
  try {
    const res = await safeFetch(sitemapUrl, {
      headers: { "User-Agent": "mcp-seo/1.0 (SEO analysis tool)" },
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    return JSON.stringify({ error: `Failed to fetch ${sitemapUrl}: ${(e as Error).message}` });
  }

  if (status !== 200) {
    return JSON.stringify({
      url: sitemapUrl,
      found: false,
      format: "unknown",
      urlCount: 0,
      sampleUrls: [],
      lastModDates: [],
      childSitemaps: [],
      issues: [`Sitemap returned HTTP ${status}. Not found or not accessible.`],
      summary: "Sitemap not found.",
    } satisfies SitemapAnalysis);
  }

  const issues: string[] = [];
  let format: SitemapAnalysis["format"] = "unknown";
  const urls: string[] = [];
  const lastModDates: string[] = [];
  const childSitemaps: string[] = [];

  // Detect sitemap index
  if (text.includes("<sitemapindex")) {
    format = "index";
    const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
    let match;
    while ((match = locRegex.exec(text)) !== null) {
      childSitemaps.push(match[1]);
    }
  } else if (text.includes("<urlset")) {
    format = "xml";
    // Extract URLs
    const urlBlockRegex = /<url>([\s\S]*?)<\/url>/gi;
    let block;
    while ((block = urlBlockRegex.exec(text)) !== null) {
      const locMatch = block[1].match(/<loc>\s*(.*?)\s*<\/loc>/i);
      if (locMatch) urls.push(locMatch[1]);

      const lastmodMatch = block[1].match(/<lastmod>\s*(.*?)\s*<\/lastmod>/i);
      if (lastmodMatch) lastModDates.push(lastmodMatch[1]);
    }
  } else if (text.trim().startsWith("http")) {
    format = "text";
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    urls.push(...lines);
  }

  // Checks
  if (format === "xml" || format === "text") {
    if (urls.length === 0) {
      issues.push("Sitemap contains 0 URLs.");
    } else if (urls.length > 50000) {
      issues.push(`Sitemap has ${urls.length} URLs. Max recommended per sitemap is 50,000.`);
    }

    // Check for non-HTTPS URLs
    const nonHttps = urls.filter(u => !u.startsWith("https://"));
    if (nonHttps.length > 0) {
      issues.push(`${nonHttps.length} URL(s) are not HTTPS.`);
    }

    // Check for duplicate URLs
    const unique = new Set(urls);
    if (unique.size < urls.length) {
      issues.push(`${urls.length - unique.size} duplicate URL(s) found.`);
    }
  }

  if (format === "index") {
    if (childSitemaps.length === 0) {
      issues.push("Sitemap index contains no child sitemaps.");
    }
  }

  if (lastModDates.length === 0 && format === "xml" && urls.length > 0) {
    issues.push("No <lastmod> dates found. Adding them helps search engines prioritize crawling.");
  }

  const urlCount = format === "index" ? childSitemaps.length : urls.length;
  const summary = format === "index"
    ? `Sitemap index with ${childSitemaps.length} child sitemap(s).`
    : `${format.toUpperCase()} sitemap with ${urls.length} URL(s).`;

  const result: SitemapAnalysis = {
    url: sitemapUrl,
    found: true,
    format,
    urlCount,
    sampleUrls: urls.slice(0, 10),
    lastModDates: [...new Set(lastModDates)].slice(0, 5),
    childSitemaps,
    issues,
    summary,
  };

  return JSON.stringify(result, null, 2);
}
