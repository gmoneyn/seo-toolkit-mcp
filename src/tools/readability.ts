/**
 * readability — Score text readability using Flesch-Kincaid and other metrics.
 * Reports: Flesch Reading Ease, Flesch-Kincaid Grade Level, word/sentence/syllable counts, reading time.
 */

interface ReadabilityResult {
  fleschReadingEase: { score: number; interpretation: string };
  fleschKincaidGrade: { score: number; interpretation: string };
  stats: {
    wordCount: number;
    sentenceCount: number;
    syllableCount: number;
    avgWordsPerSentence: number;
    avgSyllablesPerWord: number;
    readingTimeMinutes: number;
    paragraphCount: number;
  };
  tips: string[];
}

function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 3) return 1;

  // Basic syllable counting heuristic
  let count = 0;
  const vowels = "aeiouy";
  let prevVowel = false;

  for (let i = 0; i < word.length; i++) {
    const isVowel = vowels.includes(word[i]);
    if (isVowel && !prevVowel) count++;
    prevVowel = isVowel;
  }

  // Adjustments
  if (word.endsWith("e") && count > 1) count--;
  if (word.endsWith("le") && word.length > 2 && !vowels.includes(word[word.length - 3])) count++;
  if (count === 0) count = 1;

  return count;
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function splitWords(text: string): string[] {
  return text
    .replace(/[^a-zA-Z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 0);
}

function interpretFleschEase(score: number): string {
  if (score >= 90) return "Very Easy (5th grade)";
  if (score >= 80) return "Easy (6th grade)";
  if (score >= 70) return "Fairly Easy (7th grade)";
  if (score >= 60) return "Standard (8th-9th grade)";
  if (score >= 50) return "Fairly Difficult (10th-12th grade)";
  if (score >= 30) return "Difficult (college level)";
  return "Very Difficult (graduate level)";
}

function interpretGradeLevel(grade: number): string {
  if (grade <= 5) return "Elementary school level";
  if (grade <= 8) return "Middle school level";
  if (grade <= 12) return "High school level";
  if (grade <= 16) return "College level";
  return "Graduate level";
}

export function readability(text: string): string {
  const sentences = splitSentences(text);
  const words = splitWords(text);
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);

  const wordCount = words.length;
  const sentenceCount = Math.max(sentences.length, 1);
  const syllableCount = words.reduce((sum, w) => sum + countSyllables(w), 0);

  if (wordCount < 10) {
    return JSON.stringify({ error: "Text too short for meaningful analysis. Provide at least 10 words." });
  }

  const avgWordsPerSentence = wordCount / sentenceCount;
  const avgSyllablesPerWord = syllableCount / wordCount;

  // Flesch Reading Ease: 206.835 - 1.015 * (words/sentences) - 84.6 * (syllables/words)
  const fleschEase = 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;
  const clampedEase = Math.max(0, Math.min(100, Math.round(fleschEase * 10) / 10));

  // Flesch-Kincaid Grade Level: 0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
  const fkGrade = 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;
  const clampedGrade = Math.max(0, Math.round(fkGrade * 10) / 10);

  // Reading time (avg 238 words/min)
  const readingTimeMinutes = Math.round((wordCount / 238) * 10) / 10;

  const tips: string[] = [];
  if (avgWordsPerSentence > 25) {
    tips.push("Sentences are long (avg " + Math.round(avgWordsPerSentence) + " words). Break them up for better readability.");
  }
  if (avgSyllablesPerWord > 1.7) {
    tips.push("Many complex words. Use simpler alternatives where possible.");
  }
  if (clampedEase < 50) {
    tips.push("Text is difficult to read. Aim for a Flesch score of 60+ for general audiences.");
  }
  if (paragraphs.length === 1 && wordCount > 100) {
    tips.push("Single large paragraph. Break into smaller paragraphs for better scannability.");
  }

  const result: ReadabilityResult = {
    fleschReadingEase: {
      score: clampedEase,
      interpretation: interpretFleschEase(clampedEase),
    },
    fleschKincaidGrade: {
      score: clampedGrade,
      interpretation: interpretGradeLevel(clampedGrade),
    },
    stats: {
      wordCount,
      sentenceCount,
      syllableCount,
      avgWordsPerSentence: Math.round(avgWordsPerSentence * 10) / 10,
      avgSyllablesPerWord: Math.round(avgSyllablesPerWord * 100) / 100,
      readingTimeMinutes,
      paragraphCount: paragraphs.length,
    },
    tips,
  };

  return JSON.stringify(result, null, 2);
}
