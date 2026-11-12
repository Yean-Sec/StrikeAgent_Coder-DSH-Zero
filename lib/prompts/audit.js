/**
 * Prompt builders for the code-audit lane (the six audit steps).
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
  planSummary,
  severityRule,
  stageHeader,
} from './common.js';

const PLAN_SCHEMA = `{
  "language": "php",
  "hasWeb": true,
  "hasRegistration": true,
  "regDefaultOpen": null,
  "lanes": [
    { "key": "cmd", "label": "命令执行", "focus": "本路只看的攻击面", "seedFiles": ["相对路径"] }
  ],
  "notes": "对项目结构的简短说明"
}
说明：lanes 最多 4 条；key 只能取 cmd、inject、file、auth（C/C++ 可用 mem，Solidity 可用 reent、auth、logic、dep）。hasWeb/hasRegistration/regDefaultOpen 允许 null 表示无法判断。`;

const CANDIDATE_SCHEMA = `{
  "lane": "cmd",
  "candidates": [
    {
      "id": "cmd-1",
      "title": "中文漏洞标题，必须点明漏洞类型",
      "severity": "critical|high|medium|low|info",
      "category": "命令执行|SQL 注入|文件包含|路径穿越|反序列化|认证绕过|越权|SSRF|XSS|XXE|其他",
      "file": "相对源码根的文件路径",
      "line": 42,
      "description": "漏洞是什么、为什么可利用",
      "recommendation": "修复建议",
      "codeSnippet": "关键代码片段（不要超过 40 行）",
      "taintChain": "Source: 用户输入点 → 中间处理 → Sink: 危险函数",
      "entry": "HTTP 方法 + 路径，或 CLI/消息入口",
      "authRequired": "none|user|admin",
      "confidence": "high|medium|low"
    }
  ]
}`;

const DEDUPE_SCHEMA = `{
  "removed": [ { "id": "cmd-1", "reason": "为什么是重复", "mergedInto": "cmd-2" } ],
  "clusters": [ { "clusterId": "cluster-1", "candidateIds": ["cmd-2", "auth-1"], "note": "同一代码点的不同利用面" } ]
}`;

const CODEVERIFY_SCHEMA = `{
  "results": [
    {
      "id": "cmd-1",
      "verified": true,
      "reason": "在源码里如何一步步走到 Sink；若为 false 说明断在哪一步",
      "evidence": { "file": "相对路径", "line": 42, "snippet": "关键代码" }
    }
  ]
}`;

const REGRADE_SCHEMA = `{
  "results": [
    {
      "id": "cmd-1",
      "severity": "critical|high|medium|low|info",
      "value": "高|中|低|无",
      "title": "中文标题（可改写，但必须保留漏洞类型）",
      "category": "类别",
      "reason": "按实战价值评级的理由",
      "authRequired": "none|user|admin",
      "authReason": "权限判断依据"
    }
  ]
}
规则：只能降级或维持，不能把信息级/理论问题提升成高危。纯理论、缺少入口 → info；配置类 → info；资源消耗、弱防护、反射型 XSS → low；没有点名入口的 SSRF → low。“无”对应 info。`;

/** Dispatch: pick up to four specialized lanes. */
export function buildDispatchPrompt({ project, sourceDir, artifactPath, extra }) {
  return [
    stageHeader({ project, stage: '主智能体调度' }),
    CWD_RULE(sourceDir),
    `你的任务：只做项目勘察和分路，不逐文件挖洞。快速查看目录结构、构建文件、入口文件（路由/控制器/CLI/消息消费），然后给出最多 4 条专项审计路。`,
    `每条路必须写清 focus（只看什么）和 seedFiles（建议先看的文件，相对路径）。不要给 5 条。`,
    `如果实际源码的主语言与上面标注的不同，请在 language 字段写正确值；分路按实际语言选择。`,
    `同时判断：项目是否有 Web 入口（hasWeb）、是否有注册功能（hasRegistration）、默认配置下注册是否对匿名开放（regDefaultOpen，无法判断写 null）。`,
    SOURCE_TRUST_RULE,
    TOOL_RULE,
    SECRET_RULE,
    NO_QUESTION_RULE,
    NO_CONSOLE_RULE,
    artifactRule(artifactPath),
    outputRule(PLAN_SCHEMA),
    JSON_ONLY_RULE,
    extra,
  ].filter(Boolean).join('\n\n');
}

/** One specialized audit lane: static discovery only. */
export function buildAuditLanePrompt({ project, sourceDir, lane, plan, artifactPath, extra }) {
  return [
    stageHeader({ project, stage: '多智能体审计', lane }),
    CWD_RULE(sourceDir),
    `主控给出的分路计划：\n${planSummary(plan)}`,
    `你只负责「${lane.label}」这一路：${lane.focus}。不要越界审计其他路，也不要去重、不要做代码级验证、不要搭建靶机。`,
    Array.isArray(lane.seedFiles) && lane.seedFiles.length > 0 ? `建议先看：\n${lane.seedFiles.map((file) => `- ${file}`).join('\n')}` : '',
    `对每条可疑点，必须给出 Source（用户可控输入）→ 中间处理 → Sink（危险操作）的完整代码路径，并写清文件与行号。走不通的不要报。`,
    severityRule(),
    authRule(),
    SOURCE_TRUST_RULE,
    TOOL_RULE,
    SECRET_RULE,
    NO_QUESTION_RULE,
    NO_CONSOLE_RULE,
    artifactRule(artifactPath),
    outputRule(CANDIDATE_SCHEMA),
    JSON_ONLY_RULE,
    extra,
  ].filter(Boolean).join('\n\n');
}

/** Semantic de-duplication over all candidates. */
export function buildDedupePrompt({ project, sourceDir, inputPath, artifactPath, candidateList, extra }) {
  return [
    stageHeader({ project, stage: 'AI 智能去重' }),
    CWD_RULE(sourceDir),
    `候选汇总文件：${inputPath}（JSON）。先读取它，再结合源码判断语义重复。`,
    `规则：同一漏洞、只是措辞不同 → 合并；同一代码点的不同利用面 → 都保留，归到同一簇。不要发现新漏洞，不要删除有独立利用价值的候选。`,
    `候选摘要（完整字段以文件为准）：\n${candidateSummary(candidateList)}`,
    SOURCE_TRUST_RULE,
    NO_QUESTION_RULE,
    NO_CONSOLE_RULE,
    artifactRule(artifactPath),
    outputRule(DEDUPE_SCHEMA),
    JSON_ONLY_RULE,
    extra,
  ].filter(Boolean).join('\n\n');
}

/** Code-level verification for one batch of candidates. */
export function buildCodeVerifyPrompt({ project, sourceDir, batchPath, artifactPath, candidates, extra }) {
  return [
    stageHeader({ project, stage: '代码级验证' }),
    CWD_RULE(sourceDir),
    `本批候选文件：${batchPath}（JSON）。逐条回到源码核对：Source 是否真的用户可控、中间是否有净化、Sink 是否真的执行。`,
    `未证实的不要写成已验证。只给结论，不要重写漏洞报告，不要发现新漏洞。`,
    `候选摘要：\n${candidateSummary(candidates)}`,
    SOURCE_TRUST_RULE,
    TOOL_RULE,
    NO_QUESTION_RULE,
    NO_CONSOLE_RULE,
    artifactRule(artifactPath),
    outputRule(CODEVERIFY_SCHEMA),
    JSON_ONLY_RULE,
    extra,
  ].filter(Boolean).join('\n\n');
}

/** Red-team re-rating for one batch of code-verified candidates. */
export function buildRegradePrompt({ project, sourceDir, batchPath, artifactPath, candidates, extra }) {
  return [
    stageHeader({ project, stage: '红队二次评级' }),
    CWD_RULE(sourceDir),
    `本批候选文件：${batchPath}（JSON）。按实战利用价值重新定级，并给出更适合展示的中文标题和类别。`,
    `硬性规则：只能降级或维持，不能升级。无法证明实战可达的，按指南上限降级。`,
    `候选摘要：\n${candidateSummary(candidates)}`,
    SOURCE_TRUST_RULE,
    NO_QUESTION_RULE,
    NO_CONSOLE_RULE,
    artifactRule(artifactPath),
    outputRule(REGRADE_SCHEMA),
    JSON_ONLY_RULE,
    extra,
  ].filter(Boolean).join('\n\n');
}
