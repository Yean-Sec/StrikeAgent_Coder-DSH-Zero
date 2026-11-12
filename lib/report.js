/**
 * Deterministic HTML / Markdown report writer.
 *
 * Hazard colours are fixed by the guide and never follow the console accent.
 */
import path from 'node:path';

import {
  HAZARD_COLORS,
  SEVERITY_LABEL,
  SEVERITIES,
} from './constants.js';
import { statusText } from './flow.js';
import { escapeHtml, escapeMarkdown, ensureDir, nowIso, atomicWriteFile } from './util.js';

function severityChipHtml(severity) {
  const label = SEVERITY_LABEL[severity] ?? severity;
  const color = HAZARD_COLORS[severity] ?? HAZARD_COLORS.info;
  return `<span class="sev" style="--sev:${color}">${escapeHtml(label)}</span>`;
}

function renderFindingHtml(finding, index) {
  const sev = SEVERITIES.includes(finding.severity) ? finding.severity : 'info';
  const original = finding.severityOriginal !== null && finding.severityOriginal !== undefined
    ? `（原始：${escapeHtml(SEVERITY_LABEL[finding.severityOriginal] ?? finding.severityOriginal)}）`
    : '';
  const verified = finding.verified === true
    ? '<span class="ok">靶机已验证</span>'
    : finding.codeVerified === true
      ? '<span class="partial">代码级已验证</span>'
      : '<span class="muted">仅代码发现</span>';
  return `
  <section class="finding" id="finding-${escapeHtml(finding.id)}">
    <h3><span class="idx">${index + 1}.</span> ${escapeHtml(finding.title)} ${severityChipHtml(sev)}${original}</h3>
    <table class="meta">
      <tr><th>编号</th><td>${escapeHtml(finding.id)}</td><th>类别</th><td>${escapeHtml(finding.category)}</td></tr>
      <tr><th>位置</th><td>${escapeHtml(finding.file)}${finding.line === null ? '' : `:${finding.line}`}</td><th>触发权限</th><td>${escapeHtml(authLabel(finding.authRequired))}</td></tr>
      <tr><th>状态</th><td>${verified}</td><th>实战评级</th><td>${escapeHtml(finding.regradeValue ?? '—')}</td></tr>
    </table>
    <h4>漏洞描述</h4>
    <p>${escapeHtml(finding.description || '（未提供）')}</p>
    ${finding.taintChain ? `<h4>污点链</h4><pre>${escapeHtml(finding.taintChain)}</pre>` : ''}
    ${finding.codeSnippet ? `<h4>关键代码</h4><pre>${escapeHtml(finding.codeSnippet)}</pre>` : ''}
    <h4>修复建议</h4>
    <p>${escapeHtml(finding.recommendation || '（未提供）')}</p>
    ${finding.regradeReason ? `<h4>二次评级理由</h4><p>${escapeHtml(finding.regradeReason)}</p>` : ''}
    ${finding.codeVerifyReason ? `<h4>代码级验证结论</h4><p>${escapeHtml(finding.codeVerifyReason)}</p>` : ''}
    ${finding.evidence?.request ? `<h4>靶机验证证据</h4><pre>${escapeHtml(`请求：\n${finding.evidence.request}\n\n响应：\n${finding.evidence.response ?? ''}`)}</pre>` : ''}
  </section>`;
}

function authLabel(value) {
  if (value === 'none') return '无需登录';
  if (value === 'user') return '普通用户';
  if (value === 'admin') return '管理员';
  return '未知';
}

function stageTable(project) {
  const rows = Object.entries(project.stageStatus ?? {})
    .map(([key, status]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(status)}</td></tr>`)
    .join('');
  return rows.length === 0 ? '<p class="muted">暂无阶段记录</p>' : `<table class="meta"><tr><th>阶段</th><th>状态</th></tr>${rows}</table>`;
}

export function renderHtmlReport({ project, findings, pipeline }) {
  const counts = project.counts ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const chains = Array.isArray(pipeline?.chains) ? pipeline.chains : [];
  const generated = nowIso();
  const findingHtml = findings.length === 0
    ? '<p class="muted">本次审计未确认任何漏洞。</p>'
    : findings.map((finding, index) => renderFindingHtml(finding, index)).join('\n');
  const distribution = SEVERITIES.map((severity) => {
    const color = HAZARD_COLORS[severity];
    const count = counts[severity] ?? 0;
    return `<div class="dist-row"><span class="dist-label" style="color:${color}">${SEVERITY_LABEL[severity]}</span><span class="bar"><i style="width:${Math.min(100, count * 10)}%;background:${color}"></i></span><span class="dist-count">${count}</span></div>`;
  }).join('');
  const chainHtml = chains.length === 0
    ? '<p class="muted">未发现可串联的利用链。</p>'
    : chains.map((chain) => `
      <section class="finding">
        <h3>${escapeHtml(chain.title)} ${chain.verified === true ? '<span class="ok">已验证</span>' : '<span class="muted">未验证</span>'}</h3>
        <p>${escapeHtml((chain.steps ?? []).map((step, index) => `${index + 1}. ${step}`).join('\n'))}</p>
        ${chain.evidence ? `<pre>${escapeHtml(chain.evidence)}</pre>` : ''}
      </section>`).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>代码审计报告 · ${escapeHtml(project.name)}</title>
<style>
  :root { --canvas:#f4f7fc; --ink:#1b2a4a; --body:#4a5a73; --muted:#7d8da3; --primary:#3b82f6; --card:#ffffff; --line:#e3ebf6; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--canvas); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; line-height:1.65; }
  .page { max-width:1080px; margin:0 auto; padding:36px 28px 64px; }
  h1 { font-family:Georgia,"Songti SC",serif; font-size:30px; margin:0 0 6px; }
  h2 { font-family:Georgia,"Songti SC",serif; font-size:20px; margin:36px 0 12px; border-bottom:1px solid var(--line); padding-bottom:8px; }
  h3 { font-size:16px; margin:0 0 10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  h4 { font-size:13px; color:var(--muted); margin:16px 0 4px; font-weight:600; letter-spacing:.04em; }
  p { color:var(--body); margin:0 0 8px; white-space:pre-wrap; }
  pre { background:#f7f9fd; border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow:auto; font-size:12.5px; color:#2b3a55; }
  .sub { color:var(--muted); font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px 22px; box-shadow:0 8px 28px rgba(59,109,180,.06); margin-top:16px; }
  .finding { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin:14px 0; box-shadow:0 6px 20px rgba(59,109,180,.05); }
  table.meta { width:100%; border-collapse:collapse; margin:8px 0 4px; font-size:13px; }
  table.meta th { text-align:left; color:var(--muted); font-weight:500; padding:4px 10px 4px 0; white-space:nowrap; width:90px; }
  table.meta td { color:var(--ink); padding:4px 16px 4px 0; }
  .sev { display:inline-block; padding:1px 9px; border-radius:999px; font-size:12px; color:#fff; background:var(--sev); }
  .ok { color:#2f8f7c; font-size:12px; }
  .partial { color:#b7791f; font-size:12px; }
  .muted { color:var(--muted); }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-top:12px; }
  .stat { background:#f7f9fd; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .stat b { display:block; font-size:22px; font-family:Georgia,serif; }
  .stat span { color:var(--muted); font-size:12px; }
  .dist-row { display:grid; grid-template-columns:56px 1fr 32px; gap:10px; align-items:center; margin:6px 0; }
  .dist-label { font-size:12px; }
  .bar { background:#eef3fb; border-radius:999px; height:8px; overflow:hidden; }
  .bar i { display:block; height:100%; border-radius:999px; min-width:2px; }
  .dist-count { text-align:right; color:var(--muted); font-size:12px; }
  footer { margin-top:40px; color:var(--muted); font-size:12px; text-align:center; }
</style>
</head>
<body>
<div class="page">
  <h1>代码审计报告</h1>
  <div class="sub">${escapeHtml(project.name)} · ${escapeHtml(project.language)} · ${escapeHtml(project.sourceType === 'github' ? 'GitHub' : 'Zip')} · ${escapeHtml(project.sourceVersion ?? '版本未标记')}</div>

  <section class="card">
    <table class="meta">
      <tr><th>来源</th><td>${escapeHtml(project.sourceRef)}</td><th>状态</th><td>${escapeHtml(statusText(project))}</td></tr>
      <tr><th>开始</th><td>${escapeHtml(project.startedAt ?? '—')}</td><th>结束</th><td>${escapeHtml(project.finishedAt ?? '—')}</td></tr>
      <tr><th>验证方式</th><td>${project.options?.runtime === 'full' ? '完整靶机 + 单洞/组合验证' : '仅代码审计'}</td><th>靶机地址</th><td>${escapeHtml(project.targetUrl ?? '—')}</td></tr>
    </table>
    <div class="stats">
      <div class="stat"><b>${findings.length}</b><span>漏洞总数</span></div>
      <div class="stat"><b>${project.verifiedCount ?? 0}</b><span>靶机已验证</span></div>
      <div class="stat"><b>${project.frontendRce === true ? '是' : '否'}</b><span>前台 RCE</span></div>
      <div class="stat"><b>${counts.critical ?? 0}</b><span>严重</span></div>
      <div class="stat"><b>${counts.high ?? 0}</b><span>高危</span></div>
    </div>
    <h4>危害分布</h4>
    ${distribution}
  </section>

  <h2>漏洞明细</h2>
  ${findingHtml}

  <h2>组合利用链</h2>
  ${chainHtml}

  <h2>阶段记录</h2>
  ${stageTable(project)}

  <footer>由 DSH 代码审计控制台生成 · ${escapeHtml(generated)}</footer>
</div>
</body>
</html>`;
}

export function renderMarkdownReport({ project, findings, pipeline }) {
  const lines = [];
  const counts = project.counts ?? {};
  lines.push(`# 代码审计报告 · ${project.name}`);
  lines.push('');
  lines.push(`- 来源：${project.sourceRef}`);
  lines.push(`- 语言：${project.language}`);
  lines.push(`- 版本：${project.sourceVersion ?? '未标记'}`);
  lines.push(`- 状态：${statusText(project)}`);
  lines.push(`- 验证方式：${project.options?.runtime === 'full' ? '完整靶机' : '仅代码审计'}`);
  lines.push(`- 漏洞总数：${findings.length}；靶机已验证：${project.verifiedCount ?? 0}；前台 RCE：${project.frontendRce === true ? '是' : '否'}`);
  lines.push('');
  lines.push('## 危害分布');
  for (const severity of SEVERITIES) lines.push(`- ${SEVERITY_LABEL[severity]}：${counts[severity] ?? 0}`);
  lines.push('');
  lines.push('## 漏洞明细');
  if (findings.length === 0) lines.push('', '本次审计未确认任何漏洞。');
  findings.forEach((finding, index) => {
    lines.push('');
    lines.push(`### ${index + 1}. ${finding.title}（${SEVERITY_LABEL[finding.severity] ?? finding.severity}）`);
    lines.push('');
    lines.push(`- 编号：${finding.id}`);
    lines.push(`- 类别：${finding.category}`);
    lines.push(`- 位置：${finding.file}${finding.line === null ? '' : `:${finding.line}`}`);
    lines.push(`- 触发权限：${authLabel(finding.authRequired)}`);
    lines.push(`- 状态：${finding.verified === true ? '靶机已验证' : finding.codeVerified === true ? '代码级已验证' : '仅代码发现'}`);
    if (finding.severityOriginal !== null && finding.severityOriginal !== undefined) {
      lines.push(`- 原始严重度：${SEVERITY_LABEL[finding.severityOriginal] ?? finding.severityOriginal}`);
    }
    if (finding.regradeReason) lines.push(`- 二次评级理由：${escapeMarkdown(finding.regradeReason)}`);
    lines.push('');
    lines.push('**描述**');
    lines.push('');
    lines.push(finding.description || '（未提供）');
    if (finding.taintChain) {
      lines.push('', '**污点链**', '', '```', finding.taintChain, '```');
    }
    if (finding.codeSnippet) {
      lines.push('', '**关键代码**', '', '```', finding.codeSnippet, '```');
    }
    lines.push('', '**修复建议**', '', finding.recommendation || '（未提供）');
    if (finding.evidence?.request) {
      lines.push('', '**靶机验证证据**', '', '```', `请求：\n${finding.evidence.request}\n\n响应：\n${finding.evidence.response ?? ''}`, '```');
    }
  });
  const chains = Array.isArray(pipeline?.chains) ? pipeline.chains : [];
  if (chains.length > 0) {
    lines.push('', '## 组合利用链');
    for (const chain of chains) {
      lines.push('', `### ${chain.title}${chain.verified === true ? '（已验证）' : '（未验证）'}`);
      chain.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    }
  }
  lines.push('', `_由 DSH 代码审计控制台生成 · ${nowIso()}_`);
  return lines.join('\n');
}

/**
 * Write both report formats.
 * @param {{paths: object, logger?: object}} options
 */
export function createReporter({ paths, logger }) {
  async function generate({ project, findings, pipeline }) {
    const directory = paths.reportsDir(project.id);
    await ensureDir(directory);
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const htmlPath = path.join(directory, `report-${stamp}.html`);
    const mdPath = path.join(directory, `report-${stamp}.md`);
    try {
      await atomicWriteFile(htmlPath, renderHtmlReport({ project, findings, pipeline }));
      await atomicWriteFile(mdPath, renderMarkdownReport({ project, findings, pipeline }));
      const meta = { htmlPath, mdPath, generatedAt: nowIso() };
      project.report = meta;
      return meta;
    } catch (error) {
      logger?.warn?.(`code-audit: report generation failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  return { generate };
}
