/**
 * Plugin configuration resolution.
 *
 * The bundle exports no Cordis `Config` schema on purpose: the Loader passes the
 * raw `config` object through unchanged when a plugin declares none, so this
 * module applies defaults, type checks and clamps and reports warnings instead
 * of ever preventing activation.
 */
import { DEFAULT_CONFIG } from './constants.js';

const BOOLEAN_KEYS = new Set([
  'enabled',
  'allowRemote',
  'promptSection',
  'globalEnabled',
  'protectPages',
]);

const NUMBER_KEYS = new Set([
  'maxConcurrentAudit',
  'maxConcurrentVerify',
  'maxConcurrentEnv',
  'maxConcurrentChildren',
  'laneConcurrency',
  'laneBatchSize',
  'dedupeThreshold',
  'stageTimeoutMs',
  'idleTimeoutMs',
  'verifyTimeoutMs',
  'verifyIdleTimeoutMs',
  'finishGraceMs',
  'stageRetries',
  'maxUploadBytes',
  'maxExtractBytes',
  'maxExtractFiles',
  'historyMaxVersions',
  'monitorIntervalMin',
]);

const STRING_KEYS = new Set(['dataDir', 'subagentProvider', 'modelOverride']);

const LIMITS = {
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
  maxUploadBytes: [1048576, 8589934592 * 4],
  maxExtractBytes: [1048576, 8589934592 * 8],
  maxExtractFiles: [1, 2000000],
  historyMaxVersions: [1, 10],
  monitorIntervalMin: [5, 1440],
};

/**
 * Resolve one raw config object.
 * @param {unknown} raw raw `config` mapping.
 * @returns {{config: object, warnings: string[]}}
 */
export function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG };
  const warnings = [];
  if (raw === undefined || raw === null) return { config, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('config must be a mapping; using defaults');
    return { config, warnings };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') {
        warnings.push(`${key} must be boolean; got ${typeof value}`);
        continue;
      }
      config[key] = value;
      continue;
    }
    if (NUMBER_KEYS.has(key)) {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) {
        warnings.push(`${key} must be a number; got ${String(value)}`);
        continue;
      }
      const [min, max] = LIMITS[key] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
      const clamped = Math.min(max, Math.max(min, Math.round(number)));
      if (clamped !== number) warnings.push(`${key} clamped to ${clamped}`);
      config[key] = clamped;
      continue;
    }
    if (STRING_KEYS.has(key)) {
      if (typeof value !== 'string') {
        warnings.push(`${key} must be a string; got ${typeof value}`);
        continue;
      }
      config[key] = value.trim();
      continue;
    }
    warnings.push(`unknown config key: ${key}`);
  }
  return { config, warnings };
}

/** Human-readable activation summary for the log line. */
export function describeConfig(config) {
  return [
    `dataDir=${config.dataDir || '<DSH_HOME>/codeaudit'}`,
    `audit=${config.maxConcurrentAudit}`,
    `verify=${config.maxConcurrentVerify}`,
    `lanes=${config.laneConcurrency}`,
    `provider=${config.subagentProvider}`,
  ].join(' ');
}
