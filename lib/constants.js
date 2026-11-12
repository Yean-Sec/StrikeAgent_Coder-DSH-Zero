/**
 * Shared constants: defaults, status vocabulary, stage graph, hazard palette,
 * language lanes and tool labels. Host and Client own their own copies of the
 * browser-facing pieces; this file is the Host source of truth.
 */

export const STORE_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  dataDir: '',
  allowRemote: false,
  subagentProvider: 'spawn',
  modelOverride: '',
  promptSection: true,
  globalEnabled: true,
  protectPages: false,
  maxConcurrentAudit: 5,
  maxConcurrentVerify: 5,
  maxConcurrentEnv: 5,
  maxConcurrentChildren: 24,
  laneConcurrency: 8,
  laneBatchSize: 10,
  dedupeThreshold: 15,
  stageTimeoutMs: 5400000,
  idleTimeoutMs: 1500000,
  verifyTimeoutMs: 900000,
  verifyIdleTimeoutMs: 300000,
  finishGraceMs: 120000,
  stageRetries: 1,
  maxUploadBytes: 8589934592,
  maxExtractBytes: 21474836480,
  maxExtractFiles: 200000,
  historyMaxVersions: 3,
  monitorIntervalMin: 30,
});

/** Runtime-editable settings (Settings page) with their defaults. */
export const DEFAULT_SETTINGS = Object.freeze({
  auditPromptExtra: '',
  verifyPromptExtra: '',
  globalEnabled: true,
  protectPages: false,
  maxConcurrentAudit: 5,
  maxConcurrentVerify: 5,
  maxConcurrentEnv: 5,
  maxConcurrentChildren: 24,
  laneConcurrency: 8,
  laneBatchSize: 10,
  dedupeThreshold: 15,
  stageTimeoutMs: 5400000,
  idleTimeoutMs: 1500000,
  verifyTimeoutMs: 900000,
  verifyIdleTimeoutMs: 300000,
  finishGraceMs: 120000,
  stageRetries: 1,
  historyMaxVersions: 3,
  monitorIntervalMin: 30,
  modelOverride: '',
});

export const PROJECT_STATUS = Object.freeze([
  'pending', 'queued', 'running', 'paused', 'completed', 'failed',
]);

export const VERIFY_STATUS = Object.freeze([
  'none', 'queued', 'running', 'paused', 'completed', 'failed',
]);

export const ENV_STATUS = Object.freeze(['none', 'building', 'ready', 'failed']);

export const PREPARE_STATE = Object.freeze([
  'pending', 'extracting', 'cloning', 'ready', 'failed',
]);

export const STAGE_STATUS = Object.freeze([
  'pending', 'running', 'done', 'skipped', 'paused', 'failed',
]);

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);

export const SEVERITY_LABEL = Object.freeze({
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
  info: '提示',
});

export const SEVERITY_RANK = Object.freeze({
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
});

/** Fixed hazard palette (guide §4). Never follows the UI accent. */
export const HAZARD_COLORS = Object.freeze({
  critical: '#c64545',
  high: '#cc785c',
  medium: '#d4a017',
  low: '#5db8a6',
  info: '#8e8b82',
});

export const AUDIT_STAGES = Object.freeze([
  { key: 'dispatch', label: '主智能体调度' },
  { key: 'audit', label: '多智能体审计' },
  { key: 'dedupe', label: 'AI 智能去重' },
  { key: 'codeverify', label: '代码级验证' },
  { key: 'regrade', label: '红队二次评级' },
  { key: 'done', label: '审计完成' },
]);

export const VERIFY_STAGES = Object.freeze([
  { key: 'vdispatch', label: '主智能体调度' },
  { key: 'env', label: '靶机环境搭建' },
  { key: 'remote', label: '远程验证' },
  { key: 'chain', label: '组合验证' },
  { key: 'vdone', label: '验证完成' },
]);

export const AUDIT_STAGE_KEYS = Object.freeze(AUDIT_STAGES.map((stage) => stage.key));
export const VERIFY_STAGE_KEYS = Object.freeze(VERIFY_STAGES.map((stage) => stage.key));

/** The 11 supported audit languages. */
export const LANGUAGES = Object.freeze([
  { value: 'java', label: 'Java' },
  { value: 'go', label: 'Go' },
  { value: 'python', label: 'Python' },
  { value: 'php', label: 'PHP' },
  { value: 'jsts', label: 'JavaScript/TypeScript' },
  { value: 'rust', label: 'Rust' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'csharp', label: 'C#/.NET' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'solidity', label: 'Solidity' },
]);

export const LANGUAGE_VALUES = Object.freeze(LANGUAGES.map((language) => language.value));

export const RUNTIME_VALUES = Object.freeze(['full', 'none']);

export const AUTH_VALUES = Object.freeze(['none', 'user', 'admin']);

export const REGRADE_VALUES = Object.freeze(['高', '中', '低', '无']);

/** Subagent tool label map used by the live activity line. */
export const TOOL_LABEL = Object.freeze({
  read: '读取文件',
  grep: '检索代码',
  glob: '匹配文件',
  bash: '执行命令',
  pwsh: '执行命令',
  write: '写入文件',
  edit: '编辑文件',
  apply_patch: '编辑文件',
  subagent: '派发子智能体',
  skill: '启动技能',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  todo_write: '更新待办',
  list_agents: '列出子智能体',
  send_message: '发送消息',
  ask_user_question: '询问用户',
});

export const TOOL_NAMES = Object.freeze({
  audit: 'code_audit',
});

/** Maximum lanes per language audit wave (guide says 4). */
export const MAX_LANES = 4;

/** Concurrent verification children per project (guide: 5). */
export const REMOTE_VERIFY_CONCURRENCY = 5;

/** Batches per parallel wave for dedupe/verify/regrade. */
export const BATCH_WAVE_LIMIT = 8;
