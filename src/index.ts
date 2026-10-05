/**
 * seo-toolkit-mcp — SEO toolkit MCP server.
 * Analyze meta tags, robots.txt, sitemaps, keyword density, readability, and heading structure.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { metaTags } from "./tools/meta-tags.js";
import { robotsTxt } from "./tools/robots-txt.js";
import { sitemapCheck } from "./tools/sitemap-check.js";
import { keywordDensity } from "./tools/keyword-density.js";
import { readability } from "./tools/readability.js";
import { headingStructure } from "./tools/heading-structure.js";

const server = new McpServer({
  name: "seo-toolkit-mcp",
  version: "1.0.3",
});

// --- TOOLS ---

server.tool(
  "meta_tags",
  "Fetch a URL and analyze its SEO meta tags. Returns title (with length check), meta description, Open Graph tags, Twitter Card tags, canonical URL, and actionable issues. Use this to audit any page's on-page SEO.",
  {
    url: z.string().url().describe("The full URL to analyze (e.g. https://example.com/page)"),
  },
  async ({ url }) => {
    try {
      const result = await metaTags(url);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "robots_txt",
  "Fetch and parse a site's robots.txt. Returns user-agent rules, allowed/disallowed paths, sitemap directives, crawl-delay, and issues. Use this to check what search engines can/cannot crawl.",
  {
    url: z.string().describe("Domain or URL (e.g. https://example.com). Will check /robots.txt at the root."),
  },
  async ({ url }) => {
    try {
      const result = await robotsTxt(url);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "sitemap_check",
  "Validate a sitemap.xml file. Returns URL count, format (XML/index/text), sample URLs, last modified dates, and issues like duplicates or missing lastmod. Pass a domain to check /sitemap.xml, or a direct sitemap URL.",
  {
    url: z.string().describe("Sitemap URL or domain (e.g. https://example.com or https://example.com/sitemap.xml)"),
  },
  async ({ url }) => {
    try {
      const result = await sitemapCheck(url);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "keyword_density",
  "Analyze text for keyword frequency and density. Returns top single words, bigrams, and trigrams with percentages. Optionally check density of a specific target keyword. Use to optimize content for target keywords.",
  {
    text: z.string().describe("The text content to analyze"),
    target_keyword: z.string().optional().describe("Optional: a specific keyword or phrase to check density for"),
  },
  async ({ text, target_keyword }) => {
    try {
      const result = keywordDensity(text, target_keyword);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "readability",
  "Score text readability using Flesch-Kincaid metrics. Returns Flesch Reading Ease score, grade level, word/sentence/syllable counts, average sentence length, reading time, and actionable tips. Use to ensure content matches your target audience.",
  {
    text: z.string().describe("The text content to analyze (at least 10 words)"),
  },
  async ({ text }) => {
    try {
      const result = readability(text);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

server.tool(
  "heading_structure",
  "Analyze a page's heading hierarchy (H1-H6). Returns the heading outline/tree, counts per level, and issues like missing H1, multiple H1s, or skipped levels. Use to verify content structure for SEO and accessibility.",
  {
    url: z.string().url().describe("The full URL to analyze (e.g. https://example.com/page)"),
  },
  async ({ url }) => {
    try {
      const result = await headingStructure(url);
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }
);

// --- END TOOLS ---

const transport = new StdioServerTransport();
await server.connect(transport);
