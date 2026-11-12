/**
 * Project scheduler and stage state machine.
 *
 * One audit run and one verification run may exist per project (never two of
 * the same kind). Audit slots, verification slots and global child slots are
 * enforced independently; the environment can be pre-warmed while the audit
 * lane is still running.
 */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { AUDIT_STAGES, VERIFY_STAGES } from './constants.js';
import { runCommand } from './process.js';
import { runDirOf, sourceDirOf } from './project-paths.js';
import { loadPipeline, deriveFindings, summarizeFindings, computeFrontendRce } from './pipeline.js';
import { createAuditStages } from './stages/audit.js';
import { createVerifyStages } from './stages/verify.js';
import {
  atomicWriteJson,
  clamp,
  ensureDir,
  nowIso,
  readJson,
  shortId,
  sleep,
  truncate,
} from './util.js';

const TICK_MS = 1500;
const RUN_KEEP = 5;

const ZERO_COUNTS = Object.freeze({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

function allStageKeys() {
  return [...AUDIT_STAGES.map((stage) => stage.key), ...VERIFY_STAGES.map((stage) => stage.key)];
}

function freshStageStatus() {
  const status = {};
  for (const key of allStageKeys()) status[key] = 'pending';
  status.history = 'pending';
  return status;
}

/**
 * @param {object} options
 */
export function createOrchestrator({ ctx, config, store, events, runner, reporter, paths, logger }) {
  const auditStages = createAuditStages();
  const verifyStages = createVerifyStages();
  /** @type {Map<string, object>} */
  const runs = new Map();
  /** @type {Map<string, object>} */
  const envRuns = new Map();
  const prewarmed = new Set();
  const childSlots = { active: 0, limit: 24, waiters: [] };
  let tickTimer = null;
  let ticking = false;

  function wakeChildWaiters() {
    while (childSlots.waiters.length > 0 && childSlots.active < childSlots.limit) {
      const next = childSlots.waiters.shift();
      childSlots.active += 1;
      next();
    }
  }

  function setChildLimit(limit) {
    childSlots.limit = Math.max(1, limit);
    wakeChildWaiters();
  }

  function acquireChild() {
    if (childSlots.active < childSlots.limit) {
      childSlots.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => childSlots.waiters.push(resolve));
  }

  function releaseChild() {
    childSlots.active = Math.max(0, childSlots.active - 1);
    wakeChildWaiters();
  }

  function getService(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
    } catch {
      return undefined;
    }
  }

  function runtimeSettings() {
    const saved = store.getSettings();
    const merged = {
      ...config,
      ...(store.settingsLoaded ? saved : {}),
    };
    merged.maxConcurrentAudit = clamp(merged.maxConcurrentAudit, 1, 10);
    merged.maxConcurrentVerify = clamp(merged.maxConcurrentVerify, 1, 10);
    merged.maxConcurrentEnv = clamp(merged.maxConcurrentEnv, 1, 10);
    merged.maxConcurrentChildren = clamp(merged.maxConcurrentChildren, 1, 64);
    merged.laneConcurrency = clamp(merged.laneConcurrency, 1, 8);
    merged.laneBatchSize = clamp(merged.laneBatchSize, 1, 50);
    merged.stageTimeoutMs = clamp(merged.stageTimeoutMs, 60000, 86400000);
    merged.idleTimeoutMs = clamp(merged.idleTimeoutMs, 60000, 86400000);
    merged.verifyTimeoutMs = clamp(merged.verifyTimeoutMs, 60000, 86400000);
    merged.verifyIdleTimeoutMs = clamp(merged.verifyIdleTimeoutMs, 30000, 86400000);
    merged.finishGraceMs = clamp(merged.finishGraceMs, 10000, 3600000);
    if (merged.protectPages === true) {
      merged.maxConcurrentAudit = Math.min(merged.maxConcurrentAudit, 2);
      merged.maxConcurrentVerify = Math.min(merged.maxConcurrentVerify, 2);
      merged.laneConcurrency = Math.min(merged.laneConcurrency, 2);
    }
    return merged;
  }

  function syncChildSlots(settings) {
    setChildLimit(settings.maxConcurrentChildren);
  }

  function publish(project) {
    store.updateProject(project.id, {});
    events.projectChanged(project);
  }

  function note(project, phase, text, tone = 'system') {
    const line = truncate(text, 400);
    project.activity = { text: line, at: nowIso(), phase };
    events.push(project.id, { kind: 'system', phase, text: line });
    publish(project);
    if (tone === 'error') logger?.warn?.(`code-audit[${project.id}]: ${line}`);
  }

  function makeRun(project, kind, control, settings) {
    const runId = project.runId;
    const runDir = runDirOf(paths, project, runId);
    const run = {
      kind,
      project,
      control,
      settings,
      store,
      runId,
      runDir,
      srcDir: sourceDirOf(paths, project),
      pipeline: null,
      paused: false,
      controller: new AbortController(),
    };
    run.artifact = (relative) => path.join(runDir, relative);
    run.artifactDir = (relative) => path.join(runDir, relative);
    run.write = async (relative, value) => {
      const absolute = run.artifact(relative);
      await ensureDir(path.dirname(absolute));
      await atomicWriteJson(absolute, value);
    };
    run.read = (relative) => readJson(run.artifact(relative), undefined);
    run.note = (text, tone = 'system') => note(project, kind === 'audit' ? 'audit' : 'verify', text, tone);
    run.lane = async (laneInput) => {
      if (run.paused) return { ok: false, cancelled: true, error: '已暂停', text: '', artifact: undefined };
      await acquireChild();
      try {
        if (run.paused) return { ok: false, cancelled: true, error: '已暂停', text: '', artifact: undefined };
        return await runner.runLane({
          control: run.control,
          project,
          runId: run.runId,
          phase: kind === 'audit' ? 'audit' : 'verify',
          signal: run.controller.signal,
          finishGraceMs: settings.finishGraceMs,
          ...laneInput,
          timeoutMs: laneInput.timeoutMs ?? settings.stageTimeoutMs,
          idleTimeoutMs: laneInput.idleTimeoutMs ?? settings.idleTimeoutMs,
        });
      } finally {
        releaseChild();
      }
    };
    return run;
  }

  async function interruptAll(control) {
    const subagents = getService('subagents');
    if (control === null || control === undefined) return;
    if (subagents === undefined || typeof subagents.listDescendants !== 'function' || typeof subagents.interrupt !== 'function') return;
    try {
      const rows = await subagents.listDescendants(control.sessionId, AbortSignal.timeout(8000));
      for (const row of rows ?? []) {
        if (row?.kind !== 'child') continue;
        try {
          subagents.interrupt(row.id, { kind: 'ancestor', agent: control.agent });
        } catch {
          /* already gone */
        }
      }
    } catch (error) {
      logger?.warn?.(`code-audit: cannot interrupt descendants: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------------------------------------------------------------------
  // Audit run
  // ---------------------------------------------------------------------

  async function runStage(run, key) {
    const auditStage = AUDIT_STAGES.find((stage) => stage.key === key);
    const label = auditStage?.label ?? key;
    const project = run.project;
    project.stageStatus[key] = 'running';
    project.auditStage = key;
    publish(project);
    events.push(project.id, { kind: 'system', phase: 'audit', text: `▶ ${label}` });
    let result;
    try {
      result = await auditStages[key](run);
    } catch (error) {
      result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
    if (run.paused) {
      project.stageStatus[key] = 'paused';
      publish(project);
      return { status: 'paused' };
    }
    project.stageStatus[key] = result.status;
    if (result.note !== undefined && result.note.length > 0) run.note(`${label}：${result.note}`);
    const marker = result.status === 'done' ? '✓' : result.status === 'skipped' ? '⏭' : '⚠';
    events.push(project.id, {
      kind: result.status === 'failed' ? 'error' : 'result',
      phase: 'audit',
      text: `${marker} ${label}${result.error !== undefined ? `：${truncate(result.error, 300)}` : ''}`,
    });
    publish(project);
    return result;
  }

  async function runAudit(project) {
    if (runs.has(project.id)) return;
    const settings = runtimeSettings();
    const run = makeRun(project, 'audit', null, settings);
    runs.set(project.id, run);
    try {
      if (typeof project.runId !== 'string' || project.runId.length === 0) project.runId = shortId('run');
      run.runId = project.runId;
      project.status = 'running';
      project.startedAt = project.startedAt ?? nowIso();
      project.errorMessage = null;
      publish(project);
      note(project, 'audit', `开始审计：${project.name}`);
      const control = await runner.openControl({ project, cwd: sourceDirOf(paths, project) });
      run.control = control;
      project.controlSessionId = control.sessionId;
      project.permission = control.permission?.level ?? 'unknown';
      project.permissionNotes = control.permission?.notes ?? [];
      if (control.permission?.level === 'degraded' || control.permission?.level === 'unknown') {
        note(project, 'audit', `提示：${(control.permission.notes ?? []).join('；') || '子会话权限可能受限'}`, 'error');
      }
      run.pipeline = await loadPipeline({ runDir: runDirOf(paths, project, run.runId) });
      if (run.pipeline.plan !== null && run.pipeline.plan !== undefined) {
        if (project.stageStatus.dispatch === 'pending') project.stageStatus.dispatch = 'done';
      }
      for (const key of ['dispatch', 'audit', 'dedupe', 'codeverify', 'regrade']) {
        if (run.paused) break;
        if (isSettled(project, key)) continue;
        const result = await runStage(run, key);
        if (result.status === 'failed') {
          project.status = 'failed';
          project.errorMessage = truncate(`[${key}] ${result.error ?? '阶段失败'}`, 1500);
          note(project, 'audit', `阶段失败：${key}：${result.error ?? ''}`, 'error');
          break;
        }
        if (result.status === 'paused') {
          project.status = 'paused';
          break;
        }
        if (key === 'codeverify' && project.options?.runtime === 'full') {
          void startEnvPrewarm(project).catch((error) => logger?.warn?.(`code-audit: env prewarm failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (run.paused) {
        project.status = 'paused';
      } else if (project.status !== 'failed') {
        project.status = 'completed';
        project.finishedAt = nowIso();
        project.stageStatus.done = 'done';
        project.auditStage = 'done';
        project.verifyStatus = project.options?.runtime === 'full' ? 'queued' : 'none';
        await finalizeAudit(project, run);
      }
    } catch (error) {
      project.status = 'failed';
      project.errorMessage = truncate(error instanceof Error ? error.message : String(error), 1500);
      note(project, 'audit', `审计失败：${project.errorMessage}`, 'error');
      logger?.warn?.(`code-audit[${project.id}]: audit failed: ${project.errorMessage}`);
    } finally {
      if (run.control !== undefined) await runner.closeControl(run.control);
      runs.delete(project.id);
      publish(project);
      void tick().catch((error) => logger?.warn?.(`code-audit: tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async function finalizeAudit(project, run) {
    try {
      const findings = deriveFindings(run.pipeline, project);
      const { counts, verifiedCount } = summarizeFindings(findings);
      project.counts = counts;
      project.verifiedCount = verifiedCount;
      store.replaceFindings(project.id, findings);
    } catch (error) {
      logger?.warn?.(`code-audit: cannot finalize findings: ${error instanceof Error ? error.message : String(error)}`);
    }
    note(project, 'audit', '代码审计完成', 'result');
    try {
      await reporter.generate({ project, findings: store.getFindings(project.id), pipeline: run.pipeline });
    } catch (error) {
      logger?.warn?.(`code-audit: report generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function isSettled(project, key) {
    const status = project?.stageStatus?.[key];
    return status === 'done' || status === 'skipped';
  }

  // ---------------------------------------------------------------------
  // Environment pre-warm (does not consume an audit slot)
  // ---------------------------------------------------------------------

  async function startEnvPrewarm(project) {
    const key = `${project.id}:${project.runId}`;
    if (project.options?.runtime !== 'full') return;
    if (prewarmed.has(key) || envRuns.has(project.id)) return;
    if (isSettled(project, 'env') || project.envStatus === 'ready') return;
    if (runs.has(`${project.id}:env`)) return;
    const settings = runtimeSettings();
    const run = makeRun(project, 'env', null, settings);
    envRuns.set(project.id, run);
    try {
      const control = await runner.openControl({ project, cwd: sourceDirOf(paths, project) });
      run.control = control;
      run.pipeline = await loadPipeline({ runDir: runDirOf(paths, project, project.runId) });
      run.pipeline.findings = store.getFindings(project.id);
      project.verifyStage = 'vdispatch';
      const dispatchResult = await verifyStages.vdispatch(run);
      project.stageStatus.vdispatch = dispatchResult.status;
      if (run.paused) return;
      if (dispatchResult.status !== 'done' && dispatchResult.status !== 'skipped') return;
      project.stageStatus.env = 'running';
      project.verifyStage = 'env';
      publish(project);
      events.push(project.id, { kind: 'system', phase: 'verify', text: '▶ 靶机环境搭建（并行预热）' });
      const envResult = await verifyStages.env(run);
      project.stageStatus.env = envResult.status;
      events.push(project.id, {
        kind: envResult.status === 'failed' ? 'error' : 'result',
        phase: 'verify',
        text: `${envResult.status === 'failed' ? '⚠' : '✓'} 靶机环境搭建${envResult.error !== undefined ? `：${truncate(envResult.error, 200)}` : ''}`,
      });
    } catch (error) {
      project.envStatus = 'failed';
      note(project, 'verify', `环境预热失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      prewarmed.add(key);
      envRuns.delete(project.id);
      if (run.control !== undefined) await runner.closeControl(run.control);
      publish(project);
    }
  }

  // ---------------------------------------------------------------------
  // Verification run
  // ---------------------------------------------------------------------

  async function runVerifyStage(run, key) {
    const stage = VERIFY_STAGES.find((entry) => entry.key === key);
    const label = stage?.label ?? (key === 'history' ? '历史版本验证' : key);
    const project = run.project;
    project.stageStatus[key] = 'running';
    project.verifyStage = key;
    publish(project);
    events.push(project.id, { kind: 'system', phase: 'verify', text: `▶ ${label}` });
    let result;
    try {
      result = await verifyStages[key](run);
    } catch (error) {
      result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
    if (run.paused) {
      project.stageStatus[key] = 'paused';
      publish(project);
      return { status: 'paused' };
    }
    project.stageStatus[key] = result.status;
    if (result.note !== undefined && result.note.length > 0) run.note(`${label}：${result.note}`);
    const marker = result.status === 'done' ? '✓' : result.status === 'skipped' ? '⏭' : '⚠';
    events.push(project.id, {
      kind: result.status === 'failed' ? 'error' : 'result',
      phase: 'verify',
      text: `${marker} ${label}${result.error !== undefined ? `：${truncate(result.error, 300)}` : ''}`,
    });
    publish(project);
    return result;
  }

  async function runVerify(project) {
    if (runs.has(project.id)) return;
    if (project.options?.runtime !== 'full') {
      project.verifyStatus = 'none';
      publish(project);
      return;
    }
    const settings = runtimeSettings();
    const run = makeRun(project, 'verify', null, settings);
    runs.set(project.id, run);
    try {
      project.verifyStatus = 'running';
      project.errorMessage = null;
      publish(project);
      note(project, 'verify', '开始靶机验证');
      const control = await runner.openControl({ project, cwd: sourceDirOf(paths, project) });
      run.control = control;
      run.pipeline = await loadPipeline({ runDir: runDirOf(paths, project, project.runId) });
      run.pipeline.findings = store.getFindings(project.id);
      if (run.pipeline.env !== null && run.pipeline.env !== undefined) {
        project.envStatus = project.envStatus === 'failed' ? 'ready' : project.envStatus;
        if (run.pipeline.env.mode === 'compose' && run.pipeline.env.targetUrl) {
          project.envStatus = 'ready';
          project.targetUrl = run.pipeline.env.targetUrl;
          project.composeProject = run.pipeline.env.composeProject || project.composeProject;
        } else {
          project.envStatus = 'ready';
        }
      }
      for (const key of ['vdispatch', 'env', 'remote', 'chain']) {
        if (run.paused) break;
        if (isSettled(project, key)) continue;
        const result = await runVerifyStage(run, key);
        if (result.status === 'failed') {
          project.verifyStatus = 'failed';
          project.errorMessage = truncate(`[${key}] ${result.error ?? '阶段失败'}`, 1500);
          note(project, 'verify', `阶段失败：${key}：${result.error ?? ''}`, 'error');
          break;
        }
        if (result.status === 'paused') {
          project.verifyStatus = 'paused';
          break;
        }
      }
      if (run.paused) {
        project.verifyStatus = 'paused';
      } else if (project.verifyStatus !== 'failed') {
        await runVerifyStage(run, 'history').catch(() => undefined);
        project.verifyStatus = 'completed';
        project.status = 'completed';
        project.stageStatus.vdone = 'done';
        project.verifyStage = 'vdone';
        project.finishedAt = nowIso();
        await finalizeVerify(project, run);
      }
    } catch (error) {
      project.verifyStatus = 'failed';
      project.errorMessage = truncate(error instanceof Error ? error.message : String(error), 1500);
      note(project, 'verify', `验证失败：${project.errorMessage}`, 'error');
    } finally {
      if (run.control !== undefined) await runner.closeControl(run.control);
      runs.delete(project.id);
      publish(project);
      void tick().catch((error) => logger?.warn?.(`code-audit: tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async function finalizeVerify(project, run) {
    try {
      const findings = deriveFindings(run.pipeline, project);
      const { counts, verifiedCount } = summarizeFindings(findings);
      project.counts = counts;
      project.verifiedCount = verifiedCount;
      project.frontendRce = computeFrontendRce(findings, project);
      store.replaceFindings(project.id, findings);
    } catch (error) {
      logger?.warn?.(`code-audit: cannot finalize verification findings: ${error instanceof Error ? error.message : String(error)}`);
    }
    note(project, 'verify', '靶机验证完成', 'result');
    try {
      await reporter.generate({ project, findings: store.getFindings(project.id), pipeline: run.pipeline });
    } catch (error) {
      logger?.warn?.(`code-audit: report generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------------------------------------------------------------------
  // Public control surface
  // ---------------------------------------------------------------------

  function activeCounts() {
    let audit = 0;
    let verify = 0;
    for (const run of runs.values()) {
      if (run.kind === 'audit') audit += 1;
      else verify += 1;
    }
    return { audit, verify, env: envRuns.size, children: childSlots.active };
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const settings = runtimeSettings();
      syncChildSlots(settings);
      if (settings.globalEnabled !== true) return;
      const counts = activeCounts();
      let auditSlots = counts.audit;
      let verifySlots = counts.verify;
      const auditLimit = settings.maxConcurrentAudit;
      const verifyLimit = settings.maxConcurrentVerify;
      const projects = store.listProjects();
      for (const project of projects) {
        if (runs.has(project.id)) continue;
        if (project.prepareState !== 'ready') continue;
        if (project.status === 'queued' && auditSlots < auditLimit) {
          auditSlots += 1;
          void runAudit(project).catch((error) => logger?.warn?.(`code-audit: audit run failed: ${error instanceof Error ? error.message : String(error)}`));
          continue;
        }
        if (
          project.status === 'completed'
          && project.options?.runtime === 'full'
          && project.verifyStatus === 'queued'
          && verifySlots < verifyLimit
          && !envRuns.has(project.id)
        ) {
          verifySlots += 1;
          void runVerify(project).catch((error) => logger?.warn?.(`code-audit: verify run failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    } catch (error) {
      logger?.warn?.(`code-audit: scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
    }
  }

  async function pause(projectId) {
    const project = store.getProject(projectId);
    if (project === undefined) return { ok: false, error: '项目不存在' };
    const run = runs.get(projectId);
    const envRun = envRuns.get(projectId);
    if (project.status === 'running' || project.verifyStatus === 'running' || envRun !== undefined) {
      if (run !== undefined) {
        run.paused = true;
        run.controller.abort();
        await interruptAll(run.control);
      }
      if (envRun !== undefined) {
        envRun.paused = true;
        envRun.controller.abort();
        await interruptAll(envRun.control);
      }
      if (project.status === 'running') project.status = 'paused';
      if (project.verifyStatus === 'running') project.verifyStatus = 'paused';
      if (envRun !== undefined && project.verifyStatus === 'queued') project.verifyStatus = 'paused';
      for (const [key, status] of Object.entries(project.stageStatus ?? {})) {
        if (status === 'running') project.stageStatus[key] = 'paused';
      }
      project.errorMessage = '已暂停';
      publish(project);
      return { ok: true };
    }
    if (project.status === 'queued' || project.verifyStatus === 'queued') {
      project.status = project.status === 'queued' ? 'paused' : project.status;
      project.verifyStatus = project.verifyStatus === 'queued' ? 'paused' : project.verifyStatus;
      project.errorMessage = '已暂停';
      publish(project);
      return { ok: true };
    }
    return { ok: false, error: '项目当前没有在运行或排队' };
  }

  function resume(projectId) {
    const project = store.getProject(projectId);
    if (project === undefined) return { ok: false, error: '项目不存在' };
    let changed = false;
    if (project.status === 'paused') {
      project.status = 'queued';
      project.errorMessage = null;
      changed = true;
    }
    if (project.verifyStatus === 'paused') {
      project.verifyStatus = 'queued';
      if (project.status !== 'paused') project.errorMessage = null;
      changed = true;
    }
    for (const [key, status] of Object.entries(project.stageStatus ?? {})) {
      if (status === 'paused') project.stageStatus[key] = 'pending';
    }
    if (!changed) return { ok: false, error: '项目不在暂停状态' };
    publish(project);
    void tick().catch((error) => logger?.warn?.(`code-audit: tick failed: ${error instanceof Error ? error.message : String(error)}`));
    return { ok: true };
  }

  async function rerun(projectId) {
    const project = store.getProject(projectId);
    if (project === undefined) return { ok: false, error: '项目不存在' };
    if (runs.has(projectId) || envRuns.has(projectId)) return { ok: false, error: '项目正在运行，请先暂停或等待结束' };
    project.runId = shortId('run');
    project.status = 'queued';
    project.verifyStatus = 'none';
    project.envStatus = 'none';
    project.stageStatus = freshStageStatus();
    project.auditStage = null;
    project.verifyStage = null;
    project.counts = { ...ZERO_COUNTS };
    project.verifiedCount = 0;
    project.frontendRce = false;
    project.targetUrl = null;
    project.composeProject = null;
    project.report = null;
    project.errorMessage = null;
    project.finishedAt = null;
    project.startedAt = null;
    project.activity = null;
    store.replaceFindings(projectId, []);
    await pruneRuns(project);
    publish(project);
    void tick().catch((error) => logger?.warn?.(`code-audit: tick failed: ${error instanceof Error ? error.message : String(error)}`));
    return { ok: true };
  }

  async function rerunStage(projectId, stage, mode = 'from') {
    const project = store.getProject(projectId);
    if (project === undefined) return { ok: false, error: '项目不存在' };
    if (runs.has(projectId) || envRuns.has(projectId)) return { ok: false, error: '项目正在运行，请先暂停或等待结束' };
    const auditIndex = AUDIT_STAGES.findIndex((entry) => entry.key === stage);
    const verifyIndex = VERIFY_STAGES.findIndex((entry) => entry.key === stage);
    if (auditIndex === -1 && verifyIndex === -1 && stage !== 'history') {
      return { ok: false, error: `未知阶段：${stage}` };
    }
    const runDir = runDirOf(paths, project, project.runId);
    if (auditIndex >= 0) {
      const keys = mode === 'only'
        ? [stage]
        : [...AUDIT_STAGES.slice(auditIndex).map((entry) => entry.key), 'history'];
      for (const key of keys) {
        project.stageStatus[key] = 'pending';
        await clearStage(runDir, key);
      }
      if (mode !== 'only') {
        for (const entry of VERIFY_STAGES) project.stageStatus[entry.key] = 'pending';
        project.stageStatus.history = 'pending';
        project.verifyStatus = 'none';
        project.envStatus = 'none';
        project.targetUrl = null;
        project.composeProject = null;
        for (const entry of [...VERIFY_STAGES.map((row) => row.key), 'history']) await clearStage(runDir, entry.key);
      }
      project.stageStatus.done = 'pending';
      project.auditStage = null;
      project.status = 'queued';
      project.errorMessage = null;
    } else {
      const keys = mode === 'only'
        ? [stage]
        : [...VERIFY_STAGES.slice(verifyIndex).map((entry) => entry.key), 'history'];
      for (const key of keys) {
        project.stageStatus[key] = 'pending';
        await clearStage(runDir, key);
      }
      project.verifyStatus = 'queued';
      project.stageStatus.vdone = 'pending';
      project.verifyStage = null;
      project.errorMessage = null;
    }
    publish(project);
    void tick().catch((error) => logger?.warn?.(`code-audit: tick failed: ${error instanceof Error ? error.message : String(error)}`));
    return { ok: true };
  }

  async function clearStage(runDir, key) {
    const dirMap = {
      dispatch: ['dispatch', 'audit', 'dedupe', 'codeverify', 'regrade'],
      audit: ['audit', 'dedupe', 'codeverify', 'regrade'],
      dedupe: ['dedupe', 'codeverify', 'regrade'],
      codeverify: ['codeverify', 'regrade'],
      regrade: ['regrade'],
      vdispatch: ['vdispatch', 'env', 'remote', 'chain', 'history'],
      env: ['env', 'remote', 'chain', 'history'],
      remote: ['remote', 'chain', 'history'],
      chain: ['chain', 'history'],
      history: ['history'],
    };
    const dirs = dirMap[key] ?? [];
    for (const dir of dirs) {
      await rm(path.join(runDir, dir), { recursive: true, force: true }).catch(() => undefined);
    }
    if (key === 'dispatch' || key === 'audit' || key === 'dedupe' || key === 'codeverify' || key === 'regrade') {
      await rm(path.join(runDir, 'findings-snapshot.json'), { force: true }).catch(() => undefined);
    }
  }

  async function pruneRuns(project) {
    const runsDir = path.join(sourceDirOf(paths, project), '.codeaudit', 'runs');
    try {
      const entries = (await readdir(runsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const name of entries.slice(RUN_KEEP)) {
        await rm(path.join(runsDir, name), { recursive: true, force: true }).catch(() => undefined);
      }
    } catch {
      /* no run directory yet */
    }
  }

  async function cleanupEnvironment(project) {
    const composeProject = project.composeProject;
    if (typeof composeProject !== 'string' || composeProject.length === 0) {
      project.envStatus = 'none';
      publish(project);
      return { ok: true };
    }
    try {
      await runCommand('docker', ['compose', '-p', composeProject, 'down'], {
        cwd: sourceDirOf(paths, project),
        timeoutMs: 120000,
      });
      project.envStatus = 'none';
      project.targetUrl = null;
      project.composeProject = null;
      note(project, 'verify', `已清理靶机容器 ${composeProject}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `清理失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  function activeProjectIds() {
    return new Set([...runs.keys(), ...envRuns.keys()]);
  }

  function start() {
    if (tickTimer !== null) return;
    tickTimer = setInterval(() => { void tick().catch((error) => logger?.warn?.(`code-audit: tick failed: ${error instanceof Error ? error.message : String(error)}`)); }, TICK_MS);
    if (typeof tickTimer.unref === 'function') tickTimer.unref();
    void tick().catch((error) => logger?.warn?.(`code-audit: tick failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  async function stop() {
    try {
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      for (const run of runs.values()) {
        run.paused = true;
        run.controller.abort();
        await interruptAll(run.control);
      }
      for (const run of envRuns.values()) {
        run.paused = true;
        run.controller.abort();
        await interruptAll(run.control);
      }
    } catch (error) {
      logger?.warn?.(`code-audit: stop() could not interrupt runs: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      for (const project of store.listProjects()) {
        if (project.status === 'running') project.status = 'paused';
        if (project.verifyStatus === 'running') project.verifyStatus = 'paused';
        for (const [key, status] of Object.entries(project.stageStatus ?? {})) {
          if (status === 'running') project.stageStatus[key] = 'paused';
        }
        // Mark the record dirty so flush() persists the pause.
        try {
          store.updateProject(project.id, {});
        } catch {
          /* store already gone */
        }
      }
    } catch (error) {
      logger?.warn?.(`code-audit: stop() could not pause projects: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await store.flush();
    } catch (error) {
      logger?.warn?.(`code-audit: stop() could not flush the store: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(50);
  }

  return {
    start,
    stop,
    tick,
    pause,
    resume,
    rerun,
    rerunStage,
    cleanupEnvironment,
    activeProjectIds,
    runtimeSettings,
    activeCounts,
    isActive(projectId) {
      return runs.has(projectId) || envRuns.has(projectId);
    },
    async runNow(projectId) {
      const project = store.getProject(projectId);
      if (project === undefined) return { ok: false, error: '项目不存在' };
      void tick().catch((error) => logger?.warn?.(`code-audit: tick failed: ${error instanceof Error ? error.message : String(error)}`));
      return { ok: true };
    },
  };
}
