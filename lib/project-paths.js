/**
 * Resolve the source tree and run directory for a project.
 *
 * Imported archives/clones live under the data root; a workspace audit points
 * at the directory the DSH Session already opened, and its run artifacts live
 * under that same tree.
 */
import path from 'node:path';

/**
 * @param {ReturnType<import('./paths.js').createPaths>} paths
 * @param {object} project
 */
export function sourceDirOf(paths, project) {
  if (
    project !== null
    && project !== undefined
    && project.sourceType === 'workspace'
    && typeof project.sourcePath === 'string'
    && project.sourcePath.length > 0
  ) {
    return path.resolve(project.sourcePath);
  }
  return paths.srcDir(project.id);
}

/**
 * @param {ReturnType<import('./paths.js').createPaths>} paths
 * @param {object} project
 * @param {string} runId
 */
export function runDirOf(paths, project, runId) {
  return path.join(sourceDirOf(paths, project), '.codeaudit', 'runs', runId);
}

/** The relative run path used in prompts (child cwd is the source root). */
export function runRelative(runId) {
  return `.codeaudit/runs/${runId}`;
}
