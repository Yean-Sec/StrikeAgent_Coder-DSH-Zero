/**
 * Run one managed child agent for a pipeline lane.
 *
 * A run owns one root "control" agent; every lane is a `spawn` subagent of that
 * control agent with `delivery: 'caller'`, so results never leak into the
 * operator's conversation and each project gets its own capacity tree.
 */
import { access, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { contentText, extractJson, parseModelOverride, sleep } from './util.js';

const RESULT_POLL_MS = 1000;
const CANCEL_GRACE_MS = 8000;

/**
 * @param {object} options
 * @param {object} options.ctx plugin context
 * @param {object} options.config resolved plugin config
 * @param {() => object} options.settings current runtime settings
 * @param {object} options.capture session capture
 * @param {object} options.events event bus
 * @param {object} [options.logger]
 */
export function createRunner({ ctx, config, settings, capture, events, logger }) {
  const disposers = new Set();
  let presetCache = { at: 0, id: undefined };

  function getService(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve an agent preset that ships the fs/bash tools the audit needs.
   * `createAgent` without a preset gives the bare root composition.
   */
  async function resolvePreset() {
    if (presetCache.id !== undefined && Date.now() - presetCache.at < 60000) return presetCache.id;
    const presets = getService('agentPresets');
    if (presets === undefined || typeof presets.list !== 'function') return undefined;
    try {
      const list = await presets.list();
      const ids = (Array.isArray(list) ? list : [])
        .map((preset) => preset?.id ?? preset?.name)
        .filter((id) => typeof id === 'string' && id.length > 0);
      const preferred = ids.find((id) => /standard/i.test(id))
        ?? ids.find((id) => !/minimal/i.test(id))
        ?? ids[0];
      presetCache = { at: Date.now(), id: preferred };
      return preferred;
    } catch (error) {
      logger?.warn?.(`code-audit: cannot list agent presets: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Resolve the model used by audit sessions. */
  async function resolveSelection() {
    const runtime = settings();
    const override = parseModelOverride(runtime.modelOverride || config.modelOverride);
    if (override !== undefined) {
      const llm = getService('llm');
      if (llm !== undefined && typeof llm.resolveModelInfo === 'function') {
        try {
          await withTimeout(llm.resolveModelInfo(override.provider, override.model), 15000);
        } catch (error) {
          throw new Error(`模型覆盖不可用（${override.provider}:${override.model}）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { agentOptions: override, source: 'override', label: `${override.provider}:${override.model}` };
    }
    const selection = getService('agentDefaultModel')?.currentSelection?.();
    if (selection !== null && selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      const agentOptions = { provider: selection.provider, model: selection.model };
      if (selection.reasoningEffort !== undefined) agentOptions.reasoningEffort = selection.reasoningEffort;
      return { agentOptions, source: 'default', label: `${selection.provider}:${selection.model}` };
    }
    return { agentOptions: undefined, source: 'inherit', label: '对话框默认模型' };
  }

  /** Best-effort unattended permission setup for the control session. */
  async function bootstrapPermissions(agent) {
    const notes = [];
    let mode;
    try {
      mode = getService('sandboxPolicy')?.resolve?.({ session: agent.session })?.mode;
    } catch {
      mode = undefined;
    }
    if (mode === 'danger-full-access') {
      try {
        getService('approval')?.setPolicy?.(agent, 'never');
        notes.push('权限：danger-full-access');
      } catch {
        /* policy switch is optional */
      }
      return { level: 'ok', mode, notes };
    }
    const presets = getService('permissionPresets');
    if (presets !== undefined && typeof presets.catalog === 'function' && typeof presets.set === 'function') {
      try {
        const catalog = presets.catalog();
        const options = Array.isArray(catalog?.options) ? catalog.options : [];
        const scored = [];
        for (const option of options) {
          let spec;
          try {
            spec = presets.resolve(option.value);
          } catch {
            spec = undefined;
          }
          if (spec?.sandbox === 'danger-full-access') {
            scored.push({ value: option.value, approval: spec.approval, name: option.name });
          }
        }
        scored.sort((left, right) => (right.approval === 'never' ? 1 : 0) - (left.approval === 'never' ? 1 : 0));
        if (scored.length > 0) {
          presets.set(agent.session, scored[0].value);
          notes.push(`权限：已切换到预设 ${scored[0].name ?? scored[0].value}`);
          try {
            getService('approval')?.setPolicy?.(agent, 'never');
          } catch {
            /* optional */
          }
          return { level: 'ok', mode: 'danger-full-access', notes };
        }
      } catch (error) {
        notes.push(`权限预设切换失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      getService('approval')?.setPolicy?.(agent, 'never');
    } catch {
      /* optional */
    }
    notes.push(`权限：当前模式为 ${mode ?? '未知'}，若子会话需要审批将按取消处理`);
    return { level: mode === undefined ? 'unknown' : 'degraded', mode, notes };
  }

  /**
   * Create the control agent for one run.
   * @returns {Promise<object>}
   */
  async function openControl({ project, cwd }) {
    const selection = await resolveSelection();
    const preset = await resolvePreset();
    const sessionId = `session-${randomUUID()}`;
    const options = {
      sessionId,
      meta: { cwd, ...(preset === undefined ? {} : { agentPreset: preset }) },
      ...(selection.agentOptions === undefined ? {} : { agentOptions: selection.agentOptions }),
    };
    let handle;
    const agents = getService('agents');
    if (agents !== undefined && typeof agents.create === 'function') {
      handle = await agents.create(options);
    } else {
      const loop = getService('agentLoop');
      if (loop === undefined || typeof loop.createAgent !== 'function') {
        throw new Error('DSH 未提供 agents/agentLoop 服务，无法创建审计会话');
      }
      handle = await loop.createAgent(ctx, options);
    }
    const agent = handle?.agent ?? handle;
    if (agent?.session === undefined || agent?.session === null) {
      throw new Error('审计会话创建失败：没有可用的 Agent');
    }
    if (typeof handle?.dispose === 'function') disposers.add(handle);
    const permission = await bootstrapPermissions(agent);
    return {
      agent,
      handle,
      sessionId: typeof agent.session.id === 'string' ? agent.session.id : sessionId,
      cwd,
      permission,
      selection,
      preset,
    };
  }

  /** Release one control agent and its descendants. */
  async function closeControl(control) {
    if (control?.handle === undefined) return;
    disposers.delete(control.handle);
    try {
      await withTimeout(control.handle.dispose(), 15000);
    } catch (error) {
      logger?.warn?.(`code-audit: control agent dispose failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Interrupt one child without waiting. */
  function interrupt(control, childId) {
    const subagents = getService('subagents');
    if (subagents === undefined || typeof subagents.interrupt !== 'function') return;
    try {
      subagents.interrupt(childId, { kind: 'ancestor', agent: control.agent });
    } catch (error) {
      logger?.warn?.(`code-audit: interrupt ${childId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function artifactValue(artifactPath) {
    if (typeof artifactPath !== 'string' || artifactPath.length === 0) return undefined;
    try {
      await access(artifactPath);
    } catch {
      return undefined;
    }
    try {
      const text = await readFile(artifactPath, 'utf8');
      if (text.trim().length === 0) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return extractJson(text);
      }
    } catch {
      return undefined;
    }
  }

  async function artifactReady(artifactPath) {
    if (typeof artifactPath !== 'string' || artifactPath.length === 0) return false;
    try {
      await access(artifactPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run one lane to completion.
   *
   * @param {object} input
   * @param {object} input.control control agent bundle
   * @param {object} input.project project record
   * @param {string} input.runId
   * @param {string} input.stage stage key
   * @param {'audit'|'verify'} input.phase
   * @param {string} input.key lane key
   * @param {string} input.label child label
   * @param {string} input.prompt
   * @param {string} input.artifactPath
   * @param {number} input.timeoutMs
   * @param {number} input.idleTimeoutMs
   * @param {number} [input.finishGraceMs]
   * @param {AbortSignal} [input.signal]
   */
  async function runLane(input) {
    const subagents = getService('subagents');
    if (subagents === undefined || typeof subagents.startActivation !== 'function') {
      return { ok: false, error: 'DSH 未提供 subagents 服务，无法派发子智能体', childId: null, text: '', artifact: undefined };
    }
    const childId = `session-${randomUUID()}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener?.('abort', onAbort, { once: true });
    capture.track(childId, {
      projectId: input.project.id,
      stage: input.stage,
      phase: input.phase,
      key: input.key,
      label: input.label,
    });
    let activation;
    try {
      activation = await subagents.startActivation({
        provider: config.subagentProvider,
        label: input.label,
        childId,
        delivery: 'caller',
        signal: controller.signal,
        request: {
          prompt: [{ type: 'text', text: input.prompt }],
          parent: input.control.agent,
          cwd: input.control.cwd,
          ...(input.control.preset === undefined ? {} : { agentPreset: input.control.preset }),
          maxDepth: 1,
        },
      });
    } catch (error) {
      capture.untrack(childId);
      input.signal?.removeEventListener?.('abort', onAbort);
      return {
        ok: false,
        error: `派发子智能体失败：${error instanceof Error ? error.message : String(error)}`,
        childId,
        text: '',
        artifact: undefined,
      };
    }
    events.push(input.project.id, {
      kind: 'agent_start',
      phase: input.phase,
      agent: input.label,
      text: `派发子智能体「${input.label}」`,
    });

    let settled;
    const resultPromise = activation.result;
    if (resultPromise !== undefined && typeof resultPromise.then === 'function') {
      resultPromise.then(
        (value) => { settled = { ok: true, result: value }; },
        (error) => { settled = { ok: false, error }; },
      );
    } else {
      settled = { ok: false, error: new Error('子智能体没有返回结果') };
    }

    const startedAt = Date.now();
    const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 90 * 60 * 1000;
    const idleTimeoutMs = Number.isFinite(input.idleTimeoutMs) ? input.idleTimeoutMs : 25 * 60 * 1000;
    const finishGraceMs = Number.isFinite(input.finishGraceMs) ? input.finishGraceMs : 2 * 60 * 1000;
    let cancelReason = '';

    while (settled === undefined) {
      await sleep(RESULT_POLL_MS);
      if (input.signal?.aborted === true) {
        cancelReason = 'aborted';
        break;
      }
      const now = Date.now();
      const lastActivity = capture.lastActivity(childId) ?? startedAt;
      if (now - startedAt > timeoutMs) {
        cancelReason = 'timeout';
        break;
      }
      if (now - lastActivity > idleTimeoutMs) {
        cancelReason = 'idle';
        break;
      }
      if (now - lastActivity > finishGraceMs && await artifactReady(input.artifactPath)) {
        cancelReason = 'grace';
        break;
      }
    }

    if (cancelReason.length > 0 && settled === undefined) {
      interrupt(input.control, childId);
      controller.abort();
      const deadline = Date.now() + CANCEL_GRACE_MS;
      while (settled === undefined && Date.now() < deadline) await sleep(250);
      if (settled === undefined) {
        try {
          await withTimeout(activation.dispose?.(), 5000);
        } catch {
          /* already gone */
        }
      }
    }

    const text = capture.lastText(childId) || (settled?.ok === true ? outputText(settled.result) : '');
    const artifact = await artifactValue(input.artifactPath);
    try {
      await withTimeout(activation.dispose?.(), 5000);
    } catch {
      /* already settled */
    }
    await sleep(50);
    capture.untrack(childId);
    input.signal?.removeEventListener?.('abort', onAbort);

    if (cancelReason.length > 0) {
      const reasonText = cancelReason === 'timeout'
        ? '阶段硬超时，已终止本轮'
        : cancelReason === 'idle'
          ? '连续无输出，已终止本轮'
          : cancelReason === 'grace'
            ? '已拿到产物，收尾宽限后终止会话'
            : '收到取消信号';
      return {
        ok: cancelReason === 'grace',
        cancelled: true,
        cancelReason,
        error: cancelReason === 'grace' ? '' : reasonText,
        childId,
        text,
        artifact,
        stopReason: 'aborted',
      };
    }

    if (settled?.ok !== true) {
      const failure = settled?.error;
      return {
        ok: false,
        error: `子智能体会话失败：${failure instanceof Error ? failure.message : String(failure ?? '未知错误')}`,
        childId,
        text,
        artifact,
        stopReason: 'error',
      };
    }

    const stopReason = String(settled.result?.stopReason ?? 'completed');
    if (stopReason === 'error' || stopReason === 'refusal') {
      return {
        ok: false,
        error: `子会话以 ${stopReason} 结束`,
        childId,
        text,
        artifact,
        stopReason,
      };
    }
    return {
      ok: true,
      childId,
      text: text || outputText(settled.result),
      artifact,
      structured: settled.result?.structured,
      stopReason,
    };
  }

  return {
    resolveSelection,
    resolvePreset,
    openControl,
    closeControl,
    runLane,
    interrupt,
    async dispose() {
      for (const handle of [...disposers]) {
        try {
          await withTimeout(handle.dispose(), 8000);
        } catch {
          /* best effort */
        }
        disposers.delete(handle);
      }
    },
  };
}

function outputText(result) {
  const blocks = Array.isArray(result?.output) ? result.output : [];
  return contentText(blocks);
}

async function withTimeout(promise, ms) {
  if (promise === undefined || promise === null || typeof promise.then !== 'function') return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`操作超时（${Math.round(ms / 1000)}s）`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
