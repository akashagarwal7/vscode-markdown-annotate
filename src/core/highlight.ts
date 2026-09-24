/**
 * Syntax highlighting for fenced code blocks, done while rendering so the
 * webview only needs a stylesheet. Only a curated set of languages is bundled
 * to keep the extension small; unknown languages render as plain text.
 */
import type { HLJSApi, Language } from 'highlight.js';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash: bashWithCommands,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  php,
  plaintext,
  powershell,
  python,
  ruby,
  rust,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

/**
 * highlight.js's Bash grammar only colours built-ins, keywords, strings,
 * variables and comments, so a typical `npm install --save x` line comes out
 * plain. Like Prism (used by Markdown Preview Enhanced), also colour the
 * command word of each command and its `-f` / `--flag` options.
 */
function bashWithCommands(api: HLJSApi): Language {
  const base = bash(api);
  const reserved = 'if|then|else|elif|fi|for|while|until|in|do|done|case|esac|function|select|time|coproc';
  // relevance 0: these match almost any text, so they must not sway auto-detection.
  const command = {
    scope: 'title.function',
    relevance: 0,
    // At the start of a line or after | || && ; ( { or a prefix like sudo/then/do,
    // but not a keyword and not a VAR=value assignment.
    match: new RegExp(
      `(?<=^[ \\t]*|[|&;({][ \\t]*|\\b(?:then|do|else|sudo|exec|xargs|nohup|env)[ \\t]+)` +
        `(?!(?:${reserved})\\b)(?![\\w.\\/~+-]*=)[A-Za-z_.\\/~][\\w.\\/~+-]*`,
    ),
  };
  const flag = {
    scope: 'attr',
    relevance: 0,
    match: /(?<=\s)--?[A-Za-z0-9][\w-]*/,
  };
  return { ...base, contains: [command, flag, ...(base.contains ?? [])] };
}

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language);
}
// Common fence names the grammars don't already alias.
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' });
hljs.registerAliases(['toml'], { languageName: 'ini' });
hljs.registerAliases(['scss', 'sass', 'less'], { languageName: 'css' });
hljs.registerAliases(['vue', 'svelte'], { languageName: 'xml' });

// Languages tried when a fence has no language. Markdown and plain text are
// left out: they "match" almost anything.
const AUTO_DETECT = Object.keys(LANGUAGES).filter((l) => l !== 'markdown' && l !== 'plaintext');

/**
 * highlight.js maps these tags to "Shell Session", which only colours lines
 * starting with a prompt. Without prompts, treat them as Bash (as Prism does).
 */
const SESSION_TAGS = new Set(['shell', 'console', 'shellsession', 'terminal']);
const PROMPT_LINE = /^\s*(?:\S*@\S*[:\s].*)?[$#%>] /m;
hljs.registerAliases(['terminal'], { languageName: 'shell' });

/** Below this highlight.js relevance, a guess is more likely wrong than right. */
const MIN_RELEVANCE = 3;

/**
 * markdown-it `highlight` option. Tagged fences use their language; untagged
 * ones are auto-detected. Returns '' to fall back to escaped plain text.
 */
export function highlightCode(code: string, info: string): string {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase();
  try {
    if (lang) {
      const language = SESSION_TAGS.has(lang) && !PROMPT_LINE.test(code) ? 'bash' : lang;
      return hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : '';
    }
    const guess = hljs.highlightAuto(code, AUTO_DETECT);
    return guess.relevance >= MIN_RELEVANCE ? guess.value : '';
  } catch {
    return '';
  }
}
