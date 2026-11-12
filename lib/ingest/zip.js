/**
 * Zip ingestion.
 *
 * The upload itself is streamed to disk by the API. This module validates the
 * archive's entry names before extraction, unpacks with the system `unzip`,
 * enforces size/entry limits and removes symlinks that escape the source tree.
 */
import { cp, lstat, mkdir, readdir, rm, stat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

import { runCommand } from '../process.js';
import { ensureDir } from '../util.js';

const SKIP_PREFIXES = ['__MACOSX/'];
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Validate one archive entry name.
 * @param {string} name
 * @returns {string} a reason when the name is unsafe, otherwise ''
 */
export function unsafeEntryReason(name) {
  if (typeof name !== 'string' || name.length === 0) return '空条目名';
  if (name.includes('\u0000')) return '条目名包含空字节';
  const normalized = name.replace(/\\/gu, '/');
  if (normalized.startsWith('/')) return '条目使用绝对路径';
  if (/^[A-Za-z]:\//u.test(normalized)) return '条目使用盘符路径';
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) return '条目包含 .. 路径穿越';
  return '';
}

/**
 * Filter a raw `unzip -Z1` listing into safe, extractable names.
 * @param {string} listing
 * @param {number} maxFiles
 */
export function parseZipListing(listing, maxFiles = 200000) {
  const names = String(listing ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const problems = [];
  const safe = [];
  for (const name of names) {
    const normalized = name.replace(/\\/gu, '/');
    if (SKIP_PREFIXES.some((prefix) => normalized.startsWith(prefix))) continue;
    if (SKIP_NAMES.has(path.posix.basename(normalized))) continue;
    if (normalized.endsWith('/')) {
      safe.push(normalized);
      continue;
    }
    const reason = unsafeEntryReason(normalized);
    if (reason.length > 0) {
      problems.push(`${reason}：${name}`);
      continue;
    }
    safe.push(normalized);
  }
  if (safe.length > maxFiles) {
    problems.push(`条目数量 ${safe.length} 超过上限 ${maxFiles}`);
  }
  return { names: safe, problems };
}

async function walk(root, limits) {
  let files = 0;
  let bytes = 0;
  const symlinks = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(absolute);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      files += 1;
      try {
        const info = await stat(absolute);
        bytes += info.size;
      } catch {
        /* ignore unreadable entry */
      }
      if (files > limits.maxFiles) throw new Error(`解压后文件数超过上限 ${limits.maxFiles}`);
      if (bytes > limits.maxBytes) throw new Error(`解压后体积超过上限 ${Math.round(limits.maxBytes / 1024 / 1024)} MiB`);
    }
  }
  return { files, bytes, symlinks };
}

/**
 * Extract an archive into a fresh directory and return the source root.
 * @param {object} options
 * @param {string} options.archivePath
 * @param {string} options.destination
 * @param {{maxFiles:number,maxBytes:number}} options.limits
 * @param {object} [options.logger]
 * @returns {Promise<{sourceRoot:string, files:number, bytes:number}>}
 */
export async function extractArchive({ archivePath, destination, limits, logger }) {
  const listing = await runCommand('unzip', ['-Z1', archivePath], {
    timeoutMs: 10 * 60 * 1000,
    maxBuffer: 128 * 1024 * 1024,
  });
  const parsed = parseZipListing(listing.stdout, limits.maxFiles);
  if (parsed.problems.length > 0) {
    throw new Error(`压缩包安全检查未通过：${parsed.problems.slice(0, 5).join('；')}`);
  }
  const temporary = `${destination}.tmp-${Date.now().toString(36)}`;
  await rm(temporary, { recursive: true, force: true });
  await ensureDir(temporary);
  try {
    await runCommand('unzip', ['-qq', '-o', archivePath, '-d', temporary], {
      timeoutMs: 30 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const walked = await walk(temporary, { maxFiles: limits.maxFiles, maxBytes: limits.maxBytes });
    if (walked.symlinks.length > 0) {
      logger?.warn?.(`code-audit: removing ${walked.symlinks.length} symlink(s) from the extracted archive`);
      for (const link of walked.symlinks) {
        await unlink(link).catch(() => undefined);
      }
    }
    const sourceRoot = await promoteSingleRoot(temporary);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    if (sourceRoot !== temporary) {
      await cp(sourceRoot, destination, { recursive: true });
      await rm(temporary, { recursive: true, force: true });
    } else {
      await cp(temporary, destination, { recursive: true });
      await rm(temporary, { recursive: true, force: true });
    }
    return { sourceRoot: destination, files: walked.files, bytes: walked.bytes };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** If an archive contains exactly one top-level directory, use it as the root. */
async function promoteSingleRoot(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== 1) return directory;
  const only = entries[0];
  if (!only.isDirectory()) return directory;
  const nested = path.join(directory, only.name);
  try {
    const link = await lstat(nested);
    if (link.isSymbolicLink()) return directory;
  } catch {
    return directory;
  }
  return nested;
}

/** Preserve a symlink helper for tests that build fixtures. */
export async function writeSymlink(target, linkPath) {
  await symlink(target, linkPath);
}
