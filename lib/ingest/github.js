/**
 * GitHub (or any git remote) ingestion: preview before create, shallow clone.
 *
 * No hosting-provider API is used, so private repositories work when the
 * machine already has git credentials. Interactive prompts are disabled.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { runCommand } from '../process.js';
import { ensureDir, truncate } from '../util.js';

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
};

/**
 * Validate and normalize one repository URL.
 * @param {unknown} value
 * @returns {string} normalized URL
 */
export function normalizeRepoUrl(value) {
  const text = String(value ?? '').trim();
  if (text.length === 0) throw new Error('仓库地址为空');
  if (text.length > 2048) throw new Error('仓库地址过长');
  if (/[\s\u0000]/u.test(text)) throw new Error('仓库地址包含空白或非法字符');
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/iu.test(text)) {
    throw new Error('仓库地址必须以 https://、ssh://、git:// 或 git@ 开头');
  }
  return text.replace(/\/+$/u, '');
}

/** Repository name from a URL. */
export function repoName(value) {
  const text = String(value ?? '').replace(/\/+$/u, '');
  const tail = text.split(/[/:]/u).filter(Boolean).pop() ?? 'repository';
  return tail.replace(/\.git$/iu, '');
}

/** Compare two version-like strings; tags sort newest first. */
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value).match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/iu);
    if (match === null) return null;
    return {
      parts: [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)],
      suffix: match[4] ?? '',
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (a === null && b === null) return String(right).localeCompare(String(left));
  if (a === null) return 1;
  if (b === null) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return b.parts[index] - a.parts[index];
  }
  if (a.suffix === b.suffix) return 0;
  if (a.suffix === '') return -1;
  if (b.suffix === '') return 1;
  return b.suffix.localeCompare(a.suffix);
}

/** Parse `git ls-remote --tags --refs` output. */
export function parseTagListing(output) {
  const tags = new Map();
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const match = line.match(/^([0-9a-f]{7,40})\s+refs\/tags\/(.+)$/u);
    if (match === null) continue;
    const tag = match[2].replace(/\^\{\}$/u, '');
    tags.set(tag, match[1]);
  }
  return [...tags.entries()]
    .map(([name, commit]) => ({ name, commit }))
    .sort((left, right) => compareVersions(left.name, right.name));
}

/**
 * Preview one repository: tags, default ref and HEAD commit.
 * @param {{url:string, timeoutMs?:number}} input
 */
export async function previewRepo({ url, timeoutMs = 20000 }) {
  const repoUrl = normalizeRepoUrl(url);
  const tagsResult = await runCommand('git', ['ls-remote', '--tags', '--refs', repoUrl], {
    timeoutMs,
    env: GIT_ENV,
  });
  const tags = parseTagListing(tagsResult.stdout);
  let head = '';
  try {
    const headResult = await runCommand('git', ['ls-remote', repoUrl, 'HEAD'], { timeoutMs, env: GIT_ENV });
    head = String(headResult.stdout ?? '').trim().split(/\s+/u)[0] ?? '';
  } catch {
    head = '';
  }
  return {
    url: repoUrl,
    repo: repoName(repoUrl),
    tags: tags.slice(0, 200),
    latestTag: tags[0]?.name ?? null,
    defaultRef: tags[0]?.name ?? 'HEAD',
    commit: head,
  };
}

/**
 * Shallow-clone one repository at a tag/branch/commit.
 * @param {{url:string, ref?:string, destination:string, timeoutMs?:number, logger?:object}} input
 */
export async function cloneRepo({ url, ref, destination, timeoutMs = 15 * 60 * 1000, logger }) {
  const repoUrl = normalizeRepoUrl(url);
  const target = path.resolve(destination);
  await rm(target, { recursive: true, force: true });
  await ensureDir(path.dirname(target));
  const requested = typeof ref === 'string' && ref.trim().length > 0 ? ref.trim() : '';
  if (requested.length > 0) {
    try {
      await runCommand('git', ['clone', '--depth', '1', '--branch', requested, '--single-branch', repoUrl, target], {
        timeoutMs,
        env: GIT_ENV,
      });
      return { ref: requested };
    } catch (error) {
      if (!/^[0-9a-f]{7,40}$/iu.test(requested)) {
        throw new Error(`克隆失败（ref=${requested}）：${truncate(error instanceof Error ? error.message : String(error), 800)}`);
      }
      logger?.info?.(`code-audit: branch clone failed for commit ${requested}; fetching the exact commit`);
    }
  }
  await ensureDir(target);
  await runCommand('git', ['init', '-q'], { cwd: target, timeoutMs: 60000, env: GIT_ENV });
  await runCommand('git', ['remote', 'add', 'origin', repoUrl], { cwd: target, timeoutMs: 60000, env: GIT_ENV });
  const fetchRef = requested.length > 0 ? requested : 'HEAD';
  await runCommand('git', ['fetch', '--depth', '1', 'origin', fetchRef], { cwd: target, timeoutMs, env: GIT_ENV });
  await runCommand('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: target, timeoutMs: 60000, env: GIT_ENV });
  return { ref: requested || 'HEAD' };
}

/** Resolve the short commit id of a cloned tree. */
export async function currentCommit(directory) {
  try {
    const result = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd: directory, timeoutMs: 20000, env: GIT_ENV });
    return String(result.stdout ?? '').trim() || null;
  } catch {
    return null;
  }
}

/** List remote tags for the monitor check. */
export async function listTags(url, timeoutMs = 20000) {
  const result = await runCommand('git', ['ls-remote', '--tags', '--refs', normalizeRepoUrl(url)], {
    timeoutMs,
    env: GIT_ENV,
  });
  return parseTagListing(result.stdout);
}
