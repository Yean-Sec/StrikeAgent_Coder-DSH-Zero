/**
 * Source-tree language detection.
 *
 * A workspace audit has no language picker: the Host scans a bounded sample of
 * the tree, weights source files, and picks the dominant language. The
 * dispatcher agent may still correct it from the actual code.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'vendor', 'dist', 'build', 'target',
  'out', 'coverage', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.idea',
  '.vscode', 'bin', 'obj', 'Pods', 'bower_components', '.gradle', '.mvn',
]);

const EXT_LANGUAGE = new Map([
  ['java', 'java'],
  ['go', 'go'],
  ['py', 'python'],
  ['php', 'php'],
  ['js', 'jsts'], ['jsx', 'jsts'], ['ts', 'jsts'], ['tsx', 'jsts'], ['mjs', 'jsts'], ['cjs', 'jsts'], ['vue', 'jsts'], ['svelte', 'jsts'],
  ['rs', 'rust'],
  ['rb', 'ruby'],
  ['cs', 'csharp'],
  ['c', 'c'], ['h', 'c'],
  ['cc', 'cpp'], ['cpp', 'cpp'], ['cxx', 'cpp'], ['hpp', 'cpp'], ['hh', 'cpp'], ['hxx', 'cpp'],
  ['sol', 'solidity'],
]);

/** Weight source files: tests and generated files count less. */
function weightOf(file) {
  const lower = file.toLowerCase();
  if (/(^|\/)(test|tests|spec|__tests__|fixtures?|examples?|docs?)\//u.test(lower)) return 0.25;
  if (/(\.min\.js|\.bundle\.js|\.generated\.|\.d\.ts)$/u.test(lower)) return 0.1;
  return 1;
}

/**
 * Map one file name to a supported language.
 * @param {string} fileName
 * @returns {string|undefined}
 */
export function languageForFile(fileName) {
  const ext = path.extname(String(fileName)).replace(/^\./u, '').toLowerCase();
  return EXT_LANGUAGE.get(ext);
}

/**
 * Scan a bounded sample and return the dominant language.
 * @param {string} root absolute source root
 * @param {{maxFiles?: number, maxDepth?: number}} [options]
 * @returns {Promise<{language: string, scores: Record<string, number>, sampled: number}>}
 */
export async function detectLanguage(root, options = {}) {
  const maxFiles = Number(options.maxFiles) > 0 ? Number(options.maxFiles) : 8000;
  const maxDepth = Number(options.maxDepth) > 0 ? Number(options.maxDepth) : 8;
  const scores = {};
  let sampled = 0;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && sampled < maxFiles) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (sampled >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const language = languageForFile(entry.name);
      if (language === undefined) continue;
      const weight = weightOf(path.join(dir, entry.name));
      scores[language] = (scores[language] ?? 0) + weight;
      sampled += 1;
    }
  }
  let best = 'jsts';
  let bestScore = 0;
  for (const [language, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = language;
      bestScore = score;
    }
  }
  return { language: best, scores, sampled };
}

/** Human-readable summary for prompts and events. */
export function detectionSummary(result) {
  const rows = Object.entries(result.scores ?? {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([language, score]) => `${language}=${score.toFixed(1)}`);
  return `${result.language}（采样 ${result.sampled} 个源文件${rows.length > 0 ? `；${rows.join(', ')}` : ''}）`;
}
