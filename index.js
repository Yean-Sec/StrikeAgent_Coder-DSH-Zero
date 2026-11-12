/**
 * Code Audit Console — Host half.
 *
 * One bundle, two halves:
 *  - this Host half owns the persistent project store, the managed-subagent
 *    pipeline, the loopback console API and the `code_audit` tool;
 *  - `client.js` registers the global console panel and its sidebar entry.
 */
import { createApi } from './lib/api.js';
import { createCapture } from './lib/capture.js';
import { resolveConfig } from './lib/config.js';
import { createEventBus } from './lib/events.js';
import { createOrchestrator } from './lib/orchestrator.js';
import { createPaths, resolveDataDir } from './lib/paths.js';
import { createReporter } from './lib/report.js';
import { createRunner } from './lib/runner.js';
import { createAuditService } from './lib/service.js';
import { createStore } from './lib/store.js';
import { registerAuditTool } from './lib/tool.js';
import { TOOL_NAMES } from './lib/constants.js';

export const name = 'code-audit';
export const inject = ['tools'];

const PROMPT_SECTION = `代码审计控制台（会话顶部或侧栏「代码审计」）用于本地源码审计。
当用户说「审计当前项目 / 这个仓库 / 这段源码」时，直接调用 code_audit action=create，不要传 sourcePath：插件默认审计当前会话的工作目录，并自动识别语言。不要要求用户选择语言、上传 Zip 或填写仓库地址。
当用户要求查看审计进度、漏洞或报告时，调用 code_audit action=list/get/report；不要在对话里逐文件人工审计，也不要手工跑流水线。
审计与靶机验证在受管子会话中无人值守执行，过程和证据写回控制台。`;

/**
 * Activate the console.
 * @param {object} ctx Cordis context of the plugin row.
 * @param {object} rawConfig raw `config` mapping from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = resolveConfig(rawConfig);
  const logger = ctx.logger;
  for (const warning of warnings) logger?.warn?.(`code-audit: ${warning}`);
  if (config.enabled === false) {
    logger?.info?.('code-audit: disabled by config');
    return;
  }

  const paths = createPaths(resolveDataDir(config));
  const store = createStore({ paths, logger });
  const events = createEventBus({ paths, logger });
  const capture = createCapture({
    ctx,
    events,
    logger,
    onActivity: ({ projectId, text, phase }) => {
      const project = store.getProject(projectId);
      if (project === undefined) return;
      project.activity = { text, at: new Date().toISOString(), phase };
      store.updateProject(projectId, {});
      events.projectChanged(project);
    },
  });
  // Audit children get a small tool set: they must not manage the console or
  // spawn further agents. The guard is a synchronous second line of defence.
  const CHILD_DENY = ['code_audit', 'working_directory', 'load_workspace_dependencies'];
  function knownGlobalTools() {
    try {
      const definitions = typeof ctx.tools?.definitions === 'function' ? ctx.tools.definitions() : [];
      return new Set((definitions ?? []).map((definition) => definition?.name));
    } catch {
      return new Set();
    }
  }
  const policyStats = { restricted: 0, skipped: 0, failed: 0, guardDenials: 0 };
  const childRestrictions = new Map();
  let disposeAgentListener;
  try {
    disposeAgentListener = ctx.on?.('agent/created', (payload) => {
      const agent = payload?.agent;
      const sessionId = agent?.session?.id;
      if (typeof sessionId !== 'string' || !capture.has(sessionId)) return;
      try {
        const restrict = agent.ctx?.tools?.restrict;
        if (typeof restrict !== 'function') {
          policyStats.skipped += 1;
          logger?.warn?.('code-audit: agent.ctx.tools.restrict is unavailable; child keeps the default toolset');
          return;
        }
        const known = knownGlobalTools();
        const deny = CHILD_DENY.filter((name) => known.has(name));
        if (deny.length === 0) {
          policyStats.skipped += 1;
          return;
        }
        const dispose = restrict.call(agent.ctx.tools, { deny });
        if (typeof dispose === 'function') {
          childRestrictions.set(sessionId, dispose);
          policyStats.restricted += 1;
        } else {
          policyStats.skipped += 1;
        }
      } catch (error) {
        policyStats.failed += 1;
        const projectId = capture.projectOf(sessionId);
        if (projectId !== null) {
          events.push(projectId, { kind: 'error', phase: 'audit', text: `子智能体工具收敛失败：${error instanceof Error ? error.message : String(error)}` });
        }
        logger?.warn?.(`code-audit: cannot restrict child tools: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  } catch (error) {
    logger?.warn?.(`code-audit: cannot listen for agent creation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof ctx.tools?.guard === 'function') {
    try {
      const disposeGuard = ctx.tools.guard((exec) => {
        const sessionId = exec?.agent?.session?.id;
        if (typeof sessionId !== 'string' || !capture.has(sessionId)) return undefined;
        if (exec.name === 'code_audit') {
          policyStats.guardDenials += 1;
          return '审计子智能体不能调用 code_audit；只完成本阶段任务。';
        }
        if (exec.name === 'subagent' || exec.name === 'spawn_teammate' || exec.name === 'workflow') {
          policyStats.guardDenials += 1;
          return '审计子智能体不能再派生子智能体。';
        }
        if (exec.name === 'working_directory') {
          policyStats.guardDenials += 1;
          return '工作目录已固定为源码根，不要切换目录。';
        }
        if (exec.name === 'load_workspace_dependencies') {
          policyStats.guardDenials += 1;
          return '审计子智能体不需要加载工作区依赖。';
        }
        if (exec.name === 'ask_user_question') {
          policyStats.guardDenials += 1;
          return '审计无人值守，不要向用户提问；按保守判断继续。';
        }
        return undefined;
      });
      ctx.effect(() => disposeGuard, 'code-audit: child tool guard');
    } catch (error) {
      logger?.warn?.(`code-audit: cannot install the child tool guard: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  ctx.effect(() => () => {
    try {
      disposeAgentListener?.();
    } catch {
      /* already disposed */
    }
    for (const dispose of childRestrictions.values()) {
      try {
        dispose();
      } catch {
        /* already disposed */
      }
    }
    childRestrictions.clear();
  }, 'code-audit: child tool policy');

  const runner = createRunner({
    ctx,
    config,
    settings: () => ({ ...config, ...(store.settingsLoaded ? store.getSettings() : {}) }),
    capture,
    events,
    logger,
  });
  const reporter = createReporter({ paths, logger });
  const orchestrator = createOrchestrator({
    ctx,
    config,
    store,
    events,
    runner,
    reporter,
    paths,
    policyStats,
    logger,
  });
  const service = createAuditService({
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
  });

  const ready = (async () => {
    await store.init();
    service.repairFrontendRce();
    await service.pruneUploads();
    orchestrator.start();
  })().catch((error) => {
    logger?.error?.(`code-audit: initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  // Loopback HTTP surface.
  const mountApi = (webCtx) => {
    const webServer = webCtx.webServer ?? (() => {
      try {
        return webCtx.get('webServer');
      } catch {
        return undefined;
      }
    })();
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      logger?.warn?.('code-audit: webServer is unavailable; the console panel will have no data API');
      return;
    }
    const api = createApi({
      ctx,
      config,
      service,
      store,
      events,
      paths,
      whenReady: () => ready,
      logger,
    });
    const dispose = api.mount(webServer);
    webCtx.effect(() => dispose, 'code-audit: console routes');
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mountApi);
  } else {
    mountApi(ctx);
  }

  // Model-facing tool.
  try {
    registerAuditTool({ ctx, service, paths, logger });
  } catch (error) {
    logger?.warn?.(`code-audit: cannot register ${TOOL_NAMES.audit}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (config.promptSection !== false) {
    try {
      ctx.systemPrompt?.section?.({
        name: 'code-audit:console',
        order: 2600,
        text: PROMPT_SECTION,
      });
    } catch (error) {
      logger?.warn?.(`code-audit: cannot add the prompt section: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Monitor checks run on a slow timer.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void service.checkDueMonitors().catch((error) => logger?.warn?.(`code-audit: monitor check failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 60000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'code-audit: monitor timer');

  ctx.effect(() => () => {
    try {
      void orchestrator.stop().catch((error) => logger?.warn?.(`code-audit: stop failed: ${error instanceof Error ? error.message : String(error)}`));
    } catch {
      /* best effort */
    }
    try {
      capture.dispose();
    } catch {
      /* best effort */
    }
    try {
      void runner.dispose().catch((error) => logger?.warn?.(`code-audit: runner dispose failed: ${error instanceof Error ? error.message : String(error)}`));
    } catch {
      /* best effort */
    }
    try {
      void store.close().catch((error) => logger?.warn?.(`code-audit: store close failed: ${error instanceof Error ? error.message : String(error)}`));
    } catch {
      /* best effort */
    }
  }, 'code-audit: console cleanup');

  logger?.info?.(`code-audit: activated (${paths.root})`);
}
