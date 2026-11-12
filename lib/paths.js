/**
 * Persistent directory layout.
 *
 * Everything lives under one data root so a reinstall keeps projects and
 * reports. Source archives are kept as files and the project record stores
 * their absolute path, per the guide.
 */
import os from 'node:os';
import path from 'node:path';

/**
 * Resolve the data root.
 * @param {{ dataDir?: string }} config resolved plugin config
 * @returns {string} absolute root
 */
export function resolveDataDir(config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
  if (configured.length > 0) return path.resolve(configured);
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'codeaudit');
}

/**
 * Absolute paths for one data root.
 * @param {string} root
 */
export function createPaths(root) {
  const data = path.resolve(root);
  return {
    root: data,
    indexFile: path.join(data, 'index.json'),
    settingsFile: path.join(data, 'settings.json'),
    monitorsFile: path.join(data, 'monitors.json'),
    recycleFile: path.join(data, 'recycle.json'),
    uploadsDir: path.join(data, 'uploads'),
    projectsDir: path.join(data, 'projects'),
    projectDir: (id) => path.join(data, 'projects', id),
    projectFile: (id) => path.join(data, 'projects', id, 'project.json'),
    findingsFile: (id) => path.join(data, 'projects', id, 'findings.json'),
    eventsFile: (id) => path.join(data, 'projects', id, 'events.jsonl'),
    srcDir: (id) => path.join(data, 'projects', id, 'src'),
    archiveFile: (id) => path.join(data, 'projects', id, 'source.zip'),
    evidenceDir: (id) => path.join(data, 'projects', id, 'evidence'),
    reportsDir: (id) => path.join(data, 'projects', id, 'reports'),
    /** Per-run artifacts written by audit children, inside the source tree. */
    runDir: (id, runId) => path.join(data, 'projects', id, 'src', '.codeaudit', 'runs', runId),
    /** Same run directory expressed relative to the source root (child cwd). */
    runRelative: (runId) => `.codeaudit/runs/${runId}`,
  };
}

/** True when `candidate` is inside `root`. */
export function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel.length === 0 || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True when the path looks like a source checkout (used only for reporting). */
export function isSourceTree(candidate) {
  const base = path.basename(path.resolve(candidate)).toLowerCase();
  return base === 'src' || base === 'source';
}
