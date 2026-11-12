/**
 * Business operations shared by the console API and the `code_audit` tool.
 *
 * One implementation, two callers: the UI never has its own copy of a rule and
 * the agent never bypasses the same checks.
 */
import { copyFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  AUDIT_STAGES,
  DEFAULT_SETTINGS,
  LANGUAGE_VALUES,
  MAX_LANES,
  RUNTIME_VALUES,
  SEVERITY_LABEL,
  VERIFY_STAGES,
} from './constants.js';
import { detectLanguage, detectionSummary } from './detect.js';
import { extractArchive } from './ingest/zip.js';
import {
  cloneRepo,
  currentCommit,
  listTags,
  normalizeRepoUrl,
  previewRepo,
  repoName,
} from './ingest/github.js';
import { computeFrontendRce, loadPipeline } from './pipeline.js';
import { projectSummary, statusText } from './flow.js';
import { runCommand } from './process.js';
import { runDirOf } from './project-paths.js';
import { lanesForLanguage } from './prompts/languages.js';
import {
  atomicWriteJson,
  clamp,
  ensureDir,
  isObject,
  nowIso,
  parseModelOverride,
  shortId,
  truncate,
} from './util.js';

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

function freshStageStatus() {
  const status = {};
  for (const stage of AUDIT_STAGES) status[stage.key] = 'pending';
  for (const stage of VERIFY_STAGES) status[stage.key] = 'pending';
  status.history = 'pending';
  return status;
}

function zeroCounts() {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function normalizeOptions(raw) {
  const input = isObject(raw) ? raw : {};
  const runtime = RUNTIME_VALUES.includes(input.runtime) ? input.runtime : 'full';
  return {
    runtime,
    aiDedup: input.aiDedup === undefined ? true : input.aiDedup === true,
    aiRegrade: input.aiRegrade === undefined ? true : input.aiRegrade === true,
    verifyHistory: runtime === 'full' && input.verifyHistory === true,
  };
}

/**
 * @param {object} options
 */
export function createAuditService({
  ctx,
  config,
  store,
  events,
  orchestrator,
  runner,
  reporter,
  paths,
  policyStats,
  logger,
}) {
  /** @type {Map<string, object>} */
  const previews = new Map();
  let dockerCache = { at: 0, available: null };
  let modelCache = { at: 0, value: null };

  function effectiveSettings() {
    return orchestrator.runtimeSettings();
  }

  function publicSettings() {
    const effective = effectiveSettings();
    return {
      auditPromptExtra: String(effective.auditPromptExtra ?? ''),
      verifyPromptExtra: String(effective.verifyPromptExtra ?? ''),
      globalEnabled: effective.globalEnabled === true,
      protectPages: effective.protectPages === true,
      maxConcurrentAudit: effective.maxConcurrentAudit,
      maxConcurrentVerify: effective.maxConcurrentVerify,
      maxConcurrentEnv: effective.maxConcurrentEnv,
      maxConcurrentChildren: effective.maxConcurrentChildren,
      laneConcurrency: effective.laneConcurrency,
      laneBatchSize: effective.laneBatchSize,
      dedupeThreshold: effective.dedupeThreshold,
      stageTimeoutMs: effective.stageTimeoutMs,
      idleTimeoutMs: effective.idleTimeoutMs,
      verifyTimeoutMs: effective.verifyTimeoutMs,
      verifyIdleTimeoutMs: effective.verifyIdleTimeoutMs,
      finishGraceMs: effective.finishGraceMs,
      stageRetries: effective.stageRetries,
      historyMaxVersions: effective.historyMaxVersions,
      monitorIntervalMin: effective.monitorIntervalMin,
      modelOverride: String(effective.modelOverride ?? ''),
    };
  }

  function validateSettingsPatch(raw) {
    if (!isObject(raw)) return { ok: false, error: '设置必须是对象' };
    const patch = {};
    const numbers = {
      maxConcurrentAudit: [1, 10],
      maxConcurrentVerify: [1, 10],
      maxConcurrentEnv: [1, 10],
      maxConcurrentChildren: [1, 64],
      laneConcurrency: [1, 8],
      laneBatchSize: [1, 50],
      dedupeThreshold: [0, 10000],
      stageTimeoutMs: [60000, 86400000],
      idleTimeoutMs: [60000, 86400000],
      verifyTimeoutMs: [60000, 86400000],
      verifyIdleTimeoutMs: [30000, 86400000],
      finishGraceMs: [10000, 3600000],
      stageRetries: [0, 3],
      historyMaxVersions: [1, 10],
      monitorIntervalMin: [5, 1440],
    };
    for (const [key, [min, max]] of Object.entries(numbers)) {
      if (raw[key] === undefined) continue;
      const value = Number(raw[key]);
      if (!Number.isFinite(value)) return { ok: false, error: `${key} 必须是数字` };
      patch[key] = clamp(value, min, max);
    }
    for (const key of ['globalEnabled', 'protectPages']) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== 'boolean') return { ok: false, error: `${key} 必须是布尔值` };
      patch[key] = raw[key];
    }
    for (const key of ['auditPromptExtra', 'verifyPromptExtra']) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== 'string') return { ok: false, error: `${key} 必须是文本` };
      patch[key] = raw[key].slice(0, 20000);
    }
    if (raw.modelOverride !== undefined) {
      const text = String(raw.modelOverride ?? '').trim();
      if (text.length > 0 && parseModelOverride(text) === undefined) {
        return { ok: false, error: '模型标识格式应为 provider:model' };
      }
      patch.modelOverride = text;
    }
    return { ok: true, value: patch };
  }

  function updateSettings(raw) {
    const validated = validateSettingsPatch(raw);
    if (validated.ok !== true) return validated;
    const current = store.getSettings();
    // Seed a first save with the effective (config-aware) values so plugin
    // config is not silently replaced by built-in defaults.
    const effective = publicSettings();
    const next = { ...DEFAULT_SETTINGS, ...current, ...effective, ...validated.value };
    const saved = store.updateSettings(next);
    events.settingsChanged(publicSettings());
    if (saved.globalEnabled !== true) void pauseAllRunning().catch((error) => logger?.warn?.(`code-audit: pause-all failed: ${error instanceof Error ? error.message : String(error)}`));
    void orchestrator.tick().catch(() => undefined);
    return { ok: true, settings: publicSettings() };
  }

  async function pauseAllRunning() {
    for (const project of store.listProjects()) {
      if (project.status === 'running' || project.verifyStatus === 'running') {
        await orchestrator.pause(project.id).catch(() => undefined);
      }
    }
  }

  async function capabilities() {
    const now = Date.now();
    if (now - dockerCache.at > 60000) {
      dockerCache = { at: now, available: null };
      try {
        await runCommand('docker', ['--version'], { timeoutMs: 5000 });
        dockerCache = { at: now, available: true };
      } catch {
        dockerCache = { at: now, available: false };
      }
    }
    if (now - modelCache.at > 60000 || modelCache.value === null) {
      try {
        modelCache = { at: now, value: await runner.resolveSelection() };
      } catch {
        modelCache = { at: now, value: { label: '不可用', source: 'error' } };
      }
    }
    const subagents = getService('subagents');
    const agents = getService('agents');
    const loop = getService('agentLoop');
    const canRun = typeof subagents?.startActivation === 'function'
      && (typeof agents?.create === 'function' || typeof loop?.createAgent === 'function');
    let preset;
    try {
      preset = await runner.resolvePreset();
    } catch {
      preset = undefined;
    }
    return {
      canRun,
      provider: config.subagentProvider,
      preset: preset ?? null,
      model: modelCache.value?.label ?? '未知',
      modelSource: modelCache.value?.source ?? 'unknown',
      docker: dockerCache.available,
      dataDir: paths.root,
      serverOrigin: getService('webServer')?.getOrigin?.() ?? null,
      laneCap: 8,
      globalEnabled: effectiveSettings().globalEnabled === true,
      policy: policyStats ?? null,
    };
  }

  function getService(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------

  function mintProject({ name, language, options, sourceType, sourceRef, sourceVersion, archiveName, remoteTags }) {
    const project = {
      id: shortId('p'),
      name,
      sourceType,
      sourceRef,
      sourceVersion: sourceVersion ?? null,
      archiveName: archiveName ?? null,
      sourcePath: null,
      sessionId: null,
      language: LANGUAGE_VALUES.includes(language) ? language : null,
      options: normalizeOptions(options),
      prepareState: 'pending',
      status: 'pending',
      verifyStatus: 'none',
      envStatus: 'none',
      stageStatus: freshStageStatus(),
      auditStage: null,
      verifyStage: null,
      counts: zeroCounts(),
      verifiedCount: 0,
      frontendRce: false,
      hasWeb: null,
      hasRegistration: null,
      regDefaultOpen: null,
      targetUrl: null,
      composeProject: null,
      report: null,
      activity: null,
      errorMessage: null,
      runId: shortId('run'),
      controlSessionId: null,
      remoteTags: Array.isArray(remoteTags) ? remoteTags.slice(0, 200) : [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
    };
    return project;
  }

  async function projectNameFromArchive(fileName) {
    const base = path.basename(String(fileName ?? '')).replace(/\.zip$/iu, '').trim();
    return base.length > 0 ? base.slice(0, 160) : '未命名项目';
  }

  /**
   * Audit a workspace already opened in DSH: no copy, no language picker.
   * The source tree is used in place and the language is detected host-side.
   */
  async function createWorkspaceProject(input) {
    const settings = effectiveSettings();
    if (settings.globalEnabled !== true) return { ok: false, error: '运行总闸已关闭，无法新建审计' };
    if (typeof input?.sourcePath !== 'string' || input.sourcePath.trim().length === 0) {
      return { ok: false, error: '工作区路径为空' };
    }
    const sourcePath = path.resolve(input.sourcePath);
    let info;
    try {
      info = await stat(sourcePath);
    } catch {
      return { ok: false, error: `工作区不存在：${sourcePath}` };
    }
    if (!info.isDirectory()) return { ok: false, error: `工作区不是目录：${sourcePath}` };
    const active = store.listProjects().find((project) => (
      project.sourceType === 'workspace'
      && project.sourcePath === sourcePath
      && (project.status === 'queued' || project.status === 'running'
        || project.verifyStatus === 'running' || project.verifyStatus === 'queued')
    ));
    if (active !== undefined && input.force !== true) {
      if (typeof input.sessionId === 'string' && input.sessionId.length > 0 && active.sessionId !== input.sessionId) {
        active.sessionId = input.sessionId;
        store.updateProject(active.id, { sessionId: active.sessionId });
      }
      return { ok: true, project: projectSummary(active), existing: true };
    }
    const detection = await detectLanguage(sourcePath);
    if (detection.sampled === 0 && !LANGUAGE_VALUES.includes(input.language)) {
      return { ok: false, error: `目录中没有找到受支持的源码文件：${sourcePath}` };
    }
    const language = LANGUAGE_VALUES.includes(input.language) ? input.language : detection.language;
    const name = (typeof input.name === 'string' && input.name.trim().length > 0
      ? input.name.trim()
      : path.basename(sourcePath) || 'workspace').slice(0, 160);
    const project = mintProject({
      name,
      language,
      options: input.options,
      sourceType: 'workspace',
      sourceRef: sourcePath,
      sourceVersion: null,
      remoteTags: [],
    });
    project.sourcePath = sourcePath;
    project.sessionId = typeof input.sessionId === 'string' && input.sessionId.length > 0 ? input.sessionId : null;
    project.gitRef = null;
    project.prepareState = 'ready';
    project.status = 'queued';
    try {
      const commit = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd: sourcePath, timeoutMs: 8000 });
      project.sourceVersion = String(commit.stdout ?? '').trim() || null;
    } catch {
      project.sourceVersion = null;
    }
    await store.createProject(project);
    events.push(project.id, {
      kind: 'system',
      phase: 'audit',
      text: `▶ 工作区审计：${sourcePath}；语言自动识别为 ${detectionSummary(detection)}`,
    });
    events.projectChanged(project);
    void orchestrator.tick().catch(() => undefined);
    return { ok: true, project: projectSummary(project) };
  }

  /** Preview a repository and mint a short-lived preview id. */
  async function previewGithub({ url }) {
    const repoUrl = normalizeRepoUrl(url);
    const preview = await previewRepo({ url: repoUrl });
    const previewId = shortId('preview');
    previews.set(previewId, { ...preview, repoUrl, createdAt: Date.now() });
    for (const [key, value] of previews) {
      if (Date.now() - value.createdAt > PREVIEW_TTL_MS) previews.delete(key);
    }
    const duplicate = store.listProjects().find((project) => (
      project.sourceType === 'github'
      && normalizeRepoUrl(project.sourceRef) === repoUrl
      && (project.sourceVersion === preview.latestTag || project.sourceVersion === preview.commit)
    ));
    return {
      previewId,
      repo: preview.repo,
      url: repoUrl,
      tags: preview.tags.slice(0, 50),
      latestTag: preview.latestTag,
      commit: preview.commit,
      defaultRef: preview.defaultRef,
      duplicate: duplicate === undefined ? null : {
        id: duplicate.id,
        name: duplicate.name,
        version: duplicate.sourceVersion,
        status: statusText(duplicate),
      },
    };
  }

  async function createProject(input) {
    const settings = effectiveSettings();
    if (settings.globalEnabled !== true) return { ok: false, error: '运行总闸已关闭，无法新建审计' };
    const requestedLanguage = typeof input?.language === 'string' && LANGUAGE_VALUES.includes(input.language)
      ? input.language
      : null;
    const sourceType = input.sourceType === 'github'
      ? 'github'
      : input.sourceType === 'zip'
        ? 'zip'
        : input.sourceType === 'workspace'
          ? 'workspace'
          : null;
    if (sourceType === null) return { ok: false, error: '来源类型必须是 workspace、zip 或 github' };
    if (sourceType === 'workspace') {
      return createWorkspaceProject({ ...input, language: requestedLanguage });
    }

    if (sourceType === 'zip') {
      const uploadId = typeof input.uploadId === 'string' ? input.uploadId : '';
      const uploaded = await resolveUpload(uploadId);
      if (uploaded === null) return { ok: false, error: '上传文件不存在或已过期，请重新上传' };
      const name = typeof input.name === 'string' && input.name.trim().length > 0
        ? input.name.trim().slice(0, 160)
        : await projectNameFromArchive(uploaded.name);
      const project = mintProject({
        name,
        language: requestedLanguage,
        options: input.options,
        sourceType: 'zip',
        sourceRef: '', // filled with the persistent archive path after creation
        sourceVersion: parseArchiveVersion(uploaded.name),
        archiveName: uploaded.name,
      });
      project.sourceRef = paths.archiveFile(project.id);
      await store.createProject(project);
      try {
        await ensureDir(paths.projectDir(project.id));
        await rename(uploaded.path, paths.archiveFile(project.id)).catch(async () => {
          await copyFile(uploaded.path, paths.archiveFile(project.id));
          await unlink(uploaded.path).catch(() => undefined);
        });
      } catch (error) {
        project.prepareState = 'failed';
        project.status = 'failed';
        project.errorMessage = `保存压缩包失败：${error instanceof Error ? error.message : String(error)}`;
        store.updateProject(project.id, project);
        events.projectChanged(project);
        return { ok: false, error: project.errorMessage };
      }
      void prepareZip(project).catch((error) => logger?.warn?.(`code-audit: zip preparation failed: ${error instanceof Error ? error.message : String(error)}`));
      events.projectChanged(project);
      return { ok: true, project: projectSummary(project) };
    }

    const previewId = typeof input.previewId === 'string' ? input.previewId : '';
    const preview = previews.get(previewId);
    if (preview === undefined) {
      return { ok: false, error: '请先预览仓库，再创建审计' };
    }
    const repoUrl = preview.repoUrl;
    const requestedRef = typeof input.ref === 'string' && input.ref.trim().length > 0
      ? input.ref.trim()
      : preview.latestTag ?? preview.defaultRef;
    const duplicate = store.listProjects().find((project) => (
      project.sourceType === 'github'
      && normalizeRepoUrl(project.sourceRef) === repoUrl
      && project.sourceVersion === requestedRef
    ));
    if (duplicate !== undefined && input.force !== true) {
      return {
        ok: false,
        error: `同一仓库同一版本已存在审计：${duplicate.name}（${duplicate.sourceVersion}）`,
        project: projectSummary(duplicate),
      };
    }
    const name = typeof input.name === 'string' && input.name.trim().length > 0
      ? input.name.trim().slice(0, 160)
      : preview.repo;
    const project = mintProject({
      name,
      language: requestedLanguage,
      options: input.options,
      sourceType: 'github',
      sourceRef: repoUrl,
      sourceVersion: requestedRef,
      remoteTags: preview.tags.map((tag) => tag.name),
    });
    project.gitRef = requestedRef;
    await store.createProject(project);
    void prepareGithub(project, repoUrl, requestedRef).catch((error) => logger?.warn?.(`code-audit: github preparation failed: ${error instanceof Error ? error.message : String(error)}`));
    events.projectChanged(project);
    return { ok: true, project: projectSummary(project) };
  }

  async function resolveUpload(uploadId) {
    if (typeof uploadId !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(uploadId)) return null;
    const file = path.join(paths.uploadsDir, uploadId);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size === 0) return null;
    } catch {
      return null;
    }
    let name = uploadId;
    try {
      const meta = JSON.parse(await (await import('node:fs/promises')).readFile(`${file}.meta.json`, 'utf8'));
      if (isObject(meta) && typeof meta.name === 'string' && meta.name.length > 0) name = meta.name;
    } catch {
      /* fall back to the generated upload id */
    }
    return { path: file, name };
  }

  function parseArchiveVersion(fileName) {
    const match = String(fileName).match(/(?:^|[-_])v?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)(?:\.zip)?$/iu);
    return match === null ? null : match[1];
  }

  async function prepareZip(project) {
    project.prepareState = 'extracting';
    project.status = 'pending';
    store.updateProject(project.id, project);
    events.projectChanged(project);
    events.push(project.id, { kind: 'system', phase: 'audit', text: `▶ 解压源码：${project.archiveName}` });
    try {
      const limits = {
        maxFiles: Number(effectiveSettings().maxExtractFiles) || 200000,
        maxBytes: Number(effectiveSettings().maxExtractBytes) || 21474836480,
      };
      const result = await extractArchive({
        archivePath: paths.archiveFile(project.id),
        destination: paths.srcDir(project.id),
        limits,
        logger,
      });
      if (!LANGUAGE_VALUES.includes(project.language)) {
        const detection = await detectLanguage(paths.srcDir(project.id));
        project.language = detection.language;
        events.push(project.id, { kind: 'system', phase: 'audit', text: `语言自动识别：${detectionSummary(detection)}` });
      }
      project.prepareState = 'ready';
      project.status = 'queued';
      project.errorMessage = null;
      events.push(project.id, {
        kind: 'result',
        phase: 'audit',
        text: `✓ 源码就绪：${result.files} 个文件，${(result.bytes / 1024 / 1024).toFixed(1)} MiB`,
      });
      store.updateProject(project.id, project);
      events.projectChanged(project);
      void orchestrator.tick().catch(() => undefined);
    } catch (error) {
      project.prepareState = 'failed';
      project.status = 'failed';
      project.errorMessage = truncate(error instanceof Error ? error.message : String(error), 1500);
      events.push(project.id, { kind: 'error', phase: 'audit', text: `解压失败：${project.errorMessage}` });
      store.updateProject(project.id, project);
      events.projectChanged(project);
    }
  }

  async function prepareGithub(project, repoUrl, ref) {
    project.prepareState = 'cloning';
    project.status = 'pending';
    store.updateProject(project.id, project);
    events.projectChanged(project);
    events.push(project.id, { kind: 'system', phase: 'audit', text: `▶ 克隆仓库：${repoUrl}（${ref}）` });
    try {
      await cloneRepo({
        url: repoUrl,
        ref,
        destination: paths.srcDir(project.id),
        logger,
      });
      const commit = await currentCommit(paths.srcDir(project.id));
      if (commit !== null && (project.sourceVersion === null || project.sourceVersion === 'HEAD')) {
        project.sourceVersion = commit;
      }
      if (!LANGUAGE_VALUES.includes(project.language)) {
        const detection = await detectLanguage(paths.srcDir(project.id));
        project.language = detection.language;
        events.push(project.id, { kind: 'system', phase: 'audit', text: `语言自动识别：${detectionSummary(detection)}` });
      }
      project.prepareState = 'ready';
      project.status = 'queued';
      project.errorMessage = null;
      events.push(project.id, { kind: 'result', phase: 'audit', text: `✓ 仓库就绪：${project.sourceVersion ?? commit ?? ref}` });
      store.updateProject(project.id, project);
      events.projectChanged(project);
      void orchestrator.tick().catch(() => undefined);
    } catch (error) {
      project.prepareState = 'failed';
      project.status = 'failed';
      project.errorMessage = truncate(error instanceof Error ? error.message : String(error), 1500);
      events.push(project.id, { kind: 'error', phase: 'audit', text: `克隆失败：${project.errorMessage}` });
      store.updateProject(project.id, project);
      events.projectChanged(project);
    }
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  function listProjects() {
    return store.listProjects().map(projectSummary);
  }

  function getProject(id) {
    const project = store.getProject(id);
    if (project === undefined) return null;
    return {
      ...projectSummary(project),
      sourceRef: project.sourceRef,
      sourcePath: project.sourcePath ?? null,
      sessionId: project.sessionId ?? null,
      options: project.options,
      stageStatus: project.stageStatus,
      targetUrl: project.targetUrl ?? null,
      composeProject: project.composeProject ?? null,
      report: project.report ?? null,
      controlSessionId: project.controlSessionId ?? null,
      permission: project.permission ?? null,
      permissionNotes: project.permissionNotes ?? [],
      activity: project.activity ?? null,
      startedAt: project.startedAt ?? null,
      finishedAt: project.finishedAt ?? null,
      findings: store.getFindings(id),
      stages: project.stageStatus,
      isActive: orchestrator.isActive(id),
    };
  }

  function getState() {
    const projects = store.listProjects();
    const distribution = zeroCounts();
    let findings = 0;
    let verified = 0;
    let frontendRce = 0;
    for (const project of projects) {
      const list = store.getFindings(project.id);
      findings += list.length;
      verified += list.filter((finding) => finding.verified === true).length;
      if (project.frontendRce === true) frontendRce += 1;
      for (const finding of list) {
        if (Object.hasOwn(distribution, finding.severity)) distribution[finding.severity] += 1;
      }
    }
    return {
      version: 1,
      projects: projects.map(projectSummary),
      monitors: store.getMonitors(),
      recycle: store.getRecycle(),
      settings: publicSettings(),
      counts: {
        projects: projects.length,
        running: projects.filter((project) => project.status === 'running' || project.verifyStatus === 'running').length,
        completed: projects.filter((project) => project.status === 'completed').length,
        findings,
        verified,
        frontendRce,
        distribution,
      },
      generatedAt: nowIso(),
    };
  }

  async function getSnapshot() {
    const state = getState();
    const caps = await capabilities();
    return { ...state, capabilities: caps };
  }

  // ---------------------------------------------------------------------
  // Control
  // ---------------------------------------------------------------------

  async function controlProject(id, action) {
    const project = store.getProject(id);
    if (project === undefined) return { ok: false, error: '项目不存在' };
    if (action === 'pause') return orchestrator.pause(id);
    if (action === 'resume') return orchestrator.resume(id);
    if (action === 'rerun') return orchestrator.rerun(id);
    if (action === 'cleanup-env') return orchestrator.cleanupEnvironment(project);
    if (action === 'generate-report') {
      const pipeline = await loadPipeline({ runDir: runDirOf(paths, project, project.runId) });
      const findings = store.getFindings(id);
      const meta = await reporter.generate({ project, findings, pipeline });
      if (meta === null) return { ok: false, error: '报告生成失败' };
      store.updateProject(id, project);
      events.projectChanged(project);
      return { ok: true, report: meta };
    }
    if (action === 'delete') return deleteProject(id, 'manual', '');
    return { ok: false, error: `未知操作：${action}` };
  }

  async function deleteProject(id, reason, detail) {
    const project = store.getProject(id);
    if (project === undefined) return { ok: false, error: '项目不存在' };
    if (orchestrator.isActive(id)) return { ok: false, error: '项目正在运行，请先暂停或等待结束' };
    const findings = store.getFindings(id);
    store.addRecycle({
      id: project.id,
      name: project.name,
      sourceType: project.sourceType,
      sourceRef: project.sourceRef,
      archiveName: project.archiveName ?? null,
      sourceLink: project.sourceType === 'github' ? project.sourceRef : project.archiveName ?? project.sourceRef,
      vulnCount: findings.length,
      reason,
      detail: truncate(detail, 500),
      deletedAt: Date.now(),
    });
    events.forget(id);
    await store.removeProject(id);
    events.metaChanged({ recycle: store.getRecycle(), monitors: store.getMonitors() });
    return { ok: true };
  }

  async function rerunStage(id, stage, mode) {
    const auditKeys = AUDIT_STAGES.map((entry) => entry.key);
    const verifyKeys = VERIFY_STAGES.map((entry) => entry.key);
    if (!auditKeys.includes(stage) && !verifyKeys.includes(stage)) {
      return { ok: false, error: `未知阶段：${stage}` };
    }
    return orchestrator.rerunStage(id, stage, mode === 'only' ? 'only' : 'from');
  }

  // ---------------------------------------------------------------------
  // Bulk
  // ---------------------------------------------------------------------

  async function bulk(kind) {
    if (kind === 'non-web') {
      const targets = store.listProjects().filter((project) => (
        project.hasWeb === false
        && (project.status === 'completed' || project.status === 'failed')
        && !orchestrator.isActive(project.id)
      ));
      let deleted = 0;
      for (const project of targets) {
        const result = await deleteProject(project.id, 'bulk', '批量清理非 Web 项目');
        if (result.ok === true) deleted += 1;
      }
      return { ok: true, deleted, total: targets.length };
    }
    if (kind === 'idle-envs') {
      const targets = store.listProjects().filter((project) => (
        project.envStatus === 'ready'
        && (project.status === 'completed' || project.status === 'failed')
        && !orchestrator.isActive(project.id)
      ));
      let cleaned = 0;
      const failures = [];
      for (const project of targets) {
        const result = await orchestrator.cleanupEnvironment(project);
        if (result.ok === true) cleaned += 1;
        else failures.push(`${project.name}: ${result.error}`);
      }
      return { ok: true, cleaned, total: targets.length, failures };
    }
    return { ok: false, error: `未知批量操作：${kind}` };
  }

  // ---------------------------------------------------------------------
  // Monitors
  // ---------------------------------------------------------------------

  async function addMonitor(input) {
    const repoUrl = normalizeRepoUrl(input?.repoUrl);
    const intervalMin = clamp(Number(input?.intervalMin) || effectiveSettings().monitorIntervalMin, 5, 1440);
    const language = LANGUAGE_VALUES.includes(input?.language) ? input.language : null;
    const preview = await previewRepo({ url: repoUrl, timeoutMs: 20000 });
    const monitors = store.getMonitors();
    if (monitors.some((monitor) => normalizeRepoUrl(monitor.repoUrl) === repoUrl)) {
      return { ok: false, error: '该仓库已经在监控列表中' };
    }
    const monitor = {
      id: shortId('mon'),
      repoUrl,
      projectPrefix: String(input?.projectPrefix ?? preview.repo).slice(0, 80) || preview.repo,
      lastReleaseTag: preview.latestTag,
      intervalMin,
      enabled: input?.enabled !== false,
      language,
      options: normalizeOptions(input?.options),
      lastChecked: null,
      lastTriggered: null,
      lastError: null,
      createdAt: Date.now(),
    };
    store.setMonitors([...monitors, monitor]);
    events.metaChanged({ monitors: store.getMonitors(), recycle: store.getRecycle() });
    return { ok: true, monitor };
  }

  function updateMonitor(id, patch) {
    const monitors = store.getMonitors();
    const index = monitors.findIndex((monitor) => monitor.id === id);
    if (index === -1) return { ok: false, error: '监控不存在' };
    const next = { ...monitors[index] };
    if (patch?.enabled !== undefined) next.enabled = patch.enabled === true;
    if (patch?.intervalMin !== undefined) next.intervalMin = clamp(Number(patch.intervalMin) || 30, 5, 1440);
    if (patch?.projectPrefix !== undefined) next.projectPrefix = String(patch.projectPrefix).slice(0, 80);
    monitors[index] = next;
    store.setMonitors(monitors);
    events.metaChanged({ monitors: store.getMonitors(), recycle: store.getRecycle() });
    return { ok: true, monitor: next };
  }

  function removeMonitor(id) {
    const monitors = store.getMonitors().filter((monitor) => monitor.id !== id);
    store.setMonitors(monitors);
    events.metaChanged({ monitors: store.getMonitors(), recycle: store.getRecycle() });
    return { ok: true };
  }

  async function checkMonitor(id) {
    const monitors = store.getMonitors();
    const monitor = monitors.find((row) => row.id === id);
    if (monitor === undefined) return { ok: false, error: '监控不存在' };
    try {
      const tags = await listTags(monitor.repoUrl);
      const newest = tags[0]?.name ?? null;
      monitor.lastChecked = Date.now();
      monitor.lastError = null;
      store.setMonitors(monitors);
      if (newest === null || newest === monitor.lastReleaseTag) {
        events.metaChanged({ monitors: store.getMonitors(), recycle: store.getRecycle() });
        return { ok: true, triggered: false, latestTag: newest };
      }
      const created = await createFromMonitor(monitor, newest);
      monitor.lastReleaseTag = newest;
      monitor.lastTriggered = Date.now();
      if (created.ok !== true) monitor.lastError = created.error;
      store.setMonitors(monitors);
      events.metaChanged({ monitors: store.getMonitors(), recycle: store.getRecycle() });
      return { ok: true, triggered: created.ok === true, latestTag: newest, project: created.project ?? null, error: created.error };
    } catch (error) {
      monitor.lastChecked = Date.now();
      monitor.lastError = truncate(error instanceof Error ? error.message : String(error), 500);
      store.setMonitors(monitors);
      events.metaChanged({ monitors: store.getMonitors(), recycle: store.getRecycle() });
      return { ok: false, error: monitor.lastError };
    }
  }

  async function createFromMonitor(monitor, tag) {
    const existing = store.listProjects().find((project) => (
      project.sourceType === 'github'
      && normalizeRepoUrl(project.sourceRef) === normalizeRepoUrl(monitor.repoUrl)
      && project.sourceVersion === tag
    ));
    if (existing !== undefined) return { ok: false, error: `版本 ${tag} 已存在审计` };
    const project = mintProject({
      name: `${monitor.projectPrefix || repoName(monitor.repoUrl)}-${tag}`.slice(0, 160),
      language: LANGUAGE_VALUES.includes(monitor.language) ? monitor.language : null,
      options: monitor.options,
      sourceType: 'github',
      sourceRef: monitor.repoUrl,
      sourceVersion: tag,
      remoteTags: [],
    });
    project.gitRef = tag;
    project.monitorId = monitor.id;
    await store.createProject(project);
    void prepareGithub(project, monitor.repoUrl, tag).catch((error) => logger?.warn?.(`code-audit: monitor preparation failed: ${error instanceof Error ? error.message : String(error)}`));
    events.projectChanged(project);
    return { ok: true, project: projectSummary(project) };
  }

  async function checkDueMonitors() {
    try {
      const monitors = store.getMonitors();
      const now = Date.now();
      for (const monitor of monitors) {
        if (monitor.enabled !== true) continue;
        const interval = Math.max(5, Number(monitor.intervalMin) || 30) * 60000;
        const last = Number(monitor.lastChecked) || 0;
        if (now - last < interval) continue;
        await checkMonitor(monitor.id);
      }
    } catch (error) {
      logger?.warn?.(`code-audit: monitor check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function settingsTest() {
    const selection = await runner.resolveSelection();
    const started = Date.now();
    const llm = getService('llm');
    if (llm === undefined || typeof llm.listProviders !== 'function') {
      return { ok: false, error: '当前环境没有 llm 服务，无法测试连通性' };
    }
    try {
      const providers = llm.listProviders().map((provider) => provider.id);
      const provider = selection.agentOptions?.provider ?? providers[0];
      if (provider === undefined) return { ok: false, error: '没有可用的模型提供方' };
      if (!providers.includes(provider)) {
        return { ok: false, error: `提供方 ${provider} 未注册（已注册：${providers.join(', ') || '无'}）` };
      }
      const models = await llm.listModels(provider);
      const model = selection.agentOptions?.model ?? models[0]?.id ?? '';
      return {
        ok: true,
        provider,
        model,
        models: Array.isArray(models) ? models.length : 0,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function pruneUploads() {
    const { readdir } = await import('node:fs/promises');
    try {
      const names = await readdir(paths.uploadsDir);
      const now = Date.now();
      for (const name of names) {
        const file = path.join(paths.uploadsDir, name);
        try {
          const info = await stat(file);
          if (now - info.mtimeMs > UPLOAD_TTL_MS) await unlink(file);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* no uploads yet */
    }
  }

  /**
   * Recompute the front-end RCE flag from stored findings. Older builds could
   * set it from a coarse category such as 命令执行 even when the verified
   * finding was only argument injection / local file read.
   */
  function repairFrontendRce() {
    let changed = 0;
    for (const project of store.listProjects()) {
      const findings = store.getFindings(project.id);
      if (!Array.isArray(findings) || findings.length === 0) continue;
      const next = computeFrontendRce(findings, project);
      if (project.frontendRce !== next) {
        project.frontendRce = next;
        store.updateProject(project.id, { frontendRce: next });
        events.projectChanged?.(project);
        changed += 1;
      }
    }
    return changed;
  }

  return {
    // settings / capabilities
    publicSettings,
    updateSettings,
    effectiveSettings,
    capabilities,
    settingsTest,
    // creation
    previewGithub,
    createProject,
    // reads
    listProjects,
    getProject,
    getState,
    repairFrontendRce,
    // control
    controlProject,
    deleteProject,
    rerunStage,
    bulk,
    // monitors
    addMonitor,
    updateMonitor,
    removeMonitor,
    checkMonitor,
    checkDueMonitors,
    // misc
    pruneUploads,
    statusText,
    resolveUpload,
    getMonitors: () => store.getMonitors(),
    summary: projectSummary,
    getSnapshot,
    maxLanes: MAX_LANES,
    severityLabel: SEVERITY_LABEL,
    lanesForLanguage,
  };
}
