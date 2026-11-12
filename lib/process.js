/**
 * Managed child processes for import operations (unzip / git).
 */
import { execFile } from 'node:child_process';

/**
 * Run one command and collect its output.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, maxBuffer?: number, env?: Record<string,string> }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runCommand(command, args, options = {}) {
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      timeout,
      maxBuffer,
      windowsHide: true,
      env: { ...process.env, ...(options.env ?? {}) },
    }, (error, stdout, stderr) => {
      if (error !== null && error !== undefined) {
        if (error.code === 'ENOENT') {
          reject(new Error(`找不到可执行文件 ${command}，请先安装后重试`));
          return;
        }
        if (error.killed === true) {
          reject(new Error(`${command} 执行超时（${Math.round(timeout / 1000)}s）`));
          return;
        }
        const detail = String(stderr || error.message || '').trim();
        reject(new Error(`${command} 执行失败（退出码 ${error.code ?? '未知'}）：${detail.slice(0, 1200)}`));
        return;
      }
      resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}
