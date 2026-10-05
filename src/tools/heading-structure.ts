/**
 * heading_structure — Analyze the heading hierarchy (H1-H6) of a page.
 * Reports: heading tree, missing levels, duplicate H1s, and structure issues.
 */

import { fetchPage, extractHeadings, type HeadingInfo } from "../utils/html.js";

interface HeadingAnalysis {
  url: string;
  headingCount: number;
  headings: HeadingInfo[];
  hierarchy: Record<string, number>;
  issues: string[];
  outline: string;
  score: string;
}

export async function headingStructure(url: string): Promise<string> {
  const { html } = await fetchPage(url);
  const headings = extractHeadings(html);

  const hierarchy: Record<string, number> = { H1: 0, H2: 0, H3: 0, H4: 0, H5: 0, H6: 0 };
  for (const h of headings) {
    hierarchy[`H${h.level}`]++;
  }

  const issues: string[] = [];

  // H1 checks
  if (hierarchy.H1 === 0) {
    issues.push("Missing H1 tag. Every page should have exactly one H1.");
  } else if (hierarchy.H1 > 1) {
    issues.push(`Multiple H1 tags (${hierarchy.H1}). Use only one H1 per page.`);
  }

  // Check for skipped levels
  const usedLevels = headings.map(h => h.level);
  for (let i = 1; i < usedLevels.length; i++) {
    if (usedLevels[i] > usedLevels[i - 1] + 1) {
      issues.push(
        `Skipped heading level: H${usedLevels[i - 1]} → H${usedLevels[i]} ` +
        `(after "${headings[i - 1].text.slice(0, 40)}"). Don't skip levels.`
      );
    }
  }

  // First heading should be H1
  if (headings.length > 0 && headings[0].level !== 1) {
    issues.push(`First heading is H${headings[0].level}, not H1. Start with H1.`);
  }

  // Check for very long headings
  for (const h of headings) {
    if (h.text.length > 70) {
      issues.push(`H${h.level} "${h.text.slice(0, 40)}..." is ${h.text.length} chars. Keep headings under 70 chars.`);
    }
  }

  // Check for empty structure
  if (headings.length === 0) {
    issues.push("No headings found on the page. Add headings to structure your content.");
  }

  // Build outline
  const outline = headings
    .map(h => `${"  ".repeat(h.level - 1)}H${h.level}: ${h.text}`)
    .join("\n");

  const totalChecks = 4; // H1 exists, single H1, no skips, first is H1
  let passed = totalChecks;
  if (hierarchy.H1 === 0) passed--;
  if (hierarchy.H1 > 1) passed--;
  if (issues.some(i => i.includes("Skipped"))) passed--;
  if (headings.length > 0 && headings[0].level !== 1) passed--;

  const result: HeadingAnalysis = {
    url,
    headingCount: headings.length,
    headings,
    hierarchy,
    issues,
    outline: outline || "(no headings)",
    score: `${passed}/${totalChecks}`,
  };

  return JSON.stringify(result, null, 2);
}
