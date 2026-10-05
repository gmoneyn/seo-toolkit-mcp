/**
 * keyword_density — Analyze text for keyword frequency and density.
 * Reports: word count, unique words, top keywords, n-gram analysis, target keyword density.
 */

interface KeywordResult {
  totalWords: number;
  uniqueWords: number;
  targetKeyword: { keyword: string; count: number; density: string } | null;
  topSingleWords: Array<{ word: string; count: number; density: string }>;
  topBigrams: Array<{ phrase: string; count: number; density: string }>;
  topTrigrams: Array<{ phrase: string; count: number; density: string }>;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "it", "its",
  "this", "that", "these", "those", "i", "you", "he", "she", "we",
  "they", "me", "him", "her", "us", "them", "my", "your", "his",
  "our", "their", "what", "which", "who", "whom", "how", "when",
  "where", "why", "not", "no", "so", "if", "then", "than", "as",
  "up", "out", "about", "into", "over", "after", "also", "just",
  "more", "most", "very", "all", "each", "every", "both", "few",
  "some", "any", "other", "such", "only", "own", "same", "too",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1);
}

function getNgrams(words: string[], n: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i <= words.length - n; i++) {
    const gram = words.slice(i, i + n).join(" ");
    // Skip if any word is a stop word for bigrams/trigrams
    const gramWords = gram.split(" ");
    if (gramWords.some(w => STOP_WORDS.has(w))) continue;
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function topN(counts: Map<string, number>, n: number, total: number): Array<{ word?: string; phrase?: string; count: number; density: string }> {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({
      word: key,
      phrase: key,
      count,
      density: ((count / total) * 100).toFixed(2) + "%",
    }));
}

export function keywordDensity(text: string, targetKeyword?: string): string {
  const words = tokenize(text);
  const totalWords = words.length;

  if (totalWords === 0) {
    return JSON.stringify({ error: "No words found in the provided text." });
  }

  const uniqueWords = new Set(words).size;

  // Single word frequency (excluding stop words)
  const wordCounts = new Map<string, number>();
  for (const w of words) {
    if (!STOP_WORDS.has(w)) {
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
  }

  const bigrams = getNgrams(words, 2);
  const trigrams = getNgrams(words, 3);

  // Target keyword analysis
  let targetResult = null;
  if (targetKeyword) {
    const target = targetKeyword.toLowerCase().trim();
    const targetWords = target.split(/\s+/);
    let count = 0;

    if (targetWords.length === 1) {
      count = wordCounts.get(target) ?? 0;
    } else {
      // Count phrase occurrences
      const joined = words.join(" ");
      let idx = 0;
      while ((idx = joined.indexOf(target, idx)) !== -1) {
        count++;
        idx += target.length;
      }
    }

    targetResult = {
      keyword: targetKeyword,
      count,
      density: ((count / totalWords) * 100).toFixed(2) + "%",
    };
  }

  const result: KeywordResult = {
    totalWords,
    uniqueWords,
    targetKeyword: targetResult,
    topSingleWords: topN(wordCounts, 15, totalWords).map(({ word, count, density }) => ({ word: word!, count, density })),
    topBigrams: topN(bigrams, 10, totalWords).map(({ phrase, count, density }) => ({ phrase: phrase!, count, density })),
    topTrigrams: topN(trigrams, 10, totalWords).map(({ phrase, count, density }) => ({ phrase: phrase!, count, density })),
  };

  return JSON.stringify(result, null, 2);
}
