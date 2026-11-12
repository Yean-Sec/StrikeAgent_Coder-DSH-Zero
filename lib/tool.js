/**
 * `code_audit` — the model-facing entry point for the console.
 *
 * Every action calls the same `service.js` operation the browser uses, so the
 * agent and the UI can never disagree about a rule.
 */
import { copyFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LANGUAGE_VALUES, SEVERITY_LABEL } from './constants.js';
import { statusText } from './flow.js';
import { nowIso, shortId, truncate } from './util.js';

const ACTIONS = ['create', 'list', 'get', 'control', 'stage', 'report', 'monitor'];

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'create a project, list/get projects, control a run, re-run a stage, generate a report, or manage monitors.',
    },
    sourcePath: { type: 'string', description: 'create: optional absolute path of a directory or .zip. Defaults to the current Session working directory (the workspace the user opened).' },
    uploadId: { type: 'string', description: 'create: id returned by the console upload endpoint.' },
    repoUrl: { type: 'string', description: 'create: git repository URL (https/ssh). The tool previews it first.' },
    previewId: { type: 'string', description: 'create: preview id from the console GitHub preview step.' },
    ref: { type: 'string', description: 'create: tag, branch or commit to audit. Defaults to the newest tag.' },
    name: { type: 'string', description: 'create: optional display name.' },
    language: {
      type: 'string',
      enum: LANGUAGE_VALUES,
      description: 'create: optional language override. By default the Host detects the dominant language from the source tree.',
    },
    options: {
      type: 'object',
      additionalProperties: false,
      description: 'create: per-run flow options.',
      properties: {
        runtime: { type: 'string', enum: ['full', 'none'], description: 'full = build a target machine and verify; none = code audit only.' },
        aiDedup: { type: 'boolean' },
        aiRegrade: { type: 'boolean' },
        verifyHistory: { type: 'boolean' },
      },
    },
    force: { type: 'boolean', description: 'create: allow a duplicate repository/version audit.' },
    projectId: { type: 'string', description: 'get/control/stage/report: project id.' },
    control: {
      type: 'string',
      enum: ['pause', 'resume', 'rerun', 'delete', 'cleanup-env', 'generate-report'],
      description: 'control: lifecycle action.',
    },
    stage: {
      type: 'string',
      enum: ['dispatch', 'audit', 'dedupe', 'codeverify', 'regrade', 'vdispatch', 'env', 'remote', 'chain', 'history'],
      description: 'stage: stage key to re-run.',
    },
    mode: { type: 'string', enum: ['only', 'from'], description: 'stage: rerun only this stage or from it onward (default from).' },
    format: { type: 'string', enum: ['html', 'md'], description: 'report: return this format path.' },
    monitor: {
      type: 'object',
      additionalProperties: true,
      description: 'monitor: { op: "list"|"add"|"check"|"remove"|"update", id?, repoUrl?, projectPrefix?, intervalMin?, enabled?, language?, options? }.',
    },
  },
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'Human-readable result; the model sees exactly this text.' },
    details: { type: 'object', additionalProperties: true },
  },
  required: ['summary'],
};

function line(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

function projectLine(project) {
  const counts = project.counts ?? {};
  const total = (counts.critical ?? 0) + (counts.high ?? 0) + (counts.medium ?? 0) + (counts.low ?? 0) + (counts.info ?? 0);
  return `- ${project.id} · ${project.name} · ${project.language} · ${statusText(project)} · 漏洞 ${total} · 已验证 ${project.verifiedCount ?? 0}`;
}

/**
 * @param {object} options
 */
export function registerAuditTool({ ctx, service, paths, logger }) {
  function getService(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
    } catch {
      return undefined;
    }
  }

  async function resolveSessionCwd(exec) {
    const session = exec?.agent?.session;
    try {
      const workingDirectory = getService('workingDirectory');
      if (workingDirectory !== undefined && exec?.agent !== undefined) {
        if (typeof workingDirectory.ensure === 'function') return await workingDirectory.ensure(exec.agent);
        if (typeof workingDirectory.get === 'function') return workingDirectory.get(session);
      }
    } catch {
      /* fall back to the immutable header cwd */
    }
    return typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
  }

  return ctx.tools.register({
    name: 'code_audit',
    description: [
      'Local code-audit console. When the user asks to audit the current project/repository/source tree, call action=create with NO source arguments: it audits the Session working directory in place and detects the language automatically.',
      'It runs a real multi-agent pipeline (dispatch → multi-agent audit → AI dedupe → code verification → red-team re-rating → optional target-machine verification) on managed child sessions.',
      'Do not ask the user to pick a language or upload a zip for the normal workspace flow. The console panel is available in the session header or sidebar as "代码审计".',
    ].join(' '),
    parameters: PARAMETERS,
    timeoutMs: 10 * 60 * 1000,
    isConcurrencySafe: (args) => args?.action === 'list' || args?.action === 'get',
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => line(value?.summary ?? 'code_audit finished with no summary'),
    },
    async execute(args, exec) {
      const action = ACTIONS.includes(args?.action) ? args.action : undefined;
      if (action === undefined) return { summary: `未知 action；可选：${ACTIONS.join(', ')}` };
      try {
        switch (action) {
          case 'create':
            return await create(args, exec);
          case 'list': {
            const projects = service.listProjects();
            if (projects.length === 0) return { summary: '当前没有审计项目。', details: { projects: [] } };
            return {
              summary: `审计项目 ${projects.length} 个：\n${projects.slice(0, 30).map(projectLine).join('\n')}`,
              details: { projects: projects.slice(0, 30) },
            };
          }
          case 'get': {
            const project = service.getProject(String(args.projectId ?? ''));
            if (project === null) return { summary: '项目不存在。' };
            const findings = project.findings.slice(0, 20).map((finding) => (
              `- ${finding.id} · ${SEVERITY_LABEL[finding.severity] ?? finding.severity} · ${finding.title} · ${finding.file}${finding.line === null ? '' : `:${finding.line}`}${finding.verified === true ? ' · 靶机已验证' : ''}`
            ));
            return {
              summary: [
                projectLine(project),
                `阶段：${project.caption ?? project.flow?.caption ?? ''}`,
                findings.length > 0 ? `漏洞（最多 20 条）：\n${findings.join('\n')}` : '尚未产生漏洞。',
              ].join('\n'),
              details: {
                project: { id: project.id, name: project.name, status: project.status, verifyStatus: project.verifyStatus, counts: project.counts },
                findings: project.findings.slice(0, 20),
              },
            };
          }
          case 'control': {
            const result = await service.controlProject(String(args.projectId ?? ''), String(args.control ?? ''));
            return {
              summary: result.ok === true ? `操作成功：${args.control}` : `操作失败：${result.error ?? '未知原因'}`,
              details: result,
            };
          }
          case 'stage': {
            const result = await service.rerunStage(String(args.projectId ?? ''), String(args.stage ?? ''), args.mode);
            return {
              summary: result.ok === true ? `已排入重跑：${args.stage}` : `重跑失败：${result.error ?? '未知原因'}`,
              details: result,
            };
          }
          case 'report': {
            const project = service.getProject(String(args.projectId ?? ''));
            if (project === null) return { summary: '项目不存在。' };
            const result = await service.controlProject(String(args.projectId ?? ''), 'generate-report');
            if (result.ok !== true) return { summary: `报告生成失败：${result.error ?? '未知原因'}`, details: result };
            const file = args.format === 'md' ? result.report.mdPath : result.report.htmlPath;
            return {
              summary: `报告已生成：${file}\n包含 ${project.findings.length} 条漏洞，靶机已验证 ${project.verifiedCount ?? 0} 条。`,
              details: result.report,
            };
          }
          case 'monitor': {
            return await monitorAction(args, service);
          }
          default:
            return { summary: `未知 action：${action}` };
        }
      } catch (error) {
        logger?.warn?.(`code-audit: tool failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
          summary: `code_audit 执行失败：${truncate(error instanceof Error ? error.message : String(error), 800)}`,
          details: { error: true },
        };
      }
    },
  });

  async function create(args, exec) {
    const sessionId = typeof exec?.agent?.id === 'string' && exec.agent.id.length > 0 ? exec.agent.id : null;
    const options = {
      runtime: args.options?.runtime === 'none' ? 'none' : 'full',
      aiDedup: args.options?.aiDedup !== false,
      aiRegrade: args.options?.aiRegrade !== false,
      verifyHistory: args.options?.verifyHistory === true,
    };
    if (typeof args.sourcePath === 'string' && args.sourcePath.length > 0) {
      const source = path.resolve(args.sourcePath);
      const info = await stat(source);
      if (info.isDirectory()) {
        const result = await service.createProject({
          sourceType: 'workspace',
          sourcePath: source,
          name: args.name,
          language: args.language,
          options,
          sessionId,
          force: args.force === true,
        });
        return createResponse(result);
      }
      if (!source.toLowerCase().endsWith('.zip')) {
        return { summary: 'sourcePath 必须是目录或 .zip 文件' };
      }
      const uploadId = `${Date.now().toString(36)}-${shortId('u')}.zip`;
      const destination = path.join(paths.uploadsDir, uploadId);
      await copyFile(source, destination);
      const metaName = path.basename(source);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(`${destination}.meta.json`, `${JSON.stringify({ name: metaName, bytes: info.size, at: Date.now() }, null, 2)}\n`, 'utf8');
      const result = await service.createProject({
        sourceType: 'zip',
        uploadId,
        name: args.name,
        language: args.language,
        options,
        sessionId,
      });
      return createResponse(result);
    }
    if (typeof args.repoUrl === 'string' && args.repoUrl.length > 0) {
      let previewId = typeof args.previewId === 'string' ? args.previewId : undefined;
      if (previewId === undefined) {
        const preview = await service.previewGithub({ url: args.repoUrl });
        previewId = preview.previewId;
      }
      const result = await service.createProject({
        sourceType: 'github',
        previewId,
        ref: args.ref,
        name: args.name,
        language: args.language,
        options,
        sessionId,
        force: args.force === true,
      });
      return createResponse(result);
    }
    if (typeof args.uploadId === 'string' && args.uploadId.length > 0) {
      const result = await service.createProject({
        sourceType: 'zip',
        uploadId: args.uploadId,
        name: args.name,
        language: args.language,
        options,
        sessionId,
      });
      return createResponse(result);
    }
    // Default: the effective directory of the Session (follows working_directory).
    const cwd = await resolveSessionCwd(exec);
    if (cwd.length === 0) {
      return { summary: '当前会话没有工作目录。请在已打开源码的 DSH 会话里调用，或显式传入 sourcePath。' };
    }
    if (cwd === os.homedir() || cwd === '/' || cwd === path.parse(cwd).root) {
      return { summary: `当前工作目录是 ${cwd}，不是具体源码目录。请先在 DSH 打开要审计的项目文件夹，或显式传入 sourcePath。` };
    }
    const result = await service.createProject({
      sourceType: 'workspace',
      sourcePath: cwd,
      name: args.name,
      language: args.language,
      options,
      sessionId,
      force: args.force === true,
    });
    return createResponse(result);
  }

  function createResponse(result) {
    if (result.ok !== true) {
      return { summary: `创建失败：${result.error ?? '未知原因'}`, details: result };
    }
    const project = result.project;
    const source = project.sourceType === 'workspace'
      ? `工作区 ${project.sourceRef}`
      : project.sourceType === 'github'
        ? project.sourceRef
        : project.archiveName ?? project.sourceRef;
    return {
      summary: `已创建审计项目：${project.name}（${project.id}）\n- 来源：${source}\n- 语言：${project.language ?? '自动识别中'}${result.existing === true ? '（复用已排队的审计）' : ''}\n- 流程：${project.options.runtime === 'full' ? '完整靶机' : '仅代码审计'}${project.options.aiDedup ? ' · AI 去重' : ''}${project.options.aiRegrade ? ' · 二次评级' : ''}\n- 状态：${statusText(project)}\n打开 DSH 顶部或侧栏的「代码审计」查看实时流程。`,
      details: { project, existing: result.existing === true },
    };
  }

  async function monitorAction(args, svc) {
    const monitor = args.monitor ?? {};
    const op = String(monitor.op ?? 'list');
    if (op === 'add') {
      const result = await svc.addMonitor(monitor);
      return { summary: result.ok === true ? `已添加监控：${result.monitor.repoUrl}` : `添加监控失败：${result.error}`, details: result };
    }
    if (op === 'check') {
      const result = await svc.checkMonitor(String(monitor.id ?? ''));
      return { summary: result.ok === true ? (result.triggered ? `发现新版本 ${result.latestTag}，已创建审计` : `无新版本（最新 ${result.latestTag ?? '未知'}）`) : `检查失败：${result.error}`, details: result };
    }
    if (op === 'remove') {
      const result = svc.removeMonitor(String(monitor.id ?? ''));
      return { summary: result.ok === true ? '已删除监控' : `删除失败：${result.error}`, details: result };
    }
    if (op === 'update') {
      const result = svc.updateMonitor(String(monitor.id ?? ''), monitor);
      return { summary: result.ok === true ? '监控已更新' : `更新失败：${result.error}`, details: result };
    }
    const monitors = svc.getMonitors?.() ?? [];
    return { summary: `监控 ${monitors.length} 个：\n${monitors.map((row) => `- ${row.id} · ${row.repoUrl} · 最新 ${row.lastReleaseTag ?? '未知'} · ${row.enabled ? '启用' : '停用'}`).join('\n')}`, details: { monitors } };
  }
}
