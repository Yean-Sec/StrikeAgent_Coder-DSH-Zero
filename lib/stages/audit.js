/**
 * The five audit steps: dispatch → audit → dedupe → code verify → re-rate.
 *
 * Every function receives the active run context from the orchestrator and
 * returns `{ status, error?, note? }`; the orchestrator records stage status.
 */
import { LANGUAGE_VALUES } from '../constants.js';
import { lanesForLanguage } from '../prompts/languages.js';
import {
  buildAuditLanePrompt,
  buildCodeVerifyPrompt,
  buildDedupePrompt,
  buildDispatchPrompt,
  buildRegradePrompt,
} from '../prompts/audit.js';
import {
  clampRegradeSeverity,
  mechanicalDedupe,
  validateAuditLane,
  validateCodeVerify,
  validateDedupe,
  validatePlan,
  validateRegrade,
} from '../validate.js';
import {
  deriveFindings,
  keptCandidates,
  allCandidates,
  summarizeFindings,
} from '../pipeline.js';
import { nowIso, truncate } from '../util.js';

const MAX_WAVE = 8;

async function wave(run, items, build) {
  const concurrency = Math.max(1, Math.min(run.settings.laneConcurrency ?? 8, MAX_WAVE));
  const outcomes = [];
  for (let index = 0; index < items.length; index += concurrency) {
    if (run.paused) return { paused: true, outcomes };
    const slice = items.slice(index, index + concurrency);
    const settled = await Promise.all(slice.map((item, offset) => build(item, index + offset)));
    outcomes.push(...settled);
    if (run.paused) return { paused: true, outcomes };
  }
  return { paused: false, outcomes };
}

/** Read a lane result from the returned value or its artifact. */
function laneValue(result, validate) {
  if (result?.artifact !== undefined && result.artifact !== null) {
    return validate(result.artifact);
  }
  const textValue = result?.text;
  if (typeof textValue === 'string' && textValue.trim().length > 0) {
    // Lazy import keeps the JSON extractor in one place.
    return undefined;
  }
  return undefined;
}

export function createAuditStages() {
  /** Step 1: pick up to four lanes. */
  async function dispatch(run) {
    const artifact = run.artifact('dispatch/plan.json');
    const prompt = buildDispatchPrompt({
      project: run.project,
      sourceDir: run.srcDir,
      artifactPath: artifact,
      extra: run.settings.auditPromptExtra,
    });
    const result = await run.lane({
      stage: 'dispatch',
      key: 'dispatch',
      label: '主智能体调度',
      prompt,
      artifactPath: artifact,
      timeoutMs: run.settings.stageTimeoutMs,
      idleTimeoutMs: run.settings.idleTimeoutMs,
    });
    let plan;
    let problems = [];
    if (result.ok !== true) {
      const fallback = {
        language: run.project.language,
        hasWeb: null,
        hasRegistration: null,
        regDefaultOpen: null,
        lanes: lanesForLanguage(run.project.language).slice(0, 4).map((lane) => ({ ...lane, seedFiles: [] })),
        notes: `调度失败，使用语言默认分路：${result.error ?? '未知原因'}`,
      };
      plan = fallback;
      problems = [fallback.notes];
      run.note(`调度阶段失败，已回退默认分路：${truncate(result.error ?? '', 200)}`, 'error');
    } else {
      const validated = validatePlan(result.artifact ?? safeJson(result.text), run.project.language);
      if (validated.ok === false) {
        plan = {
          language: run.project.language,
          hasWeb: null,
          hasRegistration: null,
          regDefaultOpen: null,
          lanes: lanesForLanguage(run.project.language).slice(0, 4).map((lane) => ({ ...lane, seedFiles: [] })),
          notes: '调度产物无法解析，使用语言默认分路',
        };
        problems = validated.problems;
      } else {
        plan = validated.value;
        problems = validated.problems;
      }
    }
    if (LANGUAGE_VALUES.includes(plan.language) && plan.language !== run.project.language) {
      run.note(`语言由调度确认为 ${plan.language}（Host 初判 ${run.project.language ?? '未识别'}）`);
      run.project.language = plan.language;
    }
    run.pipeline.plan = plan;
    await run.write('dispatch/plan.json', plan);
    if (typeof plan.hasWeb === 'boolean') run.project.hasWeb = plan.hasWeb;
    if (typeof plan.hasRegistration === 'boolean') run.project.hasRegistration = plan.hasRegistration;
    if (typeof plan.regDefaultOpen === 'boolean') run.project.regDefaultOpen = plan.regDefaultOpen;
    for (const problem of problems) run.note(`调度提示：${problem}`);
    run.note(`分路完成：${plan.lanes.map((lane) => lane.label).join('、')}`);
    return { status: 'done' };
  }

  /** Step 2: run every lane in parallel, static discovery only. */
  async function audit(run) {
    const plan = run.pipeline.plan;
    const lanes = Array.isArray(plan?.lanes) ? plan.lanes : [];
    if (lanes.length === 0) return { status: 'failed', error: '调度没有给出任何专项路' };
    const { paused, outcomes } = await wave(run, lanes, async (lane) => {
      const artifact = run.artifact(`audit/${lane.key}.json`);
      const prompt = buildAuditLanePrompt({
        project: run.project,
        sourceDir: run.srcDir,
        lane,
        plan,
        artifactPath: artifact,
        extra: run.settings.auditPromptExtra,
      });
      const result = await run.lane({
        stage: 'audit',
        key: lane.key,
        label: `多智能体审计·${lane.label}`,
        prompt,
        artifactPath: artifact,
        timeoutMs: run.settings.stageTimeoutMs,
        idleTimeoutMs: run.settings.idleTimeoutMs,
      });
      const validated = validateAuditLane(result.artifact ?? safeJson(result.text), lane);
      if (validated.ok === true) {
        run.pipeline.lanes[lane.key] = validated.value.candidates;
        await run.write(`audit/${lane.key}.json`, { lane: lane.key, candidates: validated.value.candidates });
        for (const problem of validated.problems) run.note(`${lane.label}：${problem}`);
        run.note(`${lane.label} 完成：候选 ${validated.value.candidates.length} 条`, 'result');
        return { lane, ok: result.ok === true, count: validated.value.candidates.length, error: result.error };
      }
      run.note(`${lane.label} 产物无效：${validated.problems.join('；') || '无法解析'}`, 'error');
      return { lane, ok: false, count: 0, error: validated.problems.join('；') || '产物无法解析' };
    });
    if (paused) return { status: 'paused' };
    const failed = outcomes.filter((outcome) => outcome.ok !== true);
    const total = outcomes.reduce((sum, outcome) => sum + (outcome.count ?? 0), 0);
    run.note(`多智能体审计完成：${lanes.length - failed.length}/${lanes.length} 路成功，候选 ${total} 条`, 'result');
    if (failed.length === lanes.length) {
      return { status: 'failed', error: failed.map((outcome) => `${outcome.lane.label}: ${truncate(outcome.error ?? '', 160)}`).join('；') };
    }
    return { status: 'done' };
  }

  /** Step 3: mechanical de-dupe, plus the optional AI pass. */
  async function dedupe(run) {
    const candidates = allCandidates(run.pipeline);
    if (candidates.length === 0) return { status: 'skipped', note: '没有候选，跳过去重' };
    const mechanical = mechanicalDedupe(candidates);
    const removed = [...mechanical.removed];
    let clusters = [];
    let usedAi = false;
    const threshold = Number(run.settings.dedupeThreshold) || 0;
    if (run.project.options?.aiDedup === true && candidates.length >= threshold && run.settings.aiDedup !== false) {
      const inputPath = run.artifact('dedupe/input.json');
      await run.write('dedupe/input.json', { candidates });
      const artifact = run.artifact('dedupe/result.json');
      const prompt = buildDedupePrompt({
        project: run.project,
        sourceDir: run.srcDir,
        inputPath,
        artifactPath: artifact,
        candidateList: mechanical.kept,
        extra: run.settings.auditPromptExtra,
      });
      const result = await run.lane({
        stage: 'dedupe',
        key: 'dedupe',
        label: 'AI 智能去重',
        prompt,
        artifactPath: artifact,
        timeoutMs: run.settings.stageTimeoutMs,
        idleTimeoutMs: run.settings.idleTimeoutMs,
      });
      if (result.ok !== true) {
        run.note(`AI 去重失败，保留机械去重结果：${truncate(result.error ?? '', 200)}`, 'error');
      } else {
        const validated = validateDedupe(result.artifact ?? safeJson(result.text));
        if (validated.ok === true) {
          usedAi = true;
          removed.push(...validated.value.removed.filter((row) => !row.id.startsWith('removed-') && row.id.length > 0));
          clusters = validated.value.clusters;
          for (const problem of validated.problems) run.note(`去重提示：${problem}`);
        } else {
          run.note(`AI 去重产物无效：${validated.problems.join('；')}`, 'error');
        }
      }
    }
    // Drop duplicates that the AI reported but whose id is unknown.
    const known = new Set(candidates.map((candidate) => candidate.id));
    const dedupedRemoved = removed.filter((row) => known.has(row.id));
    run.pipeline.dedupe = { removed: dedupedRemoved, clusters, mechanical: true, ai: usedAi };
    await run.write('dedupe/result.json', run.pipeline.dedupe);
    const after = candidates.length - dedupedRemoved.length;
    run.note(`去重完成：${candidates.length} → ${after} 条${usedAi ? '（含 AI 语义去重）' : '（机械去重）'}`, 'result');
    if (!usedAi) {
      return {
        status: 'skipped',
        note: run.project.options?.aiDedup === true
          ? `候选数低于门槛（${threshold}），仅做机械去重`
          : '未开启 AI 去重，仅做机械去重',
      };
    }
    return { status: 'done' };
  }

  /** Step 4: verify every kept candidate against the source. */
  async function codeverify(run) {
    const candidates = keptCandidates(run.pipeline);
    if (candidates.length === 0) return { status: 'skipped', note: '没有候选，跳过代码级验证' };
    const batchSize = Math.max(1, Number(run.settings.laneBatchSize) || 10);
    const batches = [];
    for (let index = 0; index < candidates.length; index += batchSize) {
      batches.push(candidates.slice(index, index + batchSize));
    }
    const { paused, outcomes } = await wave(run, batches, async (batch, index) => {
      const batchPath = run.artifact(`codeverify/input-${index}.json`);
      const artifact = run.artifact(`codeverify/result-${index}.json`);
      await run.write(`codeverify/input-${index}.json`, { candidates: batch });
      const prompt = buildCodeVerifyPrompt({
        project: run.project,
        sourceDir: run.srcDir,
        batchPath,
        artifactPath: artifact,
        candidates: batch,
        extra: run.settings.auditPromptExtra,
      });
      const result = await run.lane({
        stage: 'codeverify',
        key: `batch-${index}`,
        label: `代码级验证·批${index + 1}`,
        prompt,
        artifactPath: artifact,
        timeoutMs: run.settings.stageTimeoutMs,
        idleTimeoutMs: run.settings.idleTimeoutMs,
      });
      const validated = validateCodeVerify(result.artifact ?? safeJson(result.text));
      if (validated.ok !== true) {
        return { ok: false, error: validated.problems.join('；') || '产物无法解析', index };
      }
      const known = new Set(batch.map((candidate) => candidate.id));
      for (const row of validated.value.results) {
        if (known.has(row.id)) run.pipeline.codeVerify[row.id] = row;
      }
      await run.write(`codeverify/result-${index}.json`, validated.value);
      return { ok: true, index, count: validated.value.results.length };
    });
    if (paused) return { status: 'paused' };
    const failed = outcomes.filter((outcome) => outcome.ok !== true);
    const verified = Object.values(run.pipeline.codeVerify).filter((row) => row.verified === true).length;
    run.note(`代码级验证完成：${verified}/${candidates.length} 条确认可达`, 'result');
    if (failed.length === batches.length) {
      return { status: 'failed', error: failed.map((row) => truncate(row.error, 160)).join('；') };
    }
    return { status: 'done' };
  }

  /** Step 5: red-team re-rating (downgrade-only). */
  async function regrade(run) {
    const candidates = keptCandidates(run.pipeline);
    if (candidates.length === 0) {
      await finalizeFindings(run);
      return { status: 'skipped', note: '没有候选，跳过二次评级' };
    }
    const batchSize = Math.max(1, Number(run.settings.laneBatchSize) || 10);
    const batches = [];
    for (let index = 0; index < candidates.length; index += batchSize) {
      batches.push(candidates.slice(index, index + batchSize));
    }
    const { paused, outcomes } = await wave(run, batches, async (batch, index) => {
      const batchPath = run.artifact(`regrade/input-${index}.json`);
      const artifact = run.artifact(`regrade/result-${index}.json`);
      await run.write(`regrade/input-${index}.json`, { candidates: batch });
      const prompt = buildRegradePrompt({
        project: run.project,
        sourceDir: run.srcDir,
        batchPath,
        artifactPath: artifact,
        candidates: batch,
        extra: run.settings.auditPromptExtra,
      });
      const result = await run.lane({
        stage: 'regrade',
        key: `batch-${index}`,
        label: `红队二次评级·批${index + 1}`,
        prompt,
        artifactPath: artifact,
        timeoutMs: run.settings.stageTimeoutMs,
        idleTimeoutMs: run.settings.idleTimeoutMs,
      });
      const validated = validateRegrade(result.artifact ?? safeJson(result.text));
      if (validated.ok !== true) {
        return { ok: false, error: validated.problems.join('；') || '产物无法解析', index };
      }
      const byId = new Map(batch.map((candidate) => [candidate.id, candidate]));
      const clampedRows = [];
      for (const row of validated.value.results) {
        const candidate = byId.get(row.id);
        if (candidate === undefined) continue;
        const clamped = clampRegradeSeverity(candidate.severity, row.severity);
        const clampedRow = clamped !== row.severity
          ? { ...row, severity: clamped, reason: `${row.reason}（评级只允许降级或维持，已保留原级别）` }
          : row;
        run.pipeline.regrade[row.id] = clampedRow;
        clampedRows.push(clampedRow);
      }
      await run.write(`regrade/result-${index}.json`, { results: clampedRows });
      return { ok: true, index, count: validated.value.results.length };
    });
    if (paused) return { status: 'paused' };
    const failed = outcomes.filter((outcome) => outcome.ok !== true);
    await finalizeFindings(run);
    run.note(`二次评级完成：${Object.keys(run.pipeline.regrade).length}/${candidates.length} 条`, 'result');
    if (failed.length === batches.length) {
      return { status: 'failed', error: failed.map((row) => truncate(row.error, 160)).join('；') };
    }
    return { status: 'done' };
  }

  async function finalizeFindings(run) {
    const findings = deriveFindings(run.pipeline, run.project);
    const { counts, verifiedCount } = summarizeFindings(findings);
    run.project.counts = counts;
    run.project.verifiedCount = verifiedCount;
    run.store.replaceFindings(run.project.id, findings);
    await run.write('findings-snapshot.json', findings);
    run.note(`漏洞汇总：严重 ${counts.critical} / 高危 ${counts.high} / 中危 ${counts.medium} / 低危 ${counts.low} / 提示 ${counts.info}`, 'result');
  }

  return { dispatch, audit, dedupe, codeverify, regrade, finalizeFindings };
}

function safeJson(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export const AUDIT_STAGE_ORDER = ['dispatch', 'audit', 'dedupe', 'codeverify', 'regrade'];
export { nowIso };
