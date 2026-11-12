/**
 * Derive the live flow and the list summary from one project record.
 *
 * Node state is computed on the Host from explicit stage state — the UI never
 * guesses a stage from assistant text.
 */
import { AUDIT_STAGES, VERIFY_STAGES } from './constants.js';

const ONE_NODE_STATUS = new Set(['pending', 'running', 'done', 'skipped', 'paused', 'failed']);

function nodeStatus(project, key) {
  const status = project?.stageStatus?.[key];
  return ONE_NODE_STATUS.has(status) ? status : 'pending';
}

function auditIndex(project) {
  for (let index = AUDIT_STAGES.length - 1; index >= 0; index -= 1) {
    const status = nodeStatus(project, AUDIT_STAGES[index].key);
    if (status === 'running' || status === 'paused' || status === 'failed') return index;
  }
  if (project.status === 'completed' || nodeStatus(project, 'done') === 'done') return AUDIT_STAGES.length - 1;
  // First pending stage after the last completed one.
  for (let index = 0; index < AUDIT_STAGES.length; index += 1) {
    const status = nodeStatus(project, AUDIT_STAGES[index].key);
    if (status !== 'done' && status !== 'skipped') return index;
  }
  return AUDIT_STAGES.length - 1;
}

function verifyIndex(project) {
  for (let index = VERIFY_STAGES.length - 1; index >= 0; index -= 1) {
    const status = nodeStatus(project, VERIFY_STAGES[index].key);
    if (status === 'running' || status === 'paused' || status === 'failed') return index;
  }
  if (project.verifyStatus === 'completed') return VERIFY_STAGES.length - 1;
  for (let index = 0; index < VERIFY_STAGES.length; index += 1) {
    const status = nodeStatus(project, VERIFY_STAGES[index].key);
    if (status !== 'done' && status !== 'skipped') return index;
  }
  return VERIFY_STAGES.length - 1;
}

/**
 * Build the flow object consumed by the console.
 * @param {object} project
 * @returns {object}
 */
export function buildFlow(project) {
  const auditDone = project.status === 'completed' || nodeStatus(project, 'done') === 'done';
  const verifyEnabled = project.options?.runtime === 'full';
  const verifyDone = project.verifyStatus === 'completed';
  const auditCurrent = auditIndex(project);
  const verifyCurrent = verifyEnabled ? verifyIndex(project) : 0;

  const auditNodes = AUDIT_STAGES.map((stage, index) => ({
    key: stage.key,
    label: stage.label,
    status: nodeStatus(project, stage.key),
    current: index === auditCurrent && !auditDone,
  }));
  const verifyNodes = VERIFY_STAGES.map((stage, index) => ({
    key: stage.key,
    label: stage.label,
    status: verifyEnabled ? nodeStatus(project, stage.key) : 'skipped',
    current: verifyEnabled && index === verifyCurrent && !verifyDone,
  }));
  // The environment node also reflects the pre-warm status while the audit lane runs.
  if (verifyEnabled && project.envStatus === 'building') {
    const node = verifyNodes.find((entry) => entry.key === 'env');
    if (node !== undefined && node.status === 'pending') node.status = 'running';
  }

  const enabledNodes = verifyEnabled ? [...auditNodes, ...verifyNodes] : auditNodes;
  const settled = enabledNodes.filter((node) => node.status === 'done' || node.status === 'skipped').length;
  const progress = enabledNodes.length === 0 ? 0 : Math.round((settled / enabledNodes.length) * 100);

  let caption;
  let stepName;
  if (!auditDone) {
    caption = `审计阶段 · ${auditCurrent + 1}/6`;
    stepName = AUDIT_STAGES[auditCurrent]?.label ?? AUDIT_STAGES[0].label;
  } else if (!verifyEnabled) {
    caption = '审计完成（不验证）';
    stepName = '审计完成';
  } else if (verifyDone) {
    caption = '全流程 · 11/11';
    stepName = '验证完成';
  } else {
    caption = `验证阶段 · ${verifyCurrent + 1}/5`;
    stepName = VERIFY_STAGES[verifyCurrent]?.label ?? VERIFY_STAGES[0].label;
  }

  const bridge = !verifyEnabled
    ? 'disabled'
    : verifyDone
      ? 'done'
      : project.envStatus === 'building' || project.envStatus === 'ready'
        ? 'flowing'
        : 'pending';

  const activity = typeof project.activity?.text === 'string' && project.activity.text.length > 0
    ? project.activity.text
    : project.prepareState === 'extracting'
      ? '正在解压源码…'
      : project.prepareState === 'cloning'
        ? '正在克隆仓库…'
        : project.status === 'queued'
          ? '等待调度…'
          : '等待开始';

  return {
    audit: { nodes: auditNodes, current: auditCurrent, done: auditDone, state: project.status },
    verify: {
      enabled: verifyEnabled,
      nodes: verifyNodes,
      current: verifyCurrent,
      done: verifyDone,
      state: project.verifyStatus,
    },
    bridge,
    caption,
    stepName,
    progress,
    activity,
  };
}

/** Compact project row for lists, SSE frames and the tool. */
export function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    sourceType: project.sourceType,
    sourceRef: project.sourceRef,
    sourceVersion: project.sourceVersion ?? null,
    archiveName: project.archiveName ?? null,
    language: project.language,
    status: project.status,
    verifyStatus: project.verifyStatus,
    envStatus: project.envStatus,
    prepareState: project.prepareState,
    options: project.options,
    counts: project.counts,
    verifiedCount: project.verifiedCount ?? 0,
    frontendRce: project.frontendRce === true,
    sessionId: project.sessionId ?? null,
    hasWeb: project.hasWeb ?? null,
    createdAt: project.createdAt,
    startedAt: project.startedAt ?? null,
    finishedAt: project.finishedAt ?? null,
    errorMessage: project.errorMessage ?? null,
    activity: project.activity ?? null,
    runId: project.runId ?? null,
    reportReady: typeof project.report?.generatedAt === 'string',
    flow: buildFlow(project),
  };
}

/** Human status copy from guide §2. */
export function statusText(project) {
  if (project.status === 'failed') return '审计失败';
  if (project.status === 'paused') return '审计已暂停';
  if (project.status === 'running') return '代码审计中';
  if (project.status === 'queued') return '审计排队中';
  if (project.status === 'pending') return '待开始';
  if (project.status === 'completed') {
    if (project.options?.runtime !== 'full') return '审计完成（不验证）';
    if (project.verifyStatus === 'failed') return '验证失败';
    if (project.verifyStatus === 'paused') return '验证已暂停';
    if (project.verifyStatus === 'running') return '靶机验证中';
    if (project.verifyStatus === 'queued') return '验证排队中';
    if (project.verifyStatus === 'completed') return '全部完成';
    return '审计完成（不验证）';
  }
  return '待开始';
}
