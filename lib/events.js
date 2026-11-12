/**
 * Process-event ring, durable JSONL log and change broadcast.
 *
 * The console's live view and its replay feed both come from here; the
 * authoritative tool/assistant record still lives in each child Session log.
 */
import { appendFile, readFile, rename, stat } from 'node:fs/promises';

import { projectSummary } from './flow.js';
import { ensureDir, nowIso, nowMs, redactSecrets, truncate } from './util.js';
import path from 'node:path';

const RING_LIMIT = 2000;
const ROTATE_BYTES = 8 * 1024 * 1024;
const FRAME_THROTTLE_MS = 150;

const EVENT_KINDS = new Set(['system', 'agent_start', 'tool_use', 'text', 'result', 'error']);

/**
 * @param {object} options
 * @param {ReturnType<import('./paths.js').createPaths>} options.paths
 * @param {object} [options.logger]
 */
export function createEventBus({ paths, logger }) {
  /** @type {Map<string, object[]>} */
  const rings = new Map();
  let lastSeq = 0;
  /** @type {Map<string, number>} */
  const sizes = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const projectTimers = new Map();
  /** @type {Set<(frame: object) => void>} */
  const listeners = new Set();
  /** @type {Map<string, Promise<void>>} */
  const appendChains = new Map();

  function emit(frame) {
    for (const listener of [...listeners]) {
      try {
        listener(frame);
      } catch (error) {
        logger?.warn?.(`code-audit: SSE listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function nextSeq() {
    // Time-based and monotonic: survives a Host restart, so a project's event
    // stream never reuses a sequence number.
    const candidate = Date.now() * 1000;
    lastSeq = Math.max(candidate, lastSeq + 1);
    return lastSeq;
  }

  async function appendLine(projectId, line) {
    const file = paths.eventsFile(projectId);
    const previous = appendChains.get(projectId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        const size = sizes.get(projectId) ?? (await sizeOf(file));
        if (size > ROTATE_BYTES) {
          await rename(file, `${file}.1`).catch(() => undefined);
          sizes.set(projectId, 0);
        }
        await ensureDir(path.dirname(file));
        await appendFile(file, `${line}\n`, 'utf8');
        sizes.set(projectId, (sizes.get(projectId) ?? 0) + Buffer.byteLength(line, 'utf8') + 1);
      } catch (error) {
        logger?.warn?.(`code-audit: cannot append event for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    appendChains.set(projectId, next);
    await next;
  }

  async function sizeOf(file) {
    try {
      const info = await stat(file);
      return info.size;
    } catch {
      return 0;
    }
  }

  /**
   * Record one process event for a project.
   * @param {string} projectId
   * @param {object} input { kind, phase, agent?, tool?, text?, raw? }
   * @returns {object} stored event
   */
  function push(projectId, input) {
    const kind = EVENT_KINDS.has(input?.kind) ? input.kind : 'system';
    const event = {
      seq: nextSeq(),
      ts: nowMs(),
      at: nowIso(),
      kind,
      phase: input?.phase === 'verify' ? 'verify' : 'audit',
      agent: typeof input?.agent === 'string' ? truncate(input.agent, 80) : '',
      tool: typeof input?.tool === 'string' ? truncate(input.tool, 80) : '',
      text: truncate(redactSecrets(input?.text ?? ''), 2000),
    };
    const ring = rings.get(projectId) ?? [];
    ring.push(event);
    if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
    rings.set(projectId, ring);
    void appendLine(projectId, JSON.stringify(event)).catch((error) => logger?.warn?.(`code-audit: event log append failed: ${error instanceof Error ? error.message : String(error)}`));
    emit({ type: 'events', projectId, events: [event] });
    return event;
  }

  /**
   * Load the recent durable tail for one project when the ring is empty.
   * @param {string} projectId
   * @param {number} limit
   */
  async function history(projectId, limit = 500) {
    const existing = rings.get(projectId) ?? [];
    if (existing.length > 0) return existing.slice(-limit);
    try {
      const raw = await readFile(paths.eventsFile(projectId), 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);
      const parsed = [];
      for (const line of lines.slice(-Math.max(limit, 200))) {
        try {
          const value = JSON.parse(line);
          if (value !== null && typeof value === 'object') parsed.push(value);
        } catch {
          /* skip a torn final line */
        }
      }
      const ring = parsed.slice(-RING_LIMIT);
      rings.set(projectId, ring);
      return ring.slice(-limit);
    } catch {
      return [];
    }
  }

  /** Publish one project summary, throttled per project. */
  function projectChanged(project) {
    if (project === undefined || project === null) return;
    const id = project.id;
    if (projectTimers.has(id)) return;
    projectTimers.set(id, setTimeout(() => {
      projectTimers.delete(id);
      // Publish the caller's latest object; the store keeps one record per id.
      emit({ type: 'project', project: projectSummary(project) });
    }, FRAME_THROTTLE_MS));
  }

  /** Publish settings, monitors or recycle-log changes. */
  function metaChanged(payload) {
    emit({ type: 'meta', ...payload });
  }

  function settingsChanged(settings) {
    emit({ type: 'settings', settings });
  }

  function notice(message, tone = 'info') {
    emit({ type: 'notice', message: truncate(redactSecrets(message), 400), tone });
  }

  /** @param {(frame: object) => void} listener */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function forget(projectId) {
    rings.delete(projectId);
    sizes.delete(projectId);
    const timer = projectTimers.get(projectId);
    if (timer !== undefined) {
      clearTimeout(timer);
      projectTimers.delete(projectId);
    }
  }

  return {
    push,
    history,
    projectChanged,
    metaChanged,
    settingsChanged,
    notice,
    subscribe,
    forget,
    emit,
  };
}
