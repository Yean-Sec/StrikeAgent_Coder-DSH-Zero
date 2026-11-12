/**
 * Lifecycle tests: activation and disposal must never crash the Host.
 *
 * The plugin is loaded with a stub Cordis context; the test focuses on the
 * effect cleanup path that previously threw `ReferenceError: envRun is not
 * defined` on every disable/restart and took the whole desktop Host down.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';

function makeContext(config) {
  const effects = [];
  const listeners = new Map();
  const tools = new Map();
  const disposers = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') effects.push(dispose);
      return () => {};
    },
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    inject(_services, callback) {
      callback(ctx);
      return () => {};
    },
    get(service) {
      return services[service];
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
      definitions() {
        return [...tools.values()].map((definition) => ({ name: definition.name }));
      },
      guard(guard) {
        disposers.push(guard);
        return () => {};
      },
    },
    systemPrompt: { section() {} },
    webServer: undefined,
  };

  const services = {
    webServer: {
      getOrigin: () => 'http://127.0.0.1:1',
      register() {
        return () => {};
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
    },
    llm: {
      listProviders: () => [{ id: 'test-provider', name: 'Test' }],
      async listModels() {
        return [{ id: 'test-model' }];
      },
      async resolveModelInfo() {
        return { id: 'test-model' };
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    permissionPresets: { catalog: () => ({ options: [] }), resolve: () => ({ sandbox: 'danger-full-access', approval: 'never' }), set() {} },
    agentPresets: { list: async () => [{ id: 'standard' }] },
    agents: {
      async create() {
        throw new Error('not used in lifecycle test');
      },
      get() {
        return undefined;
      },
    },
    agentLoop: {
      async createAgent() {
        throw new Error('not used in lifecycle test');
      },
    },
    subagents: {
      async startActivation() {
        throw new Error('not used in lifecycle test');
      },
      listDescendants: async () => [],
      interrupt() {},
    },
    approval: { setPolicy() {} },
  };

  ctx.get = (name) => services[name];
  ctx.inject = (_services, callback) => {
    callback(ctx);
    return () => {};
  };
  return {
    ctx,
    tools,
    effects,
    unhandled,
    stopTracking() {
      process.removeListener('unhandledRejection', onUnhandled);
    },
    async dispose() {
      for (const dispose of effects.reverse()) {
        await dispose();
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    },
    config,
  };
}

test('activation and disposal never throw or leak unhandled rejections', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cau-lifecycle-'));
  const harness = makeContext({ dataDir: root, globalEnabled: true });
  try {
    apply(harness.ctx, { dataDir: root });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The tool is registered and callable.
    const tool = harness.tools.get('code_audit');
    assert.ok(tool !== undefined, 'code_audit tool should be registered');
    const listed = await tool.execute({ action: 'list' }, {});
    assert.match(listed.summary, /审计项目|没有审计项目/);
    // Settings were removed from the tool along with the console settings page.
    const removed = await tool.execute({ action: 'settings' }, {});
    assert.match(removed.summary, /未知 action/);
    // Disposal (the previous crash path) must complete quietly.
    await harness.dispose();
    assert.deepEqual(harness.unhandled, []);
  } finally {
    harness.stopTracking();
    await rm(root, { recursive: true, force: true });
  }
});

test('disposal pauses a running project without throwing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cau-lifecycle-'));
  const harness = makeContext({ dataDir: root, globalEnabled: true });
  try {
    // A real project record is required: the previous crash happened inside the
    // project loop of stop(), so an empty store never reproduced it.
    const projectDir = path.join(root, 'projects', 'p-running');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      id: 'p-running',
      name: 'running demo',
      language: 'php',
      sourceType: 'zip',
      sourceRef: '/tmp/none.zip',
      options: { runtime: 'full', aiDedup: true, aiRegrade: true, verifyHistory: false },
      prepareState: 'ready',
      status: 'running',
      verifyStatus: 'none',
      envStatus: 'none',
      stageStatus: { dispatch: 'running', audit: 'pending', dedupe: 'pending', codeverify: 'pending', regrade: 'pending', done: 'pending', vdispatch: 'pending', env: 'pending', remote: 'pending', chain: 'pending', vdone: 'pending', history: 'pending' },
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      createdAt: new Date().toISOString(),
    }, null, 2));
    apply(harness.ctx, { dataDir: root });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await harness.dispose();
    assert.deepEqual(harness.unhandled, []);
    const stored = JSON.parse(await readFile(path.join(projectDir, 'project.json'), 'utf8'));
    assert.equal(stored.status, 'paused');
    assert.equal(stored.stageStatus.dispatch, 'paused');
  } finally {
    harness.stopTracking();
    await rm(root, { recursive: true, force: true });
  }
});
