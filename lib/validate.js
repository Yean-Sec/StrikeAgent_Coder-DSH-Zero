/**
 * Stage artifact validation.
 *
 * Model output is untrusted: every stage gets a compact schema check, enum
 * coercion and normalization. A stage is only usable when its object exists;
 * individual bad rows are dropped with a recorded problem instead of aborting
 * the whole run.
 */
import {
  AUTH_VALUES,
  LANGUAGE_VALUES,
  MAX_LANES,
  REGRADE_VALUES,
  SEVERITIES,
  SEVERITY_RANK,
} from './constants.js';
import { lanesForLanguage } from './prompts/languages.js';
import { isObject, pickEnum, truncate } from './util.js';

function asString(value, fallback = '') {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return fallback;
}

function asLine(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

export function normalizeSeverity(value) {
  const text = asString(value).toLowerCase();
  const map = {
    critical: 'critical', '严重': 'critical', '致命': 'critical', rce: 'critical',
    high: 'high', '高危': 'high', '高': 'high',
    medium: 'medium', '中危': 'medium', '中': 'medium', moderate: 'medium',
    low: 'low', '低危': 'low', '低': 'low',
    info: 'info', informational: 'info', '提示': 'info', '信息': 'info', none: 'info',
  };
  return map[text] ?? 'medium';
}

export function normalizeAuth(value) {
  const text = asString(value).toLowerCase();
  const map = {
    none: 'none', '无需登录': 'none', '未授权': 'none', anonymous: 'none', unauthenticated: 'none',
    user: 'user', '普通用户': 'user', 'user': 'user', authenticated: 'user', low: 'user',
    admin: 'admin', '管理员': 'admin', administrator: 'admin', high: 'admin',
  };
  return map[text] ?? 'none';
}

function normalizeLaneKey(value, index) {
  const text = asString(value).toLowerCase();
  const map = {
    cmd: 'cmd', command: 'cmd', rce: 'cmd', exec: 'cmd', '命令执行': 'cmd',
    inject: 'inject', injection: 'inject', sqli: 'inject', '注入': 'inject', '综合安全': 'inject',
    file: 'file', files: 'file', path: 'file', '文件': 'file', '文件系统': 'file', '文件与路径': 'file',
    auth: 'auth', authentication: 'auth', authorization: 'auth', '认证': 'auth', '认证与越权': 'auth', '权限控制': 'auth',
    mem: 'mem', memory: 'mem', '内存破坏': 'mem',
    reent: 'reent', reentrancy: 'reent', '重入': 'reent', '重入与外部调用': 'reent',
    logic: 'logic', '算术与逻辑': 'logic',
    dep: 'dep', depends: 'dep', '依赖与升级': 'dep',
  };
  return map[text] ?? ['cmd', 'inject', 'file', 'auth'][index % 4];
}

function normalizeCandidate(raw, index, note = '') {
  if (!isObject(raw)) return null;
  const file = asString(raw.file ?? raw.filePath ?? raw.path);
  if (file.length === 0) return null;
  const title = truncate(asString(raw.title ?? raw.name) || `未命名问题 ${index + 1}`, 200);
  return {
    id: asString(raw.id) || `cand-${index + 1}`,
    title,
    severity: normalizeSeverity(raw.severity),
    category: truncate(asString(raw.category ?? raw.type) || '其他', 80),
    file: file.replace(/\\/gu, '/'),
    line: asLine(raw.line ?? raw.lineNumber),
    description: truncate(asString(raw.description), 6000),
    recommendation: truncate(asString(raw.recommendation ?? raw.fix), 4000),
    codeSnippet: truncate(asString(raw.codeSnippet ?? raw.code ?? raw.snippet), 4000),
    taintChain: truncate(asString(raw.taintChain ?? raw.taint), 4000),
    entry: truncate(asString(raw.entry ?? raw.entryPoint), 300),
    authRequired: normalizeAuth(raw.authRequired ?? raw.auth ?? raw.permission),
    confidence: truncate(asString(raw.confidence), 40),
    note: truncate(note, 200),
  };
}

/**
 * Validate the dispatcher plan.
 * @param {unknown} input
 * @param {string} language
 */
export function validatePlan(input, language) {
  if (!isObject(input)) return { ok: false, value: null, problems: ['计划不是对象'] };
  const problems = [];
  const rawLanes = Array.isArray(input.lanes) ? input.lanes : [];
  const defaultLanes = lanesForLanguage(language);
  const lanes = [];
  for (let index = 0; index < rawLanes.length && lanes.length < MAX_LANES; index += 1) {
    const lane = rawLanes[index];
    if (!isObject(lane)) continue;
    const fallback = defaultLanes[lanes.length] ?? defaultLanes[0];
    const key = normalizeLaneKey(lane.key ?? lane.label, index);
    lanes.push({
      key,
      label: truncate(asString(lane.label) || fallback?.label || key, 60),
      focus: truncate(asString(lane.focus ?? lane.description) || fallback?.focus || '', 600),
      seedFiles: Array.isArray(lane.seedFiles)
        ? lane.seedFiles.map((item) => truncate(asString(item), 300)).filter(Boolean).slice(0, 40)
        : [],
    });
  }
  if (lanes.length === 0) {
    problems.push('未给出专项路数，使用语言默认分路');
    for (const lane of defaultLanes.slice(0, MAX_LANES)) lanes.push({ ...lane, seedFiles: [] });
  }
  const hasWeb = typeof input.hasWeb === 'boolean' ? input.hasWeb : null;
  // The dispatcher may correct the Host's first guess after reading the code.
  const resolvedLanguage = LANGUAGE_VALUES.includes(input.language) ? input.language : language;
  return {
    ok: true,
    value: {
      language: resolvedLanguage,
      hasWeb,
      hasRegistration: typeof input.hasRegistration === 'boolean' ? input.hasRegistration : null,
      regDefaultOpen: typeof input.regDefaultOpen === 'boolean' ? input.regDefaultOpen : null,
      lanes,
      notes: truncate(asString(input.notes), 2000),
    },
    problems,
  };
}

/** Validate one audit-lane result. */
export function validateAuditLane(input, lane) {
  if (!isObject(input)) return { ok: false, value: null, problems: ['审计产物不是对象'] };
  const raw = Array.isArray(input.candidates) ? input.candidates : [];
  const candidates = [];
  const problems = [];
  for (let index = 0; index < raw.length; index += 1) {
    const candidate = normalizeCandidate(raw[index], index);
    if (candidate === null) {
      problems.push(`丢弃无效候选 #${index + 1}（缺少文件路径）`);
      continue;
    }
    candidate.id = `${lane.key}-${index + 1}`;
    candidate.sourceLane = lane.key;
    candidates.push(candidate);
  }
  return {
    ok: true,
    value: { lane: lane.key, candidates },
    problems,
  };
}

/**
 * Mechanical de-duplication before the optional AI pass.
 * @param {object[]} candidates
 * @returns {{kept: object[], removed: object[]}}
 */
export function mechanicalDedupe(candidates) {
  const kept = [];
  const removed = [];
  const buckets = new Map();
  for (const candidate of candidates) {
    const titleKey = candidate.title.toLowerCase().replace(/[\s\p{P}]+/gu, '');
    const lineBucket = candidate.line === null ? 'x' : Math.round(candidate.line / 3);
    const key = `${candidate.file}|${lineBucket}|${candidate.category}|${titleKey.slice(0, 24)}`;
    const existing = buckets.get(key);
    if (existing !== undefined) {
      removed.push({ id: candidate.id, reason: `机械去重：与 ${existing.id} 同文件同行同类别`, mergedInto: existing.id });
      // Keep the richer taint chain and the higher severity.
      if (carriedMore(candidate, existing)) Object.assign(existing, {
        severity: SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity] ? candidate.severity : existing.severity,
        taintChain: candidate.taintChain.length > existing.taintChain.length ? candidate.taintChain : existing.taintChain,
        codeSnippet: candidate.codeSnippet.length > existing.codeSnippet.length ? candidate.codeSnippet : existing.codeSnippet,
        description: candidate.description.length > existing.description.length ? candidate.description : existing.description,
        recommendation: candidate.recommendation.length > existing.recommendation.length ? candidate.recommendation : existing.recommendation,
        authRequired: candidate.authRequired === 'none' ? 'none' : existing.authRequired,
      });
      continue;
    }
    buckets.set(key, candidate);
    kept.push(candidate);
  }
  return { kept, removed };
}

function carriedMore(candidate, existing) {
  return SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity]
    || candidate.taintChain.length > existing.taintChain.length
    || candidate.codeSnippet.length > existing.codeSnippet.length;
}

/** Validate the AI de-duplication result. */
export function validateDedupe(input) {
  if (!isObject(input)) return { ok: false, value: null, problems: ['去重产物不是对象'] };
  const problems = [];
  const removed = Array.isArray(input.removed)
    ? input.removed
      .filter((row) => isObject(row) && asString(row.id).length > 0)
      .map((row) => ({
        id: asString(row.id),
        reason: truncate(asString(row.reason) || 'AI 判定重复', 400),
        mergedInto: asString(row.mergedInto ?? row.merged_into) || null,
      }))
    : [];
  const clusters = Array.isArray(input.clusters)
    ? input.clusters
      .filter((row) => isObject(row))
      .map((row, index) => ({
        clusterId: asString(row.clusterId ?? row.cluster_id) || `cluster-${index + 1}`,
        candidateIds: Array.isArray(row.candidateIds ?? row.candidate_ids)
          ? (row.candidateIds ?? row.candidate_ids).map((id) => asString(id)).filter(Boolean)
          : [],
        note: truncate(asString(row.note), 600),
      }))
      .filter((row) => row.candidateIds.length > 0)
    : [];
  if (removed.length === 0 && clusters.length === 0) problems.push('去重结果为空，保留全部候选');
  return { ok: true, value: { removed, clusters }, problems };
}

/** Validate code-level verification. */
export function validateCodeVerify(input) {
  if (!isObject(input)) return { ok: false, value: null, problems: ['验证产物不是对象'] };
  const raw = Array.isArray(input.results) ? input.results : [];
  const results = [];
  const problems = [];
  for (const row of raw) {
    if (!isObject(row)) continue;
    const id = asString(row.id);
    if (id.length === 0) continue;
    const evidence = isObject(row.evidence) ? row.evidence : {};
    results.push({
      id,
      verified: row.verified === true,
      reason: truncate(asString(row.reason) || (row.verified === true ? '源码路径可走通' : '未能证明可达'), 2000),
      evidence: {
        file: truncate(asString(evidence.file), 300),
        line: asLine(evidence.line),
        snippet: truncate(asString(evidence.snippet), 2000),
      },
    });
  }
  if (results.length === 0) problems.push('代码级验证没有返回结论');
  return { ok: true, value: { results }, problems };
}

/** Validate the red-team re-rating result. */
export function validateRegrade(input) {
  if (!isObject(input)) return { ok: false, value: null, problems: ['评级产物不是对象'] };
  const raw = Array.isArray(input.results) ? input.results : [];
  const results = [];
  const problems = [];
  for (const row of raw) {
    if (!isObject(row)) continue;
    const id = asString(row.id);
    if (id.length === 0) continue;
    results.push({
      id,
      severity: SEVERITIES.includes(asString(row.severity).toLowerCase())
        ? asString(row.severity).toLowerCase()
        : normalizeSeverity(row.severity),
      value: REGRADE_VALUES.includes(asString(row.value)) ? asString(row.value) : '无',
      title: truncate(asString(row.title), 200),
      category: truncate(asString(row.category), 80),
      reason: truncate(asString(row.reason) || '按实战价值复核', 2000),
      authRequired: AUTH_VALUES.includes(asString(row.authRequired)) ? asString(row.authRequired) : normalizeAuth(row.authRequired),
      authReason: truncate(asString(row.authReason), 600),
    });
  }
  if (results.length === 0) problems.push('评级没有返回结论');
  return { ok: true, value: { results }, problems };
}

/** Validate the target-environment stage. */
export function validateEnv(input) {
  if (!isObject(input)) return { ok: false, value: null, problems: ['环境产物不是对象'] };
  const mode = input.mode === 'compose' || input.mode === 'sandbox' ? input.mode : 'sandbox';
  const targetUrl = asString(input.targetUrl ?? input.target_url).replace(/\/+$/u, '');
  const problems = [];
  if (mode === 'compose' && !/^https?:\/\//u.test(targetUrl)) {
    problems.push('compose 模式没有给出可访问的 HTTP 地址');
  }
  return {
    ok: true,
    value: {
      mode,
      targetUrl,
      composeProject: truncate(asString(input.composeProject ?? input.compose_project), 120),
      hasWeb: typeof input.hasWeb === 'boolean' ? input.hasWeb : null,
      regDefaultOpen: typeof input.regDefaultOpen === 'boolean' ? input.regDefaultOpen : null,
      notes: truncate(asString(input.notes), 2000),
      problems,
    },
    problems,
  };
}

/** Validate one remote (target-machine) verification result. */
export function validateRemote(input, findingId) {
  if (!isObject(input)) return { ok: false, value: null, problems: ['远程验证产物不是对象'] };
  const evidence = isObject(input.evidence) ? input.evidence : {};
  const problems = [];
  if (input.verified === true) {
    const request = asString(evidence.request);
    const response = asString(evidence.response);
    if (request.length === 0 || response.length === 0) {
      problems.push('声称验证成功但没有请求/响应证据');
    }
  }
  return {
    ok: true,
    value: {
      id: findingId,
      verified: input.verified === true && problems.length === 0,
      reason: truncate(asString(input.reason), 2000),
      evidence: {
        request: truncate(redactEvidence(evidence.request), 12000),
        response: truncate(redactEvidence(evidence.response), 12000),
        artifact: truncate(asString(evidence.artifact), 300),
        authRequired: AUTH_VALUES.includes(asString(evidence.authRequired))
          ? asString(evidence.authRequired)
          : normalizeAuth(evidence.authRequired),
        authReason: truncate(asString(evidence.authReason), 600),
      },
    },
    problems,
  };
}

function redactEvidence(value) {
  return truncate(asString(value), 12000);
}

/** Validate the combo-chain stage. */
export function validateChain(input) {
  if (!isObject(input)) return { ok: false, value: null, problems: ['组合验证产物不是对象'] };
  const raw = Array.isArray(input.chains) ? input.chains : [];
  const chains = raw
    .filter((row) => isObject(row))
    .map((row, index) => ({
      id: asString(row.id) || `chain-${index + 1}`,
      title: truncate(asString(row.title) || `组合利用链 ${index + 1}`, 200),
      findingIds: Array.isArray(row.findingIds) ? row.findingIds.map((id) => asString(id)).filter(Boolean) : [],
      steps: Array.isArray(row.steps) ? row.steps.map((step) => truncate(asString(step), 600)).filter(Boolean) : [],
      verified: row.verified === true,
      evidence: truncate(asString(row.evidence), 4000),
    }))
    .filter((row) => row.steps.length > 0 || row.verified);
  return { ok: true, value: { chains }, problems: [] };
}

/** Validate the optional historical-version replay. */
export function validateHistory(input) {
  if (!isObject(input)) return { ok: false, value: null, problems: ['历史版本产物不是对象'] };
  const raw = Array.isArray(input.results) ? input.results : [];
  return {
    ok: true,
    value: {
      results: raw
        .filter((row) => isObject(row))
        .map((row) => ({
          version: truncate(asString(row.version), 120),
          verified: row.verified === true,
          evidence: truncate(asString(row.evidence), 2000),
        })),
    },
    problems: [],
  };
}

/**
 * Enforce the guide rule: the second rating may only lower or keep severity.
 * @param {string} original
 * @param {string} candidate
 */
export function clampRegradeSeverity(original, candidate) {
  const from = SEVERITIES.includes(original) ? original : 'medium';
  const to = SEVERITIES.includes(candidate) ? candidate : from;
  return SEVERITY_RANK[to] > SEVERITY_RANK[from] ? from : to;
}

/** Utility used by tests and prompts. */
export function isKnownSeverity(value) {
  return SEVERITIES.includes(pickEnum(value, SEVERITIES, ''));
}
