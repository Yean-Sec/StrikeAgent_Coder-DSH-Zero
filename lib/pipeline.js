/**
 * In-memory pipeline state plus findings derivation.
 *
 * Candidate ids stay stable across stage re-runs (`cmd-1`, `auth-2`, …), so the
 * verification record can be keyed by the same id the audit lane produced.
 */
import { SEVERITY_RANK } from './constants.js';
import { readJson } from './util.js';
import path from 'node:path';

/** @returns {object} */
export function emptyPipeline() {
  return {
    plan: null,
    lanes: {},        // laneKey -> candidate[]
    dedupe: null,     // { removed, clusters }
    codeVerify: {},   // candidateId -> result
    regrade: {},      // candidateId -> result
    env: null,
    remote: {},       // candidateId -> result
    chains: [],
    history: [],
    findings: [],
  };
}

/** All candidates across lanes, in stable order. */
export function allCandidates(pipeline) {
  const lanes = pipeline?.lanes ?? {};
  const order = Array.isArray(pipeline?.plan?.lanes) ? pipeline.plan.lanes.map((lane) => lane.key) : Object.keys(lanes);
  const result = [];
  for (const key of order) {
    for (const candidate of lanes[key] ?? []) result.push(candidate);
  }
  for (const key of Object.keys(lanes)) {
    if (order.includes(key)) continue;
    for (const candidate of lanes[key] ?? []) result.push(candidate);
  }
  return result;
}

/** Candidates left after semantic de-duplication. */
export function keptCandidates(pipeline) {
  const removed = new Set((pipeline?.dedupe?.removed ?? []).map((row) => row.id));
  return allCandidates(pipeline).filter((candidate) => !removed.has(candidate.id));
}

/**
 * Build the finding list.
 * @param {object} pipeline
 * @param {object} project
 */
export function deriveFindings(pipeline, project) {
  const clusters = new Map();
  for (const cluster of pipeline?.dedupe?.clusters ?? []) {
    for (const id of cluster.candidateIds) {
      const list = clusters.get(id) ?? [];
      list.push(cluster);
      clusters.set(id, list);
    }
  }
  const findings = [];
  for (const candidate of keptCandidates(pipeline)) {
    const code = pipeline?.codeVerify?.[candidate.id] ?? null;
    const regrade = pipeline?.regrade?.[candidate.id] ?? null;
    const remote = pipeline?.remote?.[candidate.id] ?? null;
    const severity = regrade?.severity ?? candidate.severity;
    findings.push({
      id: candidate.id,
      title: regrade?.title || candidate.title,
      severity,
      severityOriginal: regrade === null ? null : candidate.severity,
      regradeValue: regrade?.value ?? null,
      regradeReason: regrade?.reason ?? null,
      category: regrade?.category || candidate.category,
      file: candidate.file,
      line: candidate.line,
      description: candidate.description,
      recommendation: candidate.recommendation,
      codeSnippet: candidate.codeSnippet,
      taintChain: candidate.taintChain,
      entry: candidate.entry,
      authRequired: remote?.evidence?.authRequired ?? regrade?.authRequired ?? candidate.authRequired,
      authReason: remote?.evidence?.authReason ?? regrade?.authReason ?? '',
      codeVerified: code?.verified === true,
      codeVerifyReason: code?.reason ?? '',
      codeEvidence: code?.evidence ?? null,
      verified: remote?.verified === true,
      verifyReason: remote?.reason ?? '',
      evidence: remote?.evidence ?? null,
      clusters: clusters.get(candidate.id) ?? [],
      sourceLane: candidate.sourceLane ?? null,
      confidence: candidate.confidence ?? '',
      createdAt: project?.createdAt ?? null,
    });
  }
  findings.sort((left, right) => {
    const rank = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
    if (rank !== 0) return rank;
    return String(left.file).localeCompare(String(right.file));
  });
  pipeline.findings = findings;
  return findings;
}

/** Recompute counts and the verified count from the derived findings. */
export function summarizeFindings(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let verifiedCount = 0;
  for (const finding of findings) {
    if (Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1;
    if (finding.verified === true) verifiedCount += 1;
  }
  return { counts, verifiedCount };
}

/** Whether a finding is an execution-class bug (for frontend RCE). */
export function isExecutionClass(finding) {
  // The candidate category alone is too coarse: auditors also file argument
  // injection / local file read under 命令执行. Require an execution phrase in
  // the finding title itself, not just in the category.
  const title = String(finding?.title ?? '').toLowerCase();
  return /rce|远程代码执行|远程命令执行|命令执行|命令注入|代码执行|代码注入|远程执行|反序列化|deserialization|模板注入|ssti|command injection|code execution/u.test(title);
}

/**
 * Front-end RCE per guide §10: verified remote execution reachable without
 * login, or with a normal user when registration is open by default.
 */
export function computeFrontendRce(findings, project) {
  const regOpen = project?.regDefaultOpen === true;
  return findings.some((finding) => {
    if (finding.verified !== true) return false;
    if (!isExecutionClass(finding)) return false;
    if (finding.authRequired === 'none') return true;
    return regOpen && finding.authRequired === 'user';
  });
}

async function readArtifact(file) {
  return readJson(file, undefined);
}

/**
 * Load the pipeline from the run directory (used after a pause or a stage
 * re-run). Missing files simply leave that stage empty.
 * @param {object} input { runDir, plan }
 */
export async function loadPipeline({ runDir, plan }) {
  const pipeline = emptyPipeline();
  pipeline.plan = plan ?? (await readArtifact(path.join(runDir, 'dispatch', 'plan.json'))) ?? null;
  const lanes = Array.isArray(pipeline.plan?.lanes) ? pipeline.plan.lanes : [];
  for (const lane of lanes) {
    const artifact = await readArtifact(path.join(runDir, 'audit', `${lane.key}.json`));
    const candidates = Array.isArray(artifact?.candidates) ? artifact.candidates : [];
    if (candidates.length > 0) {
      pipeline.lanes[lane.key] = candidates.map((candidate, index) => ({
        ...candidate,
        id: candidate.id || `${lane.key}-${index + 1}`,
        sourceLane: lane.key,
      }));
    }
  }
  pipeline.dedupe = (await readArtifact(path.join(runDir, 'dedupe', 'result.json'))) ?? null;
  pipeline.verifyPlan = (await readArtifact(path.join(runDir, 'vdispatch', 'plan.json'))) ?? null;
  pipeline.env = (await readArtifact(path.join(runDir, 'env', 'result.json'))) ?? null;

  const codeVerify = await readDirectoryArtifacts(path.join(runDir, 'codeverify'), 'result-');
  for (const artifact of codeVerify) {
    for (const row of Array.isArray(artifact?.results) ? artifact.results : []) {
      if (row !== null && typeof row === 'object' && typeof row.id === 'string') pipeline.codeVerify[row.id] = row;
    }
  }
  const regrade = await readDirectoryArtifacts(path.join(runDir, 'regrade'), 'result-');
  for (const artifact of regrade) {
    for (const row of Array.isArray(artifact?.results) ? artifact.results : []) {
      if (row !== null && typeof row === 'object' && typeof row.id === 'string') pipeline.regrade[row.id] = row;
    }
  }
  const remote = await readDirectoryArtifacts(path.join(runDir, 'remote'), 'result-');
  for (const artifact of remote) {
    if (artifact !== undefined && typeof artifact.id === 'string') pipeline.remote[artifact.id] = artifact;
  }
  const chain = (await readArtifact(path.join(runDir, 'chain', 'result.json'))) ?? null;
  if (chain !== null && Array.isArray(chain.chains)) pipeline.chains = chain.chains;
  return pipeline;
}

async function readDirectoryArtifacts(directory, prefix) {
  const { readdir } = await import('node:fs/promises');
  let names = [];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const result = [];
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json')).sort()) {
    const value = await readArtifact(path.join(directory, name));
    if (value !== undefined) result.push(value);
  }
  return result;
}
