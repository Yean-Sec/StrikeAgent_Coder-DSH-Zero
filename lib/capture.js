/**
 * Capture live child-Session events and turn them into console process events.
 *
 * Only tracked child sessions are considered; everything else (the operator's
 * own conversation, teammates, unrelated plugins) is ignored.
 */
import { contentText, nowMs, truncate } from './util.js';

const ARG_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'description', 'prompt', 'url', 'name'];

function summarizeArgs(name, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === 'object') {
    for (const key of ARG_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return truncate(value.trim().replace(/\s+/gu, ' '), 180);
      }
    }
  }
  return truncate(String(raw ?? '').replace(/\s+/gu, ' '), 180);
}

/**
 * @param {object} options
 * @param {object} options.ctx plugin context
 * @param {object} options.events event bus
 * @param {(info: {projectId: string, text: string, phase: string}) => void} [options.onActivity]
 * @param {object} [options.logger]
 */
export function createCapture({ ctx, events, onActivity, logger }) {
  /** @type {Map<string, object>} */
  const tracked = new Map();
  let disposed = false;

  function handle(session, event) {
    if (disposed) return;
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    const entry = tracked.get(sessionId);
    if (entry === undefined) return;
    entry.lastActivityAt = nowMs();
    const data = event?.data ?? {};
    if (event?.type === 'tool/call') {
      const tool = String(data.name ?? 'tool');
      const text = summarizeArgs(tool, data.arguments);
      entry.lastTool = tool;
      const line = `[${entry.label}] ${tool}：${text}`;
      events.push(entry.projectId, {
        kind: 'tool_use',
        phase: entry.phase,
        agent: entry.label,
        tool,
        text: line,
      });
      onActivity?.({ projectId: entry.projectId, text: line, phase: entry.phase });
      return;
    }
    if (event?.type === 'assistant/message') {
      const text = contentText(data.message?.content);
      if (text.length === 0) return;
      entry.lastText = text;
      entry.lastAssistantAt = nowMs();
      if (text.length >= 12 && text !== entry.lastPushedText) {
        entry.lastPushedText = text;
        const line = `[${entry.label}] ${truncate(text, 260)}`;
        events.push(entry.projectId, {
          kind: 'text',
          phase: entry.phase,
          agent: entry.label,
          text: line,
        });
        onActivity?.({ projectId: entry.projectId, text: line, phase: entry.phase });
      }
      return;
    }
    if (event?.type === 'turn/end') {
      const reason = data.reason ?? {};
      if (reason.kind === 'error') {
        events.push(entry.projectId, {
          kind: 'error',
          phase: entry.phase,
          agent: entry.label,
          text: `[${entry.label}] 子会话出错：${truncate(reason.error?.message ?? '未知错误', 400)}`,
        });
      }
      return;
    }
  }

  let disposeListener;
  try {
    disposeListener = ctx.on('session/event', handle);
  } catch (error) {
    logger?.warn?.(`code-audit: cannot subscribe to session events: ${error instanceof Error ? error.message : String(error)}`);
    disposeListener = undefined;
  }

  return {
    /** Start translating one child session. */
    track(childId, info) {
      tracked.set(String(childId), {
        ...info,
        childId: String(childId),
        startedAt: nowMs(),
        lastActivityAt: nowMs(),
        lastText: '',
        lastPushedText: '',
        lastTool: '',
      });
    },
    untrack(childId) {
      tracked.delete(String(childId));
    },
    /** Epoch millis of the last event for one child, or null. */
    lastActivity(childId) {
      return tracked.get(String(childId))?.lastActivityAt ?? null;
    },
    lastText(childId) {
      return tracked.get(String(childId))?.lastText ?? '';
    },
    has(childId) {
      return tracked.has(String(childId));
    },
    projectOf(childId) {
      return tracked.get(String(childId))?.projectId ?? null;
    },
    dispose() {
      disposed = true;
      try {
        disposeListener?.();
      } catch {
        /* already disposed */
      }
      tracked.clear();
    },
  };
}
