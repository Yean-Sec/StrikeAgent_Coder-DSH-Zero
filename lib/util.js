/**
 * Small shared helpers: ids, time, atomic JSON writes, JSON extraction,
 * truncation and secret redaction. No plugin services are touched here.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** @returns {string} ISO timestamp. */
export function nowIso() {
  return new Date().toISOString();
}

/** @returns {number} epoch milliseconds. */
export function nowMs() {
  return Date.now();
}

/**
 * Mint one identifier.
 * @param {string} prefix
 * @returns {string}
 */
export function randomId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

/** Short id for projects and batches. */
export function shortId(prefix) {
  const stamp = Date.now().toString(36);
  const rand = randomUUID().replace(/-/gu, '').slice(0, 6);
  return `${prefix}-${stamp}-${rand}`;
}

/** @param {unknown} value */
export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {number} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ensure a directory exists.
 * @param {string} dir absolute path
 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Write one file atomically through a sibling temporary file.
 * @param {string} file absolute path
 * @param {string} text
 * @param {number} [mode]
 */
export async function atomicWriteFile(file, text, mode = 0o600) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const handle = await open(temporary, 'w', mode);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

/**
 * Write JSON atomically.
 * @param {string} file
 * @param {unknown} value
 */
export async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read JSON, returning a fallback when the file is absent or unreadable.
 * @param {string} file
 * @param {unknown} fallback
 */
export async function readJson(file, fallback) {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(file, 'utf8');
    if (raw.trim().length === 0) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** @param {unknown} value @param {number} max */
export function truncate(value, max = 2000) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

/** @param {string} value */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\bghp_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu,
  /\b(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',]{6,}/giu,
];

/**
 * Remove obvious credentials from text that will be stored or displayed.
 * @param {unknown} value
 */
export function redactSecrets(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  return text;
}

/** @param {string} value */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** @param {string} value */
export function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/gu, '\\|');
}

/** A safe file-name fragment (no separators, no dot-dot). */
export function safeFileName(value, fallback = 'file') {
  const text = String(value ?? '')
    .replace(/[/\\]/gu, '_')
    .replace(/[\u0000-\u001f]/gu, '')
    .replace(/\.{2,}/gu, '.')
    .trim();
  const cleaned = text.length > 0 ? text.slice(0, 120) : fallback;
  return cleaned === '.' || cleaned === '..' ? fallback : cleaned;
}

/**
 * Parse the first plausible JSON object from model text.
 *
 * Tries fenced blocks, the whole text, then every balanced object. Returns
 * undefined when nothing parses; never throws.
 * @param {unknown} input
 * @returns {unknown}
 */
export function extractJson(input) {
  if (typeof input !== 'string' || input.trim().length === 0) return undefined;
  const text = input.length > 4_000_000 ? input.slice(0, 4_000_000) : input;
  const candidates = [];
  for (const match of text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/giu)) {
    candidates.push(match[1].trim());
  }
  candidates.push(text.trim());
  for (const candidate of candidates) {
    const direct = tryParseJson(candidate);
    if (direct !== undefined) return direct;
    const balanced = scanBalancedObjects(candidate);
    if (balanced !== undefined) return balanced;
  }
  return undefined;
}

function tryParseJson(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function scanBalancedObjects(text) {
  const starts = [];
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') {
      starts.push(index);
      continue;
    }
    if (char === '}' && starts.length > 0) {
      const start = starts.pop();
      // Prefer the outermost object: an inner `{"b":1}` must not shadow `{"a":{"b":1}}`.
      if (starts.length > 0) continue;
      const slice = text.slice(start, index + 1);
      if (slice.length > 4_000_000) continue;
      const parsed = tryParseJson(slice);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

/**
 * Text of one assistant message content array.
 * @param {unknown} content
 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Normalize an unknown string into a known enum value. */
export function pickEnum(value, allowed, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return allowed.includes(text) ? text : fallback;
}

/** Parse "provider:model" (also accepts "provider/model"). */
export function parseModelOverride(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) return undefined;
  const match = text.match(/^([A-Za-z0-9._-]+)\s*[:/]\s*([A-Za-z0-9._-]+)$/u);
  if (match === null) return undefined;
  return { provider: match[1], model: match[2] };
}
