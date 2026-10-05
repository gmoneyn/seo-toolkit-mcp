/**
 * meta_tags — Fetch a URL and analyze its meta tags.
 * Reports: title, description, OG tags, Twitter tags, canonical, charset, viewport.
 */

import { fetchPage, extractMetaTags, extractTitle, extractCanonical } from "../utils/html.js";

interface MetaAnalysis {
  url: string;
  title: { value: string | null; length: number | null; ok: boolean; tip: string | null };
  description: { value: string | null; length: number | null; ok: boolean; tip: string | null };
  canonical: string | null;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  other: Record<string, string>;
  issues: string[];
  score: string;
}

export async function metaTags(url: string): Promise<string> {
  const { html } = await fetchPage(url);
  const tags = extractMetaTags(html);
  const title = extractTitle(html);
  const canonical = extractCanonical(html);

  const descTag = tags.find(t => t.name === "description");
  const description = descTag?.content ?? null;

  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const other: Record<string, string> = {};

  for (const tag of tags) {
    if (tag.property?.startsWith("og:")) {
      openGraph[tag.property] = tag.content;
    } else if (tag.name?.startsWith("twitter:") || tag.property?.startsWith("twitter:")) {
      twitter[tag.name ?? tag.property!] = tag.content;
    } else if (tag.name && tag.name !== "description") {
      other[tag.name] = tag.content;
    }
  }

  const issues: string[] = [];

  // Title checks
  const titleLen = title?.length ?? 0;
  let titleOk = true;
  let titleTip: string | null = null;
  if (!title) {
    issues.push("Missing <title> tag");
    titleOk = false;
    titleTip = "Add a unique, descriptive title (50-60 characters)";
  } else if (titleLen < 30) {
    titleTip = "Title is short. Aim for 50-60 characters for better CTR.";
  } else if (titleLen > 60) {
    titleTip = "Title may be truncated in SERPs. Keep under 60 characters.";
  }

  // Description checks
  const descLen = description?.length ?? 0;
  let descOk = true;
  let descTip: string | null = null;
  if (!description) {
    issues.push("Missing meta description");
    descOk = false;
    descTip = "Add a meta description (120-160 characters) to improve CTR.";
  } else if (descLen < 70) {
    descTip = "Description is short. Aim for 120-160 characters.";
  } else if (descLen > 160) {
    descTip = "Description may be truncated. Keep under 160 characters.";
  }

  // OG checks
  if (!openGraph["og:title"]) issues.push("Missing og:title");
  if (!openGraph["og:description"]) issues.push("Missing og:description");
  if (!openGraph["og:image"]) issues.push("Missing og:image (no preview image for social shares)");
  if (!openGraph["og:url"]) issues.push("Missing og:url");

  // Twitter checks
  if (!twitter["twitter:card"]) issues.push("Missing twitter:card");

  // Canonical
  if (!canonical) issues.push("No canonical URL set");

  const totalChecks = 8;
  const passed = totalChecks - issues.length;
  const score = `${passed}/${totalChecks}`;

  const result: MetaAnalysis = {
    url,
    title: { value: title, length: titleLen || null, ok: titleOk, tip: titleTip },
    description: { value: description, length: descLen || null, ok: descOk, tip: descTip },
    canonical,
    openGraph,
    twitter,
    other,
    issues,
    score,
  };

  return JSON.stringify(result, null, 2);
}
