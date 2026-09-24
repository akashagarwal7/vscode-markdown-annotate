/**
 * Text-quote anchoring (in the spirit of the W3C TextQuoteSelector).
 *
 * A highlight is stored as the exact text plus a little surrounding context.
 * Matching ignores whitespace entirely, because the rendered DOM and the
 * Markdown source never agree on it (soft breaks, indentation, block gaps).
 *
 * This module is shared by the extension host and the webview, so it must
 * stay dependency-free.
 */

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

/** How many characters of context are captured either side of a quote. */
export const CONTEXT_LENGTH = 32;

/** `text` with whitespace removed, plus the index in `text` of every kept char. */
export interface Stripped {
  chars: string;
  index: number[];
}

const WHITESPACE = /\s/;

export function isWhitespace(ch: string): boolean {
  return WHITESPACE.test(ch);
}

export function strip(text: string): Stripped {
  const parts: string[] = [];
  const index: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!WHITESPACE.test(text[i])) {
      parts.push(text[i]);
      index.push(i);
    }
  }
  return { chars: parts.join(''), index };
}

/** A match in stripped-character space: `[start, end)`. */
export interface QuoteMatch {
  start: number;
  end: number;
}

/**
 * Find the best occurrence of `quote` inside the stripped text `hay`.
 * Candidates are ranked by how much of the prefix/suffix context matches;
 * `distance` (lower is better) breaks ties, e.g. distance from a line hint.
 */
export function findQuote(
  hay: string,
  quote: TextQuote,
  distance?: (start: number) => number,
): QuoteMatch | undefined {
  const exact = strip(quote.exact).chars;
  if (!exact) {
    return undefined;
  }
  const prefix = strip(quote.prefix).chars;
  const suffix = strip(quote.suffix).chars;

  let best: QuoteMatch | undefined;
  let bestScore = -1;
  let bestDistance = Infinity;
  for (let i = hay.indexOf(exact); i !== -1; i = hay.indexOf(exact, i + 1)) {
    const end = i + exact.length;
    const score = matchBackwards(hay, i, prefix) + matchForwards(hay, end, suffix);
    const d = distance ? distance(i) : 0;
    if (score > bestScore || (score === bestScore && d < bestDistance)) {
      best = { start: i, end };
      bestScore = score;
      bestDistance = d;
    }
  }
  return best;
}

/** Number of trailing chars of `context` that appear immediately before `pos`. */
function matchBackwards(hay: string, pos: number, context: string): number {
  let n = 0;
  while (n < context.length && pos - n - 1 >= 0 && hay[pos - n - 1] === context[context.length - n - 1]) {
    n++;
  }
  return n;
}

/** Number of leading chars of `context` that appear starting at `pos`. */
function matchForwards(hay: string, pos: number, context: string): number {
  let n = 0;
  while (n < context.length && pos + n < hay.length && hay[pos + n] === context[n]) {
    n++;
  }
  return n;
}

/** Build a quote for `[start, end)` of `text`, trimming surrounding whitespace. */
export function quoteFromRange(text: string, start: number, end: number): TextQuote | undefined {
  while (start < end && WHITESPACE.test(text[start])) {
    start++;
  }
  while (end > start && WHITESPACE.test(text[end - 1])) {
    end--;
  }
  if (start >= end) {
    return undefined;
  }
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + CONTEXT_LENGTH),
  };
}
