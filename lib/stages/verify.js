/**
 * The verification lane: dispatcher → environment → remote → combo chain.
 */
import {
  buildChainPrompt,
  buildEnvPrompt,
  buildHistoryPrompt,
  buildRemotePrompt,
  buildVerifyDispatchPrompt,
} from '../prompts/verify.js';
import { validateChain, validateEnv, validateHistory, validateRemote } from '../validate.js';
import {
  computeFrontendRce,
  deriveFindings,
  summarizeFindings,
} from '../pipeline.js';
import { truncate } from '../util.js';

async function wave(run, items, build) {
  const concurrency = Math.max(1, Math.min(Number(run.settings.laneConcurrency) || 8, 8));
  const outcomes = [];
  for (let index = 0; index < items.length; index += concurrency) {
    if (run.paused) return { paused: true, outcomes };
    const slice = items.slice(index, index + concurrency);
    const settled = await Promise.all(slice.map((item) => build(item)));
    outcomes.push(...settled);
    if (run.paused) return { paused: true, outcomes };
  }
  return { paused: false, outcomes };
}

function pickPort(projectId) {
  let hash = 0;
  for (const char of String(projectId)) hash = (hash * 31 + char.codePointAt(0)) % 100;
  return 18080 + hash;
}

export function createVerifyStages() {
  async function vdispatch(run) {
    const artifact = run.artifact('vdispatch/plan.json');
    const earlier = run.pipeline.env;
    if (earlier !== null && earlier !== undefined) {
      run.note('环境已预搭建，跳过验证调度');
      return { status: 'skipped', note: '复用预搭建环境' };
    }
    const findings = (run.pipeline.findings ?? []).filter((finding) => finding.codeVerified === true);
    const prompt = buildVerifyDispatchPrompt({
      project: run.project,
      sourceDir: run.srcDir,
      artifactPath: artifact,
      findings,
      extra: run.settings.verifyPromptExtra,
    });
    const result = await run.lane({
      stage: 'vdispatch',
      key: 'vdispatch',
      label: '主智能体调度（靶机）',
      prompt,
      artifactPath: artifact,
      timeoutMs: run.settings.stageTimeoutMs,
      idleTimeoutMs: run.settings.idleTimeoutMs,
    });
    const plan = result.artifact ?? safeJson(result.text) ?? {
      mode: 'sandbox',
      targetPort: pickPort(run.project.id),
      strategy: '调度失败，按沙箱模式验证',
      findingsToVerify: findings.map((finding) => finding.id),
      notes: truncate(result.error ?? '', 400),
    };
    run.pipeline.verifyPlan = plan;
    await run.write('vdispatch/plan.json', plan);
    if (typeof plan.hasWeb === 'boolean') run.project.hasWeb = plan.hasWeb;
    if (typeof plan.regDefaultOpen === 'boolean') run.project.regDefaultOpen = plan.regDefaultOpen;
    run.note(`验证调度完成：${plan.mode === 'compose' ? '完整靶机' : '沙箱目录'}模式`);
    return { status: 'done' };
  }

  async function env(run) {
    if (run.pipeline.env !== null && run.pipeline.env !== undefined) {
      run.note('复用已有的靶机环境');
      return { status: 'done' };
    }
    const plan = run.pipeline.verifyPlan ?? null;
    const port = Number(plan?.targetPort) || pickPort(run.project.id);
    const artifact = run.artifact('env/result.json');
    run.project.envStatus = 'building';
    const prompt = buildEnvPrompt({
      project: run.project,
      sourceDir: run.srcDir,
      artifactPath: artifact,
      port,
      plan,
      extra: run.settings.verifyPromptExtra,
    });
    const result = await run.lane({
      stage: 'env',
      key: 'env',
      label: '靶机环境搭建',
      prompt,
      artifactPath: artifact,
      timeoutMs: run.settings.stageTimeoutMs,
      idleTimeoutMs: run.settings.idleTimeoutMs,
    });
    const validated = validateEnv(result.artifact ?? safeJson(result.text));
    if (validated.ok !== true) {
      run.project.envStatus = 'failed';
      return { status: 'failed', error: validated.problems.join('；') || '环境产物无法解析' };
    }
    const value = validated.value;
    run.pipeline.env = value;
    await run.write('env/result.json', value);
    if (typeof value.hasWeb === 'boolean') run.project.hasWeb = value.hasWeb;
    if (typeof value.regDefaultOpen === 'boolean') run.project.regDefaultOpen = value.regDefaultOpen;
    if (value.mode === 'compose' && value.targetUrl.length > 0) {
      run.project.envStatus = 'ready';
      run.project.targetUrl = value.targetUrl;
      run.project.composeProject = value.composeProject || `codeaudit-${run.project.id}`;
      run.note(`靶机已就绪：${value.targetUrl}`, 'result');
    } else {
      run.project.envStatus = 'ready';
      run.project.targetUrl = null;
      run.note('靶机以沙箱目录模式运行（无 HTTP 入口）', 'result');
    }
    for (const problem of value.problems ?? []) run.note(`环境提示：${problem}`);
    return { status: 'done' };
  }

  async function remote(run) {
    const findings = (run.pipeline.findings ?? []).filter((finding) => finding.codeVerified === true);
    if (findings.length === 0) {
      run.note('没有通过代码级验证的漏洞，跳过远程验证');
      return { status: 'skipped', note: '没有可远程验证的漏洞' };
    }
    const targetUrl = run.project.targetUrl ?? '';
    const mode = run.pipeline.env?.mode ?? 'sandbox';
    const { paused, outcomes } = await wave(run, findings, async (finding) => {
      const artifact = run.artifact(`remote/result-${safeId(finding.id)}.json`);
      await run.write(`remote/input-${safeId(finding.id)}.json`, { finding });
      const prompt = buildRemotePrompt({
        project: run.project,
        sourceDir: run.srcDir,
        artifactPath: artifact,
        finding,
        targetUrl,
        mode,
        extra: run.settings.verifyPromptExtra,
      });
      const result = await run.lane({
        stage: 'remote',
        key: finding.id,
        label: `远程验证·${truncate(finding.title, 40)}`,
        prompt,
        artifactPath: artifact,
        timeoutMs: run.settings.verifyTimeoutMs,
        idleTimeoutMs: run.settings.verifyIdleTimeoutMs,
      });
      const validated = validateRemote(result.artifact ?? safeJson(result.text), finding.id);
      if (validated.ok !== true) {
        return { ok: false, finding, error: validated.problems.join('；') || '产物无法解析' };
      }
      run.pipeline.remote[finding.id] = validated.value;
      await run.write(`remote/result-${safeId(finding.id)}.json`, validated.value);
      for (const problem of validated.problems) run.note(`${finding.title}：${problem}`);
      return { ok: true, finding, verified: validated.value.verified === true };
    });
    if (paused) return { status: 'paused' };
    const verified = findings.filter((finding) => run.pipeline.remote[finding.id]?.verified === true).length;
    await finalize(run);
    run.note(`远程验证完成：${verified}/${findings.length} 条在靶机上证实`, 'result');
    const failed = outcomes.filter((outcome) => outcome.ok !== true);
    if (failed.length === findings.length) {
      return { status: 'failed', error: failed.map((row) => truncate(row.error, 160)).join('；') };
    }
    return { status: 'done' };
  }

  async function chain(run) {
    const verified = (run.pipeline.findings ?? []).filter((finding) => finding.verified === true);
    if (verified.length < 2) {
      run.note('已验证漏洞少于 2 条，跳过组合验证');
      return { status: 'skipped', note: '可组合的已验证漏洞不足' };
    }
    const artifact = run.artifact('chain/result.json');
    const prompt = buildChainPrompt({
      project: run.project,
      sourceDir: run.srcDir,
      artifactPath: artifact,
      findings: verified,
      targetUrl: run.project.targetUrl ?? '',
      extra: run.settings.verifyPromptExtra,
    });
    const result = await run.lane({
      stage: 'chain',
      key: 'chain',
      label: '组合验证',
      prompt,
      artifactPath: artifact,
      timeoutMs: run.settings.stageTimeoutMs,
      idleTimeoutMs: run.settings.idleTimeoutMs,
    });
    const validated = validateChain(result.artifact ?? safeJson(result.text));
    if (validated.ok !== true) {
      return { status: 'failed', error: validated.problems.join('；') || '组合产物无法解析' };
    }
    run.pipeline.chains = validated.value.chains;
    await run.write('chain/result.json', validated.value);
    run.note(`组合验证完成：${validated.value.chains.length} 条利用链`, 'result');
    return { status: 'done' };
  }

  async function history(run) {
    if (run.project.options?.verifyHistory !== true) {
      return { status: 'skipped', note: '未开启历史版本验证' };
    }
    if (run.project.sourceType !== 'github') {
      return { status: 'skipped', note: '仅 GitHub 项目支持历史版本验证' };
    }
    const artifact = run.artifact('history/result.json');
    const prompt = buildHistoryPrompt({
      project: run.project,
      sourceDir: run.srcDir,
      artifactPath: artifact,
      findings: (run.pipeline.findings ?? []).filter((finding) => finding.verified === true),
      versions: (Array.isArray(run.project.remoteTags) ? run.project.remoteTags : [])
        .filter((tag) => tag !== run.project.sourceVersion)
        .slice(0, run.settings.historyMaxVersions ?? 3),
      maxVersions: run.settings.historyMaxVersions ?? 3,
      extra: run.settings.verifyPromptExtra,
    });
    const result = await run.lane({
      stage: 'history',
      key: 'history',
      label: '历史版本验证',
      prompt,
      artifactPath: artifact,
      timeoutMs: run.settings.stageTimeoutMs,
      idleTimeoutMs: run.settings.idleTimeoutMs,
    });
    const validated = validateHistory(result.artifact ?? safeJson(result.text));
    if (validated.ok !== true) return { status: 'failed', error: '历史版本产物无法解析' };
    run.pipeline.history = validated.value.results;
    await run.write('history/result.json', validated.value);
    return { status: 'done' };
  }

  async function finalize(run) {
    const findings = deriveFindings(run.pipeline, run.project);
    const { counts, verifiedCount } = summarizeFindings(findings);
    run.project.counts = counts;
    run.project.verifiedCount = verifiedCount;
    run.project.frontendRce = computeFrontendRce(findings, run.project);
    run.store.replaceFindings(run.project.id, findings);
    await run.write('findings-snapshot.json', findings);
  }

  return { vdispatch, env, remote, chain, history, finalize };
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/gu, '_');
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
