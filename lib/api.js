/**
 * Loopback HTTP surface for the console.
 *
 * Prefix `/codeaudit`, JSON API under `/codeaudit/api`, plus one SSE stream.
 * Requests are restricted to loopback unless the plugin config allows remote
 * peers; uploads stream straight to disk with a hard byte cap.
 */
import { createWriteStream } from 'node:fs';
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ensureDir, isObject, truncate } from './util.js';

const JSON_LIMIT = 1024 * 1024;

function json(res, status, value) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function fail(res, status, message) {
  json(res, status, { error: { message } });
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === '';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > JSON_LIMIT) {
        failed = true;
        reject(new Error('请求体超过 1 MiB 限制'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(raw);
        resolve(isObject(value) ? value : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', (error) => {
      if (failed) return;
      failed = true;
      reject(error);
    });
  });
}

async function streamUpload(req, fileName, destination, maxBytes) {
  await ensureDir(path.dirname(destination));
  let size = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const out = createWriteStream(destination);
    const failOnce = (error) => {
      if (settled) return;
      settled = true;
      try {
        out.destroy();
      } catch {
        /* ignore */
      }
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        failOnce(new Error(`上传超过上限 ${Math.round(maxBytes / 1024 / 1024)} MiB`));
        req.destroy();
        return;
      }
      if (!out.write(chunk)) req.pause();
    });
    out.on('drain', () => req.resume());
    req.on('end', () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
    req.on('error', (error) => failOnce(error));
    out.on('error', (error) => failOnce(error));
  });
  void fileName;
  return size;
}

/**
 * @param {object} options
 */
export function createApi({ ctx, config, service, store, events, paths, whenReady, logger }) {
  function allowed(req) {
    if (config.allowRemote === true) return true;
    return isLoopback(req);
  }

  function broadcastFrame(frame) {
    // The SSE set is owned by this closure; see `openStream`.
    for (const write of subscribers) {
      try {
        write(frame);
      } catch {
        /* a dead subscriber is removed by its close handler */
      }
    }
  }

  /** @type {Set<(frame: object) => void>} */
  const subscribers = new Set();
  let unsubscribeBus = null;

  function track(frame) {
    if (frame?.type === 'project' || frame?.type === 'events') {
      broadcastFrame(frame);
      return;
    }
    if (frame?.type === 'meta' || frame?.type === 'settings' || frame?.type === 'notice' || frame?.type === 'open-panel') {
      broadcastFrame(frame);
    }
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const send = (frame) => {
      if (res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      } catch {
        /* closed */
      }
    };
    subscribers.add(send);
    void service.getSnapshot()
      .then((state) => send({ type: 'snapshot', state }))
      .catch((error) => send({ type: 'notice', tone: 'error', message: `状态加载失败：${error instanceof Error ? error.message : String(error)}` }));
    const ping = setInterval(() => {
      if (res.writableEnded) return;
      try {
        res.write(': ping\n\n');
      } catch {
        /* closed */
      }
    }, 15000);
    if (typeof ping.unref === 'function') ping.unref();
    const cleanup = () => {
      subscribers.delete(send);
      clearInterval(ping);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  async function handle(req, res) {
    if (typeof whenReady === 'function') await whenReady();
    if (!allowed(req)) {
      fail(res, 403, 'Code Audit 控制台默认只允许本机访问');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = String(req.method ?? 'GET').toUpperCase();

    if (pathname === '/codeaudit/health' && method === 'GET') {
      json(res, 200, { ok: true, name: 'code-audit', version: 1 });
      return;
    }
    if (pathname === '/codeaudit/api/state' && method === 'GET') {
      json(res, 200, await service.getSnapshot());
      return;
    }
    if (pathname === '/codeaudit/api/session' && method === 'GET') {
      let cwd = null;
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        const session = sessions?.get?.(url.searchParams.get('sessionId') ?? '');
        cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : null;
      } catch {
        cwd = null;
      }
      json(res, 200, { sessionId: url.searchParams.get('sessionId') ?? null, cwd });
      return;
    }
    if (pathname === '/codeaudit/api/open-panel' && method === 'POST') {
      events.emit({ type: 'open-panel' });
      json(res, 200, { ok: true });
      return;
    }
    if (pathname === '/codeaudit/api/client-log' && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const line = JSON.stringify({
          at: new Date().toISOString(),
          remote: req.socket?.remoteAddress ?? '',
          ...body,
        }).slice(0, 4000);
        await appendFile(path.join(paths.root, 'client-log.jsonl'), `${line}\n`, 'utf8');
        json(res, 200, { ok: true });
      } catch (error) {
        fail(res, 400, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (pathname === '/codeaudit/api/client-log' && method === 'GET') {
      try {
        const raw = await readFile(path.join(paths.root, 'client-log.jsonl'), 'utf8');
        const entries = raw.split('\n').filter((line) => line.trim().length > 0).slice(-100)
          .map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } });
        json(res, 200, { entries });
      } catch {
        json(res, 200, { entries: [] });
      }
      return;
    }
    if (pathname === '/codeaudit/api/stream' && method === 'GET') {
      openStream(req, res);
      return;
    }
    if (pathname === '/codeaudit/api/uploads' && method === 'POST') {
      const name = String(url.searchParams.get('name') ?? 'upload.zip');
      const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.zip`;
      const destination = path.join(paths.uploadsDir, id);
      const maxBytes = Number(config.maxUploadBytes) || 8 * 1024 * 1024 * 1024;
      try {
        const bytes = await streamUpload(req, name, destination, maxBytes);
        if (bytes === 0) {
          await unlink(destination).catch(() => undefined);
          fail(res, 400, '上传文件为空');
          return;
        }
        await writeFile(
          `${destination}.meta.json`,
          `${JSON.stringify({ name: path.basename(name).slice(0, 200), bytes, at: Date.now() }, null, 2)}\n`,
          'utf8',
        );
        json(res, 200, { uploadId: id, name, bytes });
      } catch (error) {
        await unlink(destination).catch(() => undefined);
        fail(res, 400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (pathname === '/codeaudit/api/github/preview' && method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const preview = await service.previewGithub({ url: body.url });
        json(res, 200, preview);
      } catch (error) {
        fail(res, 400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (pathname === '/codeaudit/api/projects' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = await service.createProject(body);
      json(res, result.ok === true ? 200 : 400, result);
      return;
    }
    if (pathname === '/codeaudit/api/projects' && method === 'GET') {
      json(res, 200, { projects: service.listProjects() });
      return;
    }

    const projectMatch = pathname.match(/^\/codeaudit\/api\/projects\/([A-Za-z0-9_-]+)(?:\/([a-z-]+))?$/u);
    if (projectMatch !== null) {
      const id = projectMatch[1];
      const suffix = projectMatch[2] ?? '';
      const project = store.getProject(id);
      if (project === undefined) {
        fail(res, 404, '项目不存在');
        return;
      }
      if (suffix === '' && method === 'GET') {
        json(res, 200, service.getProject(id));
        return;
      }
      if (suffix === 'events' && method === 'GET') {
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
        const list = await events.history(id, limit);
        json(res, 200, { events: list });
        return;
      }
      if (suffix === 'findings' && method === 'GET') {
        json(res, 200, { findings: store.getFindings(id) });
        return;
      }
      if (suffix === 'report' && method === 'GET') {
        const format = url.searchParams.get('format') === 'md' ? 'md' : 'html';
        const file = format === 'md' ? project.report?.mdPath : project.report?.htmlPath;
        if (typeof file !== 'string' || !file.startsWith(paths.root)) {
          fail(res, 404, '报告尚未生成');
          return;
        }
        try {
          const content = await readFile(file, 'utf8');
          res.writeHead(200, {
            'content-type': format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(content);
        } catch {
          fail(res, 404, '报告文件不存在');
        }
        return;
      }
      if (suffix === 'actions' && method === 'POST') {
        const body = await readJsonBody(req);
        const result = await service.controlProject(id, String(body.action ?? ''));
        json(res, result.ok === true ? 200 : 400, result);
        return;
      }
      if (suffix === 'stage' && method === 'POST') {
        const body = await readJsonBody(req);
        const result = await service.rerunStage(id, String(body.stage ?? ''), body.mode);
        json(res, result.ok === true ? 200 : 400, result);
        return;
      }
      fail(res, 404, '未知的项目接口');
      return;
    }

    if (pathname === '/codeaudit/api/monitors' && method === 'GET') {
      json(res, 200, { monitors: store.getMonitors() });
      return;
    }
    if (pathname === '/codeaudit/api/monitors' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = await service.addMonitor(body).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      json(res, result.ok === true ? 200 : 400, result);
      return;
    }
    const monitorMatch = pathname.match(/^\/codeaudit\/api\/monitors\/([A-Za-z0-9_-]+)(?:\/([a-z-]+))?$/u);
    if (monitorMatch !== null) {
      const id = monitorMatch[1];
      const suffix = monitorMatch[2] ?? '';
      if (suffix === 'check' && method === 'POST') {
        const result = await service.checkMonitor(id);
        json(res, result.ok === true ? 200 : 400, result);
        return;
      }
      if (suffix === '' && method === 'POST') {
        const body = await readJsonBody(req);
        const result = service.updateMonitor(id, body);
        json(res, result.ok === true ? 200 : 400, result);
        return;
      }
      if (suffix === '' && method === 'DELETE') {
        const result = service.removeMonitor(id);
        json(res, 200, result);
        return;
      }
    }

    if (pathname === '/codeaudit/api/settings' && method === 'GET') {
      json(res, 200, { settings: service.publicSettings(), capabilities: await service.capabilities() });
      return;
    }
    if (pathname === '/codeaudit/api/settings' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = service.updateSettings(body.settings ?? body);
      json(res, result.ok === true ? 200 : 400, result);
      return;
    }
    if (pathname === '/codeaudit/api/settings/test' && method === 'POST') {
      const result = await service.settingsTest();
      json(res, result.ok === true ? 200 : 400, result);
      return;
    }

    if (pathname === '/codeaudit/api/bulk' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = await service.bulk(String(body.kind ?? ''));
      json(res, result.ok === true ? 200 : 400, result);
      return;
    }

    if (pathname === '/codeaudit/api/recycle' && method === 'GET') {
      json(res, 200, { recycle: store.getRecycle() });
      return;
    }

    fail(res, 404, '未知接口');
  }

  function handler(req, res) {
    handle(req, res).catch((error) => {
      logger?.warn?.(`code-audit: API error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      fail(res, 500, truncate(error instanceof Error ? error.message : String(error), 500));
    });
  }

  function mount(webServer) {
    const disposeRoute = webServer.register({ kind: 'prefix', path: '/codeaudit', handler });
    unsubscribeBus = events.subscribe((frame) => track(frame));
    return () => {
      try {
        unsubscribeBus?.();
      } catch {
        /* already gone */
      }
      try {
        for (const send of subscribers) subscribers.delete(send);
      } catch {
        /* ignore */
      }
      try {
        disposeRoute?.();
      } catch {
        /* already disposed */
      }
    };
  }

  return { mount, handler };
}
