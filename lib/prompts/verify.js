/**
 * Prompt builders for the target-machine lane (the five verification steps).
 */
import {
  CWD_RULE,
  JSON_ONLY_RULE,
  NO_QUESTION_RULE,
  NO_CONSOLE_RULE,
  SECRET_RULE,
  SOURCE_TRUST_RULE,
  TOOL_RULE,
  artifactRule,
  authRule,
  candidateSummary,
  outputRule,
  stageHeader,
} from './common.js';

const DISPATCH_SCHEMA = `{
  "mode": "compose|sandbox",
  "targetPort": 18080,
  "strategy": "如何把项目跑起来（复用现有 compose、生成 Dockerfile、或沙箱目录）",
  "hasWeb": true,
  "regDefaultOpen": null,
  "findingsToVerify": ["vuln-1"],
  "notes": "风险与限制"
}`;

const ENV_SCHEMA = `{
  "mode": "compose|sandbox",
  "targetUrl": "http://127.0.0.1:18080",
  "composeProject": "codeaudit-p-xxxx",
  "hasWeb": true,
  "regDefaultOpen": true,
  "notes": "启动方式、端口、失败原因"
}`;

const REMOTE_SCHEMA = `{
  "id": "vuln-1",
  "verified": true,
  "reason": "如何证明可利用",
  "evidence": {
    "request": "原始 HTTP 请求或命令（可截断）",
    "response": "关键响应内容（可截断）",
    "artifact": "证据文件路径（可选）",
    "authRequired": "none|user|admin",
    "authReason": "权限判断依据"
  }
}`;

const CHAIN_SCHEMA = `{
  "chains": [
    {
      "id": "chain-1",
      "title": "中文组合链标题",
      "findingIds": ["vuln-1", "vuln-2"],
      "steps": ["第一步", "第二步", "第三步"],
      "verified": true,
      "evidence": "关键请求/响应摘要"
    }
  ]
}`;

const HISTORY_SCHEMA = `{
  "results": [
    { "version": "v1.2.3", "verified": true, "evidence": "用已发现漏洞打该版本的证据摘要" }
  ]
}`;

/** Verification-track dispatcher. */
export function buildVerifyDispatchPrompt({ project, sourceDir, artifactPath, findings, extra }) {
  return [
    stageHeader({ project, stage: '主智能体调度（靶机）' }),
    CWD_RULE(sourceDir),
    `你的任务：为靶机验证做计划，不要开始挖掘新漏洞。判断项目类型和启动方式：优先复用仓库里的 docker-compose / Dockerfile；没有就评估能否生成一个最小 Dockerfile；纯非 Web（CLI/库/合约）则走沙箱目录模式。`,
    `已通过代码级验证的漏洞：\n${candidateSummary(findings)}`,
    `为每个漏洞给出建议的验证方式（HTTP 路径、参数、命令），并判断注册功能是否默认开放。不要执行破坏性操作。`,
    SOURCE_TRUST_RULE,
    TOOL_RULE,
    SECRET_RULE,
    NO_QUESTION_RULE,
    NO_CONSOLE_RULE,
    artifactRule(artifactPath),
    outputRule(DISPATCH_SCHEMA),
    JSON_ONLY_RULE,
    extra,
  ].filter(Boolean).join('\n\n');
}

/** Build and start the target environment. */
export function buildEnvPrompt({ project, sourceDir, artifactPath, port, plan, extra }) {
  return [
    stageHeader({ project, stage: '靶机环境搭建' }),
    CWD_RULE(sourceDir),
    `调度计划：${plan?.strategy ?? '未给出'}`,
    `把项目在本地跑起来。要求：`,
    `- 若仓库有 compose 文件，用 docker compose -f <file> -p codeaudit-${project.id} up -d --build；否则在 .codeaudit/env/ 下生成最小 compose/Dockerfile，build context 指向源码根。`,
    `- 不要手动 docker pull 或指定私有镜像源；直接 compose up --build，让 Docker 只在缺镜像时拉取。优先使用本机已有镜像；拉取失败时改用本机镜像或 sandbox 模式，并在 notes 写明原因。`,
    `- 宿主机端口优先用 ${port}；被占用就依次尝试后续端口并记录。`,
    `- 启动后用 curl/HTTP 探测直到返回 2xx/3xx（最多 5 分钟）。`,
    `- 若项目不是 Web（没有 HTTP 入口、或依赖无法在容器内满足），把 mode 设为 sandbox，不要伪造 targetUrl；在 notes 写明原因。`,
    `- 不要修改源码；生成的文件只能放在 .codeaudit/ 下。不要执行破坏性命令。`,
    SOURCE_TRUST_RULE,
    SECRET_RULE,
    NO_QUESTION_RULE,
    NO_CONSOLE_RULE,
    artifactRule(artifactPath),
    outputRule(ENV_SCHEMA),
    JSON_ONLY_RULE,
    extra,
  ].filter(Boolean).join('\n\n');
}

/**
 * Verify one finding against the running target.
 * @param {object} input
 */
export function buildRemotePrompt({ project, sourceDir, artifactPath, finding, targetUrl, mode, extra }) {
  const runtime = mode === 'sandbox'
    ? `该项目走沙箱目录模式，没有 HTTP 靶机。请在 .codeaudit/runs 下写一个最小 PoC（脚本/单元测试）并运行它，证明漏洞可达；证据里记录命令和输出。`
    : `靶机地址：${targetUrl}。用 curl（或等价 HTTP 客户端）对当前版本做真实利用。`;
  return [
    stageHeader({ project, stage: '远程验证', lane: { label: finding.title } }),
    CWD_RULE(sourceDir),
    runtime,
    `要验证的漏洞：\n${candidateSummary([finding])}`,
    `规则：`,
    `- 只做只读、无害的证明：id、whoami、echo <随机串>、读取无害文件、数据库版本/SELECT 1。不要删文件、不要写 webshell、不要做拒绝服务、不要持久化。`,
    `- 每条结论必须附原始请求与关键响应；没有证据不要写 verified: true。`,
    `- 需要登录时：如果注册默认开放，可以只注册一个普通账号（密码用随机串），并在证据里写明；需要管理员而拿不到时写 verified: false 并说明原因。`,
    `- 认证尝试要克制，最多 5 次，避免锁定。`,
    authRule(),
    SECRET_RULE,
    NO_QUESTION_RULE,
    NO_CONSOLE_RULE,
    artifactRule(artifactPath),
    outputRule(REMOTE_SCHEMA),
    JSON_ONLY_RULE,
    extra,
  ].filter(Boolean).join('\n\n');
}

/** Combine verified single vulnerabilities into a privilege chain. */
export function buildChainPrompt({ project, sourceDir, artifactPath, findings, targetUrl, extra }) {
  return [
    stageHeader({ project, stage: '组合验证' }),
    CWD_RULE(sourceDir),
    targetUrl.length > 0 ? `靶机地址：${targetUrl}` : '本项目走沙箱模式，组合链在本地 PoC 中验证。',
    `已验证的单洞：\n${candidateSummary(findings)}`,
    `从“无需登录”或“普通用户”起步，把已发现的漏洞串成一条更高危害的利用链。不要从管理员权限起步，不要引入新的、未发现过的漏洞。`,
    `如果只有一个漏洞或无法串联，返回空 chains，不要编造。`,
    `证据只记录只读证明，规则同远程验证。`,
    SECRET_RULE,
    NO_QUESTION_RULE,
    NO_CONSOLE_RULE,
    artifactRule(artifactPath),
    outputRule(CHAIN_SCHEMA),
    JSON_ONLY_RULE,
    extra,
  ].filter(Boolean).join('\n\n');
}

/** Optional replay against other tagged versions using already-found PoCs. */
export function buildHistoryPrompt({ project, sourceDir, artifactPath, findings, versions, maxVersions, extra }) {
  return [
    stageHeader({ project, stage: '历史版本验证' }),
    CWD_RULE(sourceDir),
    `对下面这些版本做“用已发现漏洞去打”，不是重新找洞。最多验证 ${maxVersions} 个版本：${versions.join('、') || '（无可用版本）'}`,
    `已发现漏洞：\n${candidateSummary(findings)}`,
    `把目标版本克隆到 .codeaudit/history/<version>/，做最小复现即可；失败要写明失败原因，不要编造成功。`,
    SECRET_RULE,
    NO_QUESTION_RULE,
    NO_CONSOLE_RULE,
    artifactRule(artifactPath),
    outputRule(HISTORY_SCHEMA),
    JSON_ONLY_RULE,
    extra,
  ].filter(Boolean).join('\n\n');
}
