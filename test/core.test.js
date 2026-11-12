/**
 * Unit tests for the pure Host modules.
 *
 * Run with: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig } from '../lib/config.js';
import { detectLanguage, languageForFile } from '../lib/detect.js';
import { computeFrontendRce, isExecutionClass } from '../lib/pipeline.js';
import { DEFAULT_SETTINGS, SEVERITY_LABEL } from '../lib/constants.js';
import { buildFlow, projectSummary, statusText } from '../lib/flow.js';
import { compareVersions, normalizeRepoUrl, parseTagListing, repoName } from '../lib/ingest/github.js';
import { parseZipListing, unsafeEntryReason } from '../lib/ingest/zip.js';
import {
  clampRegradeSeverity,
  mechanicalDedupe,
  normalizeAuth,
  normalizeSeverity,
  validateAuditLane,
  validateChain,
  validateCodeVerify,
  validateDedupe,
  validateEnv,
  validateHistory,
  validatePlan,
  validateRegrade,
  validateRemote,
} from '../lib/validate.js';
import { extractJson, parseModelOverride, redactSecrets, truncate } from '../lib/util.js';
import { renderHtmlReport, renderMarkdownReport } from '../lib/report.js';

function project(overrides = {}) {
  return {
    id: 'p-test',
    name: 'demo',
    language: 'php',
    sourceType: 'zip',
    sourceRef: '/tmp/source.zip',
    sourceVersion: null,
    options: { runtime: 'full', aiDedup: true, aiRegrade: true, verifyHistory: false },
    stageStatus: {
      dispatch: 'done', audit: 'running', dedupe: 'pending', codeverify: 'pending',
      regrade: 'pending', done: 'pending', vdispatch: 'pending', env: 'pending',
      remote: 'pending', chain: 'pending', vdone: 'pending', history: 'pending',
    },
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    verifiedCount: 0,
    frontendRce: false,
    status: 'running',
    verifyStatus: 'none',
    envStatus: 'none',
    prepareState: 'ready',
    hasWeb: true,
    createdAt: 1,
    ...overrides,
  };
}

test('config clamps and warns', () => {
  const { config, warnings } = resolveConfig({ maxConcurrentAudit: 99, laneConcurrency: 99, unknownKey: 1, enabled: 'yes' });
  assert.equal(config.maxConcurrentAudit, 10);
  assert.equal(config.laneConcurrency, 8);
  assert.equal(config.enabled, true);
  assert.ok(warnings.some((warning) => warning.includes('maxConcurrentAudit')));
  assert.ok(warnings.some((warning) => warning.includes('unknownKey')));
  assert.ok(warnings.some((warning) => warning.includes('enabled')));
  assert.equal(DEFAULT_SETTINGS.maxConcurrentAudit, 5);
});

test('flow exposes the six audit steps and five verification steps', () => {
  const flow = buildFlow(project());
  assert.equal(flow.audit.nodes.length, 6);
  assert.equal(flow.verify.nodes.length, 5);
  assert.equal(flow.caption, '审计阶段 · 2/6');
  assert.equal(flow.stepName, '多智能体审计');
  assert.equal(flow.audit.nodes[0].status, 'done');
  assert.equal(flow.audit.nodes[1].status, 'running');
  assert.equal(flow.audit.nodes[2].status, 'pending');
  assert.equal(flow.verify.enabled, true);
});

test('flow marks a code-only project as audit-complete without verification', () => {
  const flow = buildFlow(project({
    options: { runtime: 'none', aiDedup: true, aiRegrade: true, verifyHistory: false },
    status: 'completed',
    stageStatus: { ...project().stageStatus, audit: 'done', dedupe: 'skipped', codeverify: 'done', regrade: 'done', done: 'done' },
  }));
  assert.equal(flow.verify.enabled, false);
  assert.equal(flow.verify.nodes[0].status, 'skipped');
  assert.equal(flow.caption, '审计完成（不验证）');
  assert.equal(flow.progress, 100);
});

test('status copy follows the guide', () => {
  assert.equal(statusText(project({ status: 'queued' })), '审计排队中');
  assert.equal(statusText(project({ status: 'completed', verifyStatus: 'queued' })), '验证排队中');
  assert.equal(statusText(project({ status: 'completed', verifyStatus: 'running' })), '靶机验证中');
  assert.equal(statusText(project({ status: 'completed', verifyStatus: 'completed' })), '全部完成');
  assert.equal(statusText(project({ status: 'failed' })), '审计失败');
});

test('project summary keeps the flow and counts', () => {
  const summary = projectSummary(project({ counts: { critical: 1, high: 2, medium: 0, low: 0, info: 3 } }));
  assert.equal(summary.flow.audit.nodes.length, 6);
  assert.equal(summary.counts.critical, 1);
  assert.equal(summary.reportReady, false);
});

test('JSON extraction tolerates prose and fences', () => {
  assert.deepEqual(extractJson('好的，结果如下：\n```json\n{"ok":true,"lanes":[]}\n```\n完'), { ok: true, lanes: [] });
  assert.deepEqual(extractJson('前缀 {"a":{"b":1}} 后缀'), { a: { b: 1 } });
  assert.equal(extractJson('没有对象'), undefined);
});

test('secret redaction masks credentials', () => {
  const text = redactSecrets('api_key=sk-abcdefghijklmnop token=Bearer abcdefghijklmnop');
  assert.ok(!text.includes('sk-abcdefghijklmnop'));
  assert.ok(text.includes('[REDACTED]'));
});

test('truncate keeps a marker', () => {
  const value = truncate('x'.repeat(30), 10);
  assert.ok(value.startsWith('x'.repeat(10)));
  assert.ok(value.includes('more chars'));
});

test('model override parsing', () => {
  assert.deepEqual(parseModelOverride('deepseek-official:deepseek-flash-cyber'), { provider: 'deepseek-official', model: 'deepseek-flash-cyber' });
  assert.equal(parseModelOverride('nonsense'), undefined);
  assert.equal(parseModelOverride(''), undefined);
});

test('severity and auth normalization', () => {
  assert.equal(normalizeSeverity('严重'), 'critical');
  assert.equal(normalizeSeverity('HIGH'), 'high');
  assert.equal(normalizeSeverity('unknown'), 'medium');
  assert.equal(normalizeAuth('无需登录'), 'none');
  assert.equal(normalizeAuth('admin'), 'admin');
});

test('plan validation caps lanes at four and fills seedFiles', () => {
  const validated = validatePlan({ lanes: Array.from({ length: 6 }, (_, index) => ({ key: 'cmd', label: `L${index}` })) }, 'php');
  assert.equal(validated.ok, true);
  assert.equal(validated.value.lanes.length, 4);
  assert.deepEqual(validated.value.lanes[0].seedFiles, []);
  const fallback = validatePlan({}, 'php');
  assert.equal(fallback.value.lanes.length, 4);
  assert.ok(Array.isArray(fallback.value.lanes[0].seedFiles));
});

test('audit lane validation drops rows without a file', () => {
  const lane = { key: 'cmd', label: '命令执行', focus: '' };
  const validated = validateAuditLane({ candidates: [
    { title: 'A', file: 'a.php', line: 3, severity: 'high' },
    { title: 'no-file', severity: 'high' },
  ] }, lane);
  assert.equal(validated.ok, true);
  assert.equal(validated.value.candidates.length, 1);
  assert.equal(validated.value.candidates[0].id, 'cmd-1');
  assert.equal(validated.value.candidates[0].sourceLane, 'cmd');
});

test('mechanical dedupe merges same file/line and keeps the richer row', () => {
  const base = { file: 'a.php', line: 10, category: '命令执行', title: '命令注入', severity: 'high', taintChain: 'short', codeSnippet: 'x', description: 'd', recommendation: 'r', id: 'cmd-1' };
  const duplicate = { ...base, id: 'cmd-2', severity: 'critical', taintChain: 'a much longer taint chain', codeSnippet: 'xx' };
  const result = mechanicalDedupe([base, duplicate]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.removed.length, 1);
  assert.equal(result.kept[0].severity, 'critical');
  assert.ok(result.kept[0].taintChain.includes('longer'));
});

test('dedupe result validation keeps clusters', () => {
  const validated = validateDedupe({
    removed: [{ id: 'cmd-1', reason: '同一点', mergedInto: 'cmd-2' }],
    clusters: [{ clusterId: 'c1', candidateIds: ['cmd-2', 'auth-1'], note: '不同利用面' }],
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.value.removed[0].id, 'cmd-1');
  assert.equal(validated.value.clusters[0].candidateIds.length, 2);
});

test('code verification and re-rating validation', () => {
  const code = validateCodeVerify({ results: [{ id: 'cmd-1', verified: true, reason: '可达', evidence: { file: 'a.php', line: 10, snippet: 'x' } }] });
  assert.equal(code.ok, true);
  const regrade = validateRegrade({ results: [{ id: 'cmd-1', severity: 'low', value: '低', title: 'T', category: 'C', reason: 'R' }] });
  assert.equal(regrade.value.results[0].severity, 'low');
  assert.equal(clampRegradeSeverity('low', 'critical'), 'low');
  assert.equal(clampRegradeSeverity('critical', 'medium'), 'medium');
});

test('remote verification refuses success without evidence', () => {
  const missing = validateRemote({ verified: true, reason: 'claimed' }, 'cmd-1');
  assert.equal(missing.value.verified, false);
  const withEvidence = validateRemote({
    verified: true,
    reason: 'ok',
    evidence: { request: 'GET /run?cmd=id HTTP/1.1', response: 'uid=0', authRequired: 'none' },
  }, 'cmd-1');
  assert.equal(withEvidence.value.verified, true);
});

test('env and chain validation', () => {
  const env = validateEnv({ mode: 'compose', targetUrl: 'http://127.0.0.1:18080' });
  assert.equal(env.ok, true);
  assert.equal(env.value.mode, 'compose');
  const chain = validateChain({ chains: [{ title: '链', findingIds: ['a', 'b'], steps: ['1', '2'], verified: true }] });
  assert.equal(chain.value.chains.length, 1);
  const history = validateHistory({ results: [{ version: 'v1', verified: true, evidence: 'x' }] });
  assert.equal(history.value.results.length, 1);
});

test('zip listing rejects traversal and absolute paths', () => {
  assert.ok(unsafeEntryReason('../evil').length > 0);
  assert.ok(unsafeEntryReason('/etc/passwd').length > 0);
  assert.ok(unsafeEntryReason('C:/windows').length > 0);
  assert.equal(unsafeEntryReason('src/app.js'), '');
  const parsed = parseZipListing('src/app.js\n__MACOSX/x\n../evil\n/abs\nsrc/app.js', 10);
  assert.equal(parsed.names.filter((name) => name === 'src/app.js').length, 2);
  assert.equal(parsed.problems.length, 2);
});

test('git helpers parse tags and versions', () => {
  const listing = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1.2.0',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v1.10.0',
    'cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v1.3.0',
  ].join('\n');
  const tags = parseTagListing(listing);
  assert.deepEqual(tags.map((tag) => tag.name), ['v1.10.0', 'v1.3.0', 'v1.2.0']);
  assert.ok(compareVersions('v2.0.0', 'v1.9.9') < 0);
  assert.equal(repoName('https://github.com/org/repo.git'), 'repo');
  assert.equal(normalizeRepoUrl('https://github.com/org/repo.git'), 'https://github.com/org/repo.git');
  assert.throws(() => normalizeRepoUrl('not-a-url'));
});

test('report escapes text and uses fixed hazard colors', () => {
  const html = renderHtmlReport({
    project: project({ status: 'completed' }),
    findings: [{
      id: 'cmd-1', title: '<b>XSS</b>', severity: 'critical', severityOriginal: 'high',
      category: '命令执行', file: 'a.php', line: 1, description: '<script>alert(1)</script>',
      recommendation: 'fix', codeSnippet: 'exec($x)', taintChain: 'source → sink', entry: 'GET /run',
      authRequired: 'none', verified: true, codeVerified: true,
      evidence: { request: 'GET /run?cmd=id', response: 'uid=1' }, regradeReason: 'reason',
    }],
    pipeline: { chains: [] },
  });
  assert.ok(html.includes('&lt;b&gt;XSS&lt;/b&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('#c64545'));
  assert.ok(html.includes('命令执行'));
  const md = renderMarkdownReport({ project: project({ status: 'completed' }), findings: [], pipeline: null });
  assert.ok(md.includes('# 代码审计报告'));
  assert.ok(md.includes(SEVERITY_LABEL.critical));
});


test('language detection maps extensions and ignores vendor trees', async () => {
  assert.equal(languageForFile('a.php'), 'php');
  assert.equal(languageForFile('a.tsx'), 'jsts');
  assert.equal(languageForFile('a.cpp'), 'cpp');
  assert.equal(languageForFile('README.md'), undefined);
  const root = await mkdtemp(path.join(os.tmpdir(), 'cau-detect-'));
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.php'), '<?php echo 1;');
    await writeFile(path.join(root, 'src', 'admin.php'), '<?php echo 2;');
    await writeFile(path.join(root, 'src', 'app.js'), 'console.log(1)');
    await writeFile(path.join(root, 'node_modules', 'x', 'index.js'), 'module.exports=1');
    const result = await detectLanguage(root);
    assert.equal(result.language, 'php');
    assert.ok(result.scores.php > result.scores.jsts);
    assert.equal(result.sampled, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('front-end RCE ignores code-only findings filed under 命令执行', () => {
  const localRead = {
    category: '命令执行',
    title: 'ImageMagick @file 语义导致本地文件读取（IM 命令参数注入，锁定版本不成立）',
    severity: 'info',
    verified: true,
    authRequired: 'none',
  };
  assert.equal(isExecutionClass(localRead), false);
  assert.equal(computeFrontendRce([localRead], {}), false);

  const realRce = {
    category: '命令执行',
    title: '未认证远程命令执行：cmd 参数直接进入 execSync（RCE）',
    severity: 'critical',
    verified: true,
    authRequired: 'none',
  };
  assert.equal(isExecutionClass(realRce), true);
  assert.equal(computeFrontendRce([realRce], {}), true);
});
