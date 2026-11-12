/**
 * Durable JSON store for projects, findings, settings, monitors and the
 * recycle log.
 *
 * State is held in memory and flushed through debounced atomic writes. A
 * process restart reloads every project directory; the small `index.json` is a
 * cache only and is rebuilt when it disagrees with the directories.
 */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_SETTINGS, STORE_VERSION } from './constants.js';
import {
  atomicWriteJson,
  ensureDir,
  isObject,
  nowIso,
  readJson,
} from './util.js';

const PROJECT_WRITE_DELAY_MS = 350;
const INDEX_WRITE_DELAY_MS = 900;

/**
 * @param {object} options
 * @param {ReturnType<import('./paths.js').createPaths>} options.paths
 * @param {object} [options.logger]
 */
export function createStore({ paths, logger }) {
  /** @type {Map<string, object>} */
  const projects = new Map();
  /** @type {Map<string, object[]>} */
  const findings = new Map();
  const dirtyProjects = new Set();
  const dirtyFindings = new Set();
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();
  let settings = { ...DEFAULT_SETTINGS };
  let settingsLoaded = false;
  let monitors = [];
  let recycle = [];
  let indexTimer = null;
  let indexDirty = false;
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();
  let closed = false;

  function enqueue(work) {
    writeChain = writeChain.then(work).catch((error) => {
      logger?.warn?.(`code-audit: store write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return writeChain;
  }

  function scheduleFlush(key, delay, work) {
    if (closed) return;
    if (timers.has(key)) clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      void enqueue(work);
    }, delay));
  }

  async function loadProjectDir(id) {
    const project = await readJson(paths.projectFile(id), null);
    if (!isObject(project) || typeof project.id !== 'string') return false;
    const list = await readJson(paths.findingsFile(id), []);
    projects.set(id, project);
    findings.set(id, Array.isArray(list) ? list : []);
    return true;
  }

  async function init() {
    await ensureDir(paths.root);
    await ensureDir(paths.projectsDir);
    await ensureDir(paths.uploadsDir);
    const savedSettings = await readJson(paths.settingsFile, null);
    if (isObject(savedSettings)) {
      settings = { ...DEFAULT_SETTINGS, ...savedSettings };
      settingsLoaded = true;
    }
    const savedMonitors = await readJson(paths.monitorsFile, []);
    if (Array.isArray(savedMonitors)) monitors = savedMonitors;
    const savedRecycle = await readJson(paths.recycleFile, []);
    if (Array.isArray(savedRecycle)) recycle = savedRecycle;

    let entries = [];
    try {
      entries = await readdir(paths.projectsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      try {
        await loadProjectDir(id);
      } catch (error) {
        logger?.warn?.(`code-audit: cannot load project ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Projects that were running when the process stopped become paused.
    for (const project of projects.values()) {
      let changed = false;
      if (project.status === 'running') {
        project.status = 'paused';
        project.errorMessage = project.errorMessage || '进程重启，审计已暂停';
        changed = true;
      }
      if (project.verifyStatus === 'running') {
        project.verifyStatus = 'paused';
        project.errorMessage = project.errorMessage || '进程重启，验证已暂停';
        changed = true;
      }
      if (project.prepareState === 'extracting' || project.prepareState === 'cloning') {
        project.prepareState = 'failed';
        project.status = 'failed';
        project.errorMessage = project.errorMessage || '进程重启，导入中断';
        changed = true;
      }
      if (changed) dirtyProjects.add(project.id);
    }
    await flush();
    logger?.info?.(`code-audit: store ready at ${paths.root} (${projects.size} projects)`);
  }

  function listProjects() {
    return [...projects.values()].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  }

  function getProject(id) {
    return projects.get(id);
  }

  function getFindings(id) {
    return findings.get(id) ?? [];
  }

  function nextFindingId(projectId) {
    const list = findings.get(projectId) ?? [];
    let max = 0;
    for (const finding of list) {
      const match = String(finding?.id ?? '').match(/(\d+)$/u);
      if (match !== null) max = Math.max(max, Number(match[1]));
    }
    return `vuln-${max + 1}`;
  }

  function countFindings(projectId) {
    const list = findings.get(projectId) ?? [];
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of list) {
      if (Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1;
    }
    return counts;
  }

  async function createProject(project) {
    await ensureDir(paths.projectDir(project.id));
    await ensureDir(paths.srcDir(project.id));
    await ensureDir(paths.reportsDir(project.id));
    await ensureDir(paths.evidenceDir(project.id));
    projects.set(project.id, project);
    if (!findings.has(project.id)) findings.set(project.id, []);
    dirtyProjects.add(project.id);
    indexDirty = true;
    await flushProject(project.id);
    scheduleIndex();
    return project;
  }

  function updateProject(id, patch) {
    const project = projects.get(id);
    if (project === undefined) return undefined;
    if (typeof patch === 'function') {
      const next = patch(project);
      if (isObject(next)) Object.assign(project, next);
    } else if (isObject(patch)) {
      Object.assign(project, patch);
    }
    project.updatedAt = nowIso();
    dirtyProjects.add(id);
    indexDirty = true;
    scheduleFlush(`project:${id}`, PROJECT_WRITE_DELAY_MS, () => flushProject(id));
    scheduleIndex();
    return project;
  }

  async function flushProject(id) {
    const project = projects.get(id);
    if (project === undefined) return;
    if (dirtyProjects.has(id)) {
      dirtyProjects.delete(id);
      await atomicWriteJson(paths.projectFile(id), project);
    }
    if (dirtyFindings.has(id)) {
      dirtyFindings.delete(id);
      await atomicWriteJson(paths.findingsFile(id), findings.get(id) ?? []);
    }
  }

  function replaceFindings(projectId, list) {
    findings.set(projectId, Array.isArray(list) ? list : []);
    dirtyFindings.add(projectId);
    scheduleFlush(`findings:${projectId}`, PROJECT_WRITE_DELAY_MS, () => flushProject(projectId));
  }

  function scheduleIndex() {
    if (closed) return;
    if (indexTimer !== null) clearTimeout(indexTimer);
    indexTimer = setTimeout(() => {
      indexTimer = null;
      void enqueue(flushIndex);
    }, INDEX_WRITE_DELAY_MS);
  }

  async function flushIndex() {
    if (!indexDirty) return;
    indexDirty = false;
    const rows = listProjects().map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
      verifyStatus: project.verifyStatus,
      language: project.language,
      createdAt: project.createdAt,
      finishedAt: project.finishedAt ?? null,
      counts: project.counts ?? countFindings(project.id),
      frontendRce: project.frontendRce === true,
    }));
    await atomicWriteJson(paths.indexFile, {
      version: STORE_VERSION,
      updatedAt: nowIso(),
      projects: rows,
    });
  }

  function getSettings() {
    return { ...settings };
  }

  function updateSettings(patch) {
    settings = { ...settings, ...(isObject(patch) ? patch : {}) };
    void enqueue(() => atomicWriteJson(paths.settingsFile, settings));
    return { ...settings };
  }

  function getMonitors() {
    return monitors.map((monitor) => ({ ...monitor }));
  }

  function setMonitors(next) {
    monitors = Array.isArray(next) ? next : [];
    void enqueue(() => atomicWriteJson(paths.monitorsFile, monitors));
    return getMonitors();
  }

  function getRecycle() {
    return recycle.map((row) => ({ ...row })).sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0));
  }

  function addRecycle(record) {
    recycle = [record, ...recycle].slice(0, 2000);
    void enqueue(() => atomicWriteJson(paths.recycleFile, recycle));
  }

  async function removeProject(id) {
    projects.delete(id);
    findings.delete(id);
    dirtyProjects.delete(id);
    dirtyFindings.delete(id);
    if (timers.has(`project:${id}`)) {
      clearTimeout(timers.get(`project:${id}`));
      timers.delete(`project:${id}`);
    }
    if (timers.has(`findings:${id}`)) {
      clearTimeout(timers.get(`findings:${id}`));
      timers.delete(`findings:${id}`);
    }
    indexDirty = true;
    scheduleIndex();
    try {
      await rm(paths.projectDir(id), { recursive: true, force: true });
    } catch (error) {
      logger?.warn?.(`code-audit: cannot delete project directory ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function flush() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (indexTimer !== null) {
      clearTimeout(indexTimer);
      indexTimer = null;
      indexDirty = true;
    }
    const ids = new Set([...dirtyProjects, ...dirtyFindings]);
    for (const id of ids) {
      await enqueue(() => flushProject(id));
    }
    indexDirty = true;
    await enqueue(flushIndex);
    await writeChain;
  }

  async function close() {
    await flush();
    closed = true;
  }

  return {
    init,
    listProjects,
    getProject,
    getFindings,
    nextFindingId,
    countFindings,
    createProject,
    updateProject,
    replaceFindings,
    getSettings,
    updateSettings,
    getMonitors,
    setMonitors,
    getRecycle,
    addRecycle,
    removeProject,
    flush,
    close,
    get size() {
      return projects.size;
    },
    get settingsLoaded() {
      return settingsLoaded;
    },
  };
}
