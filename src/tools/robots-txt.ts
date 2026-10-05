/**
 * robots_txt — Fetch and parse robots.txt for a domain.
 * Reports: user-agent rules, allowed/disallowed paths, sitemap URLs, crawl-delay.
 */

import { safeFetch } from "../utils/safe-fetch.js";

interface RobotsRule {
  userAgent: string;
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

interface RobotsAnalysis {
  url: string;
  found: boolean;
  rules: RobotsRule[];
  sitemaps: string[];
  issues: string[];
  summary: string;
}

export async function robotsTxt(url: string): Promise<string> {
  // Normalize to root domain robots.txt
  let robotsUrl: string;
  try {
    const parsed = new URL(url);
    robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
  } catch {
    return JSON.stringify({ error: `Invalid URL: ${url}` });
  }

  let text: string;
  let found: boolean;
  try {
    const res = await safeFetch(robotsUrl, {
      headers: { "User-Agent": "mcp-seo/1.0 (SEO analysis tool)" },
    });
    found = res.status === 200;
    text = found ? await res.text() : "";
  } catch (e) {
    return JSON.stringify({ error: `Failed to fetch ${robotsUrl}: ${(e as Error).message}` });
  }

  if (!found) {
    return JSON.stringify({
      url: robotsUrl,
      found: false,
      rules: [],
      sitemaps: [],
      issues: ["No robots.txt found. Search engines will crawl all pages by default."],
      summary: "No robots.txt file exists at this domain.",
    } satisfies RobotsAnalysis);
  }

  const lines = text.split("\n").map(l => l.trim());
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];
  const issues: string[] = [];

  let current: RobotsRule | null = null;

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;

    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const keyLower = key.toLowerCase().trim();

    if (keyLower === "user-agent") {
      if (current) rules.push(current);
      current = { userAgent: value, allow: [], disallow: [], crawlDelay: null };
    } else if (keyLower === "disallow" && current) {
      if (value) current.disallow.push(value);
    } else if (keyLower === "allow" && current) {
      if (value) current.allow.push(value);
    } else if (keyLower === "crawl-delay" && current) {
      const delay = parseFloat(value);
      if (!isNaN(delay)) current.crawlDelay = delay;
    } else if (keyLower === "sitemap") {
      sitemaps.push(value);
    }
  }

  if (current) rules.push(current);

  // Checks
  if (sitemaps.length === 0) {
    issues.push("No Sitemap directive found. Add one to help search engines discover pages.");
  }

  const wildcardBlock = rules.find(r => r.userAgent === "*");
  if (!wildcardBlock) {
    issues.push("No rules for User-agent: *. Consider adding a default rule set.");
  }

  const totalDisallowed = rules.reduce((sum, r) => sum + r.disallow.length, 0);
  if (totalDisallowed === 0) {
    issues.push("No Disallow rules. Everything is crawlable (may be intentional).");
  }

  const blockAll = rules.some(r => r.disallow.includes("/"));
  if (blockAll) {
    issues.push("WARNING: Disallow: / blocks ALL crawling for that user-agent.");
  }

  const summary = `Found ${rules.length} user-agent block(s), ${totalDisallowed} disallow rule(s), ${sitemaps.length} sitemap(s).`;

  const result: RobotsAnalysis = {
    url: robotsUrl,
    found: true,
    rules,
    sitemaps,
    issues,
    summary,
  };

  return JSON.stringify(result, null, 2);
}
