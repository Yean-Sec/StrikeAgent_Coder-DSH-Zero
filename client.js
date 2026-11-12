/**
 * Code Audit Console — browser half.
 *
 * One sidebar entry (id `code-audit`) plus the matching central panel
 * (main key `code-audit`). The console is global: no Session is required.
 */
window.__ModuleLoader__.load({
  id: '@local/code-audit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef } = React;

    const NS = 'code-audit';
    const CLIENT_BUILD = '0.5.3-20261108-0015';

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
    const SEVERITY_LABEL = {
      critical: '严重', high: '高危', medium: '中危', low: '低危', info: '提示',
    };
    const SEVERITY_RANK = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
    const HAZARD = {
      critical: '#c64545', high: '#cc785c', medium: '#d4a017', low: '#5db8a6', info: '#8e8b82',
    };
    const AUTH_LABEL = { none: '无需登录', user: '普通用户', admin: '管理员' };
    const STAGE_STATUS_LABEL = {
      pending: '待执行', running: '进行中', done: '已完成', skipped: '已跳过', paused: '已暂停', failed: '失败',
    };
    const AUDIT_STAGES = [
      { key: 'dispatch', label: '主智能体调度', glyph: '✦' },
      { key: 'audit', label: '多智能体审计', glyph: '⦿' },
      { key: 'dedupe', label: 'AI 智能去重', glyph: '⧓' },
      { key: 'codeverify', label: '代码级验证', glyph: '⦿' },
      { key: 'regrade', label: '红队二次评级', glyph: '⚖' },
      { key: 'done', label: '审计完成', glyph: '✓' },
    ];
    const VERIFY_STAGES = [
      { key: 'vdispatch', label: '主智能体调度', glyph: '✦' },
      { key: 'env', label: '靶机环境搭建', glyph: '◈' },
      { key: 'remote', label: '远程验证', glyph: '⦿' },
      { key: 'chain', label: '组合验证', glyph: '◆' },
      { key: 'vdone', label: '验证完成', glyph: '✓' },
    ];
    const LANGUAGES = [
      ['java', 'Java'], ['go', 'Go'], ['python', 'Python'], ['php', 'PHP'],
      ['jsts', 'JavaScript/TypeScript'], ['rust', 'Rust'], ['ruby', 'Ruby'],
      ['csharp', 'C#/.NET'], ['c', 'C'], ['cpp', 'C++'], ['solidity', 'Solidity'],
    ];
    const TOOL_LABEL = {
      read: '读取文件', grep: '检索代码', glob: '匹配文件', bash: '执行命令', pwsh: '执行命令',
      write: '写入文件', edit: '编辑文件', apply_patch: '编辑文件', subagent: '派发子智能体',
      skill: '启动技能', web_search: '联网搜索', web_fetch: '抓取网页', todo_write: '更新待办',
      ask_user_question: '询问用户',
    };

    // ------------------------------------------------------------------
    // Locale (Chinese-first product; English for the panel/nav labels)
    // ------------------------------------------------------------------

    const zh = {
      'panel.title': '代码审计',
      'nav.dashboard': '数据大屏',
      'nav.projects': '审计列表',
      'nav.new': '新建审计',
      'nav.monitors': '监控',
      'nav.recycle': '回收站',
      'nav.settings': '设置',
      'common.save': '保存',
      'common.cancel': '取消',
      'common.confirm': '确认',
      'common.delete': '删除',
      'common.refresh': '刷新',
      'common.loading': '加载中…',
      'common.empty': '还没有数据',
      'common.search': '搜索',
      'common.close': '关闭',
      'common.back': '返回',
      'new.title': '新建审计',
      'detail.flow': '实时流程',
      'detail.events': '事件',
      'detail.findings': '漏洞',
      'detail.report': '报告',
      'detail.stages': '分环节重跑',
    };
    const en = {
      'panel.title': 'Code audit',
      'nav.dashboard': 'Dashboard',
      'nav.projects': 'Audits',
      'nav.new': 'New audit',
      'nav.monitors': 'Monitors',
      'nav.recycle': 'Recycle bin',
      'nav.settings': 'Settings',
      'common.save': 'Save',
      'common.cancel': 'Cancel',
      'common.confirm': 'Confirm',
      'common.delete': 'Delete',
      'common.refresh': 'Refresh',
      'common.loading': 'Loading…',
      'common.empty': 'Nothing here yet',
      'common.search': 'Search',
      'common.close': 'Close',
      'common.back': 'Back',
      'new.title': 'New audit',
      'detail.flow': 'Live flow',
      'detail.events': 'Events',
      'detail.findings': 'Findings',
      'detail.report': 'Report',
      'detail.stages': 'Re-run stages',
    };

    // ------------------------------------------------------------------
    // API helpers
    // ------------------------------------------------------------------

    async function req(method, path, body) {
      const response = await fetch(path, {
        method,
        cache: 'no-store',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok) {
        const message = data?.error?.message ?? `请求失败（HTTP ${response.status}）`;
        throw new Error(message);
      }
      return data;
    }

    const api = {
      state: () => req('GET', '/codeaudit/api/state'),
      session: (id) => req('GET', `/codeaudit/api/session?sessionId=${encodeURIComponent(id)}`),
      project: (id) => req('GET', `/codeaudit/api/projects/${encodeURIComponent(id)}`),
      events: (id, limit = 500) => req('GET', `/codeaudit/api/projects/${encodeURIComponent(id)}/events?limit=${limit}`),
      create: (payload) => req('POST', '/codeaudit/api/projects', payload),
      preview: (url) => req('POST', '/codeaudit/api/github/preview', { url }),
      action: (id, action) => req('POST', `/codeaudit/api/projects/${encodeURIComponent(id)}/actions`, { action }),
      stage: (id, stage, mode) => req('POST', `/codeaudit/api/projects/${encodeURIComponent(id)}/stage`, { stage, mode }),
      settings: () => req('GET', '/codeaudit/api/settings'),
      saveSettings: (settings) => req('POST', '/codeaudit/api/settings', { settings }),
      testSettings: () => req('POST', '/codeaudit/api/settings/test'),
      monitorAdd: (payload) => req('POST', '/codeaudit/api/monitors', payload),
      monitorUpdate: (id, payload) => req('POST', `/codeaudit/api/monitors/${encodeURIComponent(id)}`, payload),
      monitorDelete: (id) => req('DELETE', `/codeaudit/api/monitors/${encodeURIComponent(id)}`),
      monitorCheck: (id) => req('POST', `/codeaudit/api/monitors/${encodeURIComponent(id)}/check`),
      bulk: (kind) => req('POST', '/codeaudit/api/bulk', { kind }),
    };

    function beacon(event, extra) {
      try {
        const payload = {
          event,
          build: CLIENT_BUILD,
          href: typeof location !== 'undefined' ? String(location.href) : '',
          origin: typeof location !== 'undefined' ? String(location.origin) : '',
          ...extra,
        };
        const body = JSON.stringify(payload);
        if (typeof fetch === 'function') {
          fetch('/codeaudit/api/client-log', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            keepalive: true,
          }).catch(() => {});
          return;
        }
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          navigator.sendBeacon('/codeaudit/api/client-log', new Blob([body], { type: 'application/json' }));
        }
      } catch {
        /* diagnostics must never break the console */
      }
    }

    function uploadZip(file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/codeaudit/api/uploads?name=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && typeof onProgress === 'function') {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onerror = () => reject(new Error('上传失败，请重试'));
        xhr.onload = () => {
          let data = {};
          try {
            data = JSON.parse(xhr.responseText);
          } catch {
            data = {};
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data?.error?.message ?? `上传失败（HTTP ${xhr.status}）`));
        };
        xhr.send(file);
      });
    }

    // ------------------------------------------------------------------
    // Small primitives
    // ------------------------------------------------------------------

    function Btn(props) {
      const className = [
        'cau-btn',
        props.variant === 'primary' ? 'cau-btn--primary' : '',
        props.variant === 'danger' ? 'cau-btn--danger' : '',
        props.variant === 'ghost' ? 'cau-btn--ghost' : '',
        props.small === true ? 'cau-btn--sm' : '',
        props.className ?? '',
      ].filter(Boolean).join(' ');
      return h('button', {
        type: 'button',
        className,
        disabled: props.disabled === true,
        onClick: props.onClick,
        title: props.title,
      }, props.icon === undefined ? null : h('span', { className: 'cau-btn-icon', key: 'i' }, props.icon), props.children);
    }

    function Card(props) {
      return h('section', { className: `cau-card${props.className ? ` ${props.className}` : ''}` },
        props.title === undefined ? null : h('header', { className: 'cau-card-head' },
          h('h3', { key: 't' }, props.title),
          h('div', { key: 'e', className: 'cau-card-extra' }, props.extra)),
        h('div', { className: 'cau-card-body' }, props.children));
    }

    function SeverityBadge({ severity }) {
      const sev = SEVERITIES.includes(severity) ? severity : 'info';
      return h('span', {
        className: 'cau-sev',
        style: { background: HAZARD[sev] },
        title: SEVERITY_LABEL[sev],
      }, SEVERITY_LABEL[sev]);
    }

    function StatusPill({ tone, children }) {
      return h('span', { className: `cau-pill cau-pill--${tone ?? 'neutral'}` }, children);
    }

    function Field({ label, hint, children, wide }) {
      return h('label', { className: `cau-field${wide === true ? ' cau-field--wide' : ''}` },
        h('span', { className: 'cau-field-label' }, label),
        children,
        hint === undefined ? null : h('span', { className: 'cau-field-hint' }, hint));
    }

    function Select({ value, onChange, options }) {
      return h('select', { className: 'cau-input', value, onChange: (event) => onChange(event.target.value) },
        options.map((option) => h('option', { key: option[0], value: option[0] }, option[1])));
    }

    function Toggle({ checked, onChange, label }) {
      return h('label', { className: 'cau-toggle' },
        h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
        h('span', { className: 'cau-toggle-track' }, h('span', { className: 'cau-toggle-dot' })),
        label === undefined ? null : h('span', { className: 'cau-toggle-label' }, label));
    }

    function Modal({ open, title, children, onClose, footer }) {
      if (open !== true) return null;
      return h('div', { className: 'cau-modal-mask', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'cau-modal', role: 'dialog', 'aria-modal': 'true' },
          h('header', { className: 'cau-modal-head' }, h('h3', null, title), h('button', { type: 'button', className: 'cau-modal-close', onClick: onClose, 'aria-label': '关闭' }, '×')),
          h('div', { className: 'cau-modal-body' }, children),
          footer === undefined ? null : h('footer', { className: 'cau-modal-foot' }, footer)));
    }

    function Empty({ title, hint, action }) {
      return h('div', { className: 'cau-empty' },
        h('div', { className: 'cau-empty-art', 'aria-hidden': true }, '◌'),
        h('div', { className: 'cau-empty-title' }, title),
        hint === undefined ? null : h('div', { className: 'cau-empty-hint' }, hint),
        action === undefined ? null : h('div', { className: 'cau-empty-action' }, action));
    }

    function Spinner({ label }) {
      return h('div', { className: 'cau-loading' }, h('span', { className: 'cau-spinner', 'aria-hidden': true }), label ?? '加载中…');
    }

    function Progress({ value, tone }) {
      return h('div', { className: 'cau-progress' },
        h('span', { className: `cau-progress-bar${tone === 'teal' ? ' cau-progress-bar--teal' : ''}`, style: { width: `${Math.max(0, Math.min(100, value))}%` } }));
    }

    // ------------------------------------------------------------------
    // Live flow
    // ------------------------------------------------------------------

    const NODE_W = 146;
    const NODE_H = 64;
    const LANE_X = 92;
    const ROW_GAP = 148;
    const PAD = 28;
    const PAD_RIGHT = 24;
    const MIN_GAP = 88;
    const MAX_GAP = 156;

    function flowLayout(width) {
      const compact = width < 1460;
      const nodeW = compact ? 132 : NODE_W;
      const minGap = compact ? 12 : MIN_GAP;
      const maxGap = compact ? 72 : MAX_GAP;
      const usable = Math.floor((width - LANE_X - AUDIT_STAGES.length * nodeW - PAD_RIGHT) / (AUDIT_STAGES.length - 1));
      const gap = Math.max(minGap, Math.min(maxGap, usable));
      const col = (index) => LANE_X + index * (nodeW + gap);
      const yAudit = PAD;
      const yVerify = PAD + NODE_H + ROW_GAP;
      const audit = AUDIT_STAGES.map((stage, index) => ({ ...stage, x: col(index), y: yAudit, lane: 'audit', index }));
      const verify = VERIFY_STAGES.map((stage, index) => ({ ...stage, x: col(index), y: yVerify, lane: 'verify', index }));
      const widthTotal = Math.max(col(AUDIT_STAGES.length - 1), col(VERIFY_STAGES.length - 1)) + nodeW + PAD_RIGHT;
      const heightTotal = yVerify + NODE_H + PAD;
      return { gap, nodeW, compact, audit, verify, width: widthTotal, height: heightTotal, yAudit, yVerify };
    }

    function hEdge(from, to, nodeW) {
      const y = from.y + NODE_H / 2;
      const x1 = from.x + nodeW;
      const x2 = to.x;
      const dx = x2 - x1;
      return `M${x1},${y} C${x1 + dx * 0.42},${y} ${x2 - dx * 0.42},${y} ${x2},${y}`;
    }

    function bridgeEdge(from, to, nodeW) {
      const x1 = from.x + nodeW / 2;
      const y1 = from.y + NODE_H;
      const x2 = to.x + nodeW / 2;
      const y2 = to.y;
      const midY = Math.round((y1 + y2) / 2);
      return {
        d: `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`,
        label: { x: Math.round((x1 + x2) / 2), y: midY - 8 },
      };
    }

    function nodeTone(status) {
      if (status === 'done') return 'done';
      if (status === 'running') return 'active';
      if (status === 'paused') return 'paused';
      if (status === 'failed') return 'failed';
      if (status === 'skipped') return 'skipped';
      return 'pending';
    }

    function AgentFlow({ project, t, scheme }) {
      const flow = project?.flow;
      const scrollRef = useRef(null);
      const [width, setWidth] = useState(760);
      const nodes = useMemo(() => flowLayout(width), [width]);

      useEffect(() => {
        if (flow !== undefined && flow !== null) {
          beacon('flow-mount', { project: project?.id ?? null, nodes: flow.audit?.nodes?.length ?? 0 });
        }
      }, [project?.id]);

      useEffect(() => {
        const element = scrollRef.current;
        if (element === null) return undefined;
        const apply = () => setWidth(Math.max(640, element.clientWidth - 2));
        apply();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(apply);
        observer.observe(element);
        return () => observer.disconnect();
      }, []);

      if (flow === undefined || flow === null) {
        return h('div', { className: 'cau-flow' },
          h('div', { className: 'cau-flow-activity' }, '流程数据尚未加载。请刷新页面，或从审计列表重新打开这个项目。'));
      }

      const auditStatus = (index) => flow.audit.nodes[index]?.status ?? 'pending';
      const verifyStatus = (index) => flow.verify.nodes[index]?.status ?? 'pending';
      const edgeTone = (status) => (status === 'running' ? 'flowing' : status === 'done' || status === 'skipped' ? 'done' : 'pending');

      const auditEdges = [];
      for (let index = 0; index < nodes.audit.length - 1; index += 1) {
        auditEdges.push({ key: `a${index}`, d: hEdge(nodes.audit[index], nodes.audit[index + 1], nodes.nodeW), tone: edgeTone(auditStatus(index + 1)) });
      }
      const verifyEdges = [];
      for (let index = 0; index < nodes.verify.length - 1; index += 1) {
        verifyEdges.push({ key: `v${index}`, d: hEdge(nodes.verify[index], nodes.verify[index + 1], nodes.nodeW), tone: edgeTone(verifyStatus(index + 1)) });
      }
      const bridge = bridgeEdge(nodes.audit[nodes.audit.length - 1], nodes.verify[2], nodes.nodeW);

      const badgeIndex = flow.audit.done
        ? Math.min(11, 6 + (flow.verify.current ?? 0) + 1)
        : Math.min(6, (flow.audit.current ?? 0) + 1);

      const renderNode = (node, status) => {
        const tone = nodeTone(status);
        return h('button', {
          key: `${node.lane}-${node.key}`,
          type: 'button',
          className: `cau-node cau-node--${tone}${nodes.compact ? ' cau-node--compact' : ''}`,
          style: { left: node.x, top: node.y, width: nodes.nodeW, height: NODE_H },
          title: `${node.label} · ${STAGE_STATUS_LABEL[status] ?? status}`,
        },
          h('span', { className: 'cau-node-glyph', 'aria-hidden': true }, tone === 'done' ? '✓' : node.glyph),
          h('span', { className: 'cau-node-body' },
            h('b', null, node.label),
            h('i', null, STAGE_STATUS_LABEL[status] ?? status)));
      };

      return h('div', { className: 'cau-flow' },
        h('header', { className: 'cau-flow-head' },
          h('div', { className: 'cau-flow-badge' }, String(badgeIndex)),
          h('div', { className: 'cau-flow-meta' },
            h('span', { className: 'cau-flow-caption' }, flow.caption),
            h('strong', { className: 'cau-flow-step' }, flow.stepName)),
          h('div', { className: 'cau-flow-progress' }, h('span', { style: { width: `${flow.progress ?? 0}%` } }))),
        h('div', { className: 'cau-flow-activity', role: 'status' }, flow.activity ?? '等待开始'),
        h('div', { className: 'cau-flow-scroll', ref: scrollRef },
          h('div', { className: 'cau-flow-canvas', style: { width: nodes.width, height: nodes.height } },
            h('div', { className: 'cau-lane-label', style: { top: nodes.yAudit + 18 } }, '代码审计'),
            flow.verify.enabled ? h('div', { className: 'cau-lane-label', style: { top: nodes.yVerify + 18 } }, '靶机验证') : null,
            h('svg', { className: 'cau-flow-edges', width: nodes.width, height: nodes.height, 'aria-hidden': true },
              h('defs', null,
                h('marker', { id: 'cau-arrow', viewBox: '0 0 6 6', refX: 5, refY: 3, markerWidth: 5, markerHeight: 5, orient: 'auto' },
                  h('circle', { cx: 3, cy: 3, r: 2, fill: 'currentColor' }))),
              auditEdges.map((edge) => h('path', { key: edge.key, d: edge.d, className: `cau-edge cau-edge--${edge.tone}` })),
              flow.verify.enabled ? h('path', { key: 'bridge', d: bridge.d, className: `cau-edge cau-edge--bridge cau-edge--${flow.bridge}` }) : null,
              flow.verify.enabled ? h('text', {
                key: 'bridge-label',
                x: bridge.label.x,
                y: bridge.label.y,
                className: `cau-edge-label cau-edge-label--${flow.bridge}`,
                textAnchor: 'middle',
              }, '进入靶机验证') : null,
              flow.verify.enabled ? verifyEdges.map((edge) => h('path', { key: edge.key, d: edge.d, className: `cau-edge cau-edge--${edge.tone}` })) : null),
            nodes.audit.map((node, index) => renderNode(node, auditStatus(index))),
            flow.verify.enabled ? nodes.verify.map((node, index) => renderNode(node, verifyStatus(index))) : null)),
        nodes.width > width + 4 ? h('div', { className: 'cau-flow-hint' }, '← 横向滚动查看完整流程 →') : null,
        flow.verify.enabled ? null : h('div', { className: 'cau-flow-note' }, '本次选择「仅代码审计」，靶机验证泳道未启用。'),
        scheme === 'dark' ? null : null);
    }

    // ------------------------------------------------------------------
    // Pages
    // ------------------------------------------------------------------

    function statCard(value, label, tone) {
      return h('div', { key: label, className: `cau-stat cau-stat--${tone ?? 'neutral'}` },
        h('b', null, String(value)),
        h('span', null, label));
    }

    function Dashboard({ state, t, openProject, go, scheme }) {
      const counts = state.counts ?? {};
      const distribution = counts.distribution ?? {};
      const projects = state.projects ?? [];
      const active = projects.filter((project) => project.status === 'running' || project.verifyStatus === 'running');
      const recent = projects.slice(0, 6);
      const max = Math.max(1, ...SEVERITIES.map((severity) => distribution[severity] ?? 0));

      const statRow = h('div', { className: 'cau-stats' },
        statCard(counts.projects ?? 0, '项目数'),
        statCard(counts.running ?? 0, '进行中', 'info'),
        statCard(counts.findings ?? 0, '漏洞总数'),
        statCard(counts.verified ?? 0, '已验证', 'teal'),
        statCard(counts.frontendRce ?? 0, '前台 RCE', 'danger'),
        statCard(counts.completed ?? 0, '已完成', 'teal'));

      const distributionRows = SEVERITIES.map((severity) => {
        const value = distribution[severity] ?? 0;
        return h('div', { key: severity, className: 'cau-dist-row' },
          h('span', { className: 'cau-dist-label', style: { color: HAZARD[severity] } }, SEVERITY_LABEL[severity]),
          h('span', { className: 'cau-dist-bar' },
            h('i', { style: { width: `${(value / max) * 100}%`, background: HAZARD[severity] } })),
          h('span', { className: 'cau-dist-count' }, String(value)));
      });

      let recentBody;
      if (recent.length === 0) {
        recentBody = h(Empty, {
          title: '还没有审计项目',
          hint: '在 DSH 会话里打开源码，然后对 AI 说「审计当前项目」；它会自动调用插件并识别语言，结果会出现在这里。',
        });
      } else {
        recentBody = h('ul', { className: 'cau-recent' }, recent.map((project) => {
          const tone = project.status === 'failed' ? 'danger'
            : project.status === 'running' ? 'info'
              : project.status === 'completed' ? 'teal' : 'neutral';
          return h('li', { key: project.id },
            h('button', { type: 'button', className: 'cau-recent-main', onClick: () => openProject(project.id) },
              h('span', { className: 'cau-recent-name' }, project.name),
              h('span', { className: 'cau-recent-sub' }, `${project.language} · ${project.flow?.caption ?? ''}`)),
            h(StatusPill, { tone }, project.flow?.stepName ?? project.status));
        }));
      }

      let activeBody;
      if (active.length === 0) {
        activeBody = h('div', { className: 'cau-muted' }, '当前没有正在运行的审计。');
      } else {
        activeBody = h('div', { className: 'cau-active-list' }, active.map((project) => h('div', { key: project.id, className: 'cau-active-row' },
          h('div', { className: 'cau-active-info' },
            h('b', null, project.name),
            h('span', null, project.flow?.activity ?? '')),
          h('button', { type: 'button', className: 'cau-link', onClick: () => openProject(project.id) }, '查看流程'))));
      }

      const featured = projects.find((project) => project.status === 'running' || project.verifyStatus === 'running')
        ?? projects[0];
      let featuredFlow = null;
      if (featured !== undefined) {
        featuredFlow = h('section', { key: 'featured', className: 'cau-featured' },
          h('div', { className: 'cau-featured-head' },
            h('div', null,
              h('strong', null, '实时流程'),
              h('span', { className: 'cau-muted' }, ` · ${featured.name} · ${featured.flow?.caption ?? ''}`)),
            h(Btn, { small: true, variant: 'primary', onClick: () => openProject(featured.id) }, '打开项目')),
          h(AgentFlow, { project: featured, t, scheme }));
      }

      return h('div', { className: 'cau-page' },
        featuredFlow,
        statRow,
        h('div', { className: 'cau-grid cau-grid--2' },
          h(Card, { title: '危害分布' }, h('div', { className: 'cau-dist' }, distributionRows)),
          h(Card, { title: '最近项目', extra: h(Btn, { small: true, variant: 'ghost', onClick: () => go('projects') }, '查看全部') }, recentBody)),
        h(Card, { title: '进行中', extra: h(Btn, { small: true, variant: 'ghost', onClick: () => go('projects') }, '审计列表') }, activeBody));
    }

    function ProjectList({ state, t, openProject, act, bulkAction, refresh }) {
      const [query, setQuery] = useState('');
      const [status, setStatus] = useState('all');
      const [selected, setSelected] = useState(() => new Set());
      const projects = state.projects ?? [];
      const filtered = projects.filter((project) => {
        if (status !== 'all' && project.status !== status) return false;
        const text = `${project.name} ${project.language} ${project.sourceRef ?? ''}`.toLowerCase();
        return text.includes(query.trim().toLowerCase());
      });
      const toggle = (id) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelected(next);
      };
      const selectedIds = [...selected];
      return h('div', { className: 'cau-page' },
        h(Card, {
          title: '审计列表',
          extra: h('div', { className: 'cau-row-actions' },
            h(Btn, { small: true, onClick: () => refresh() }, '刷新'),
            h(Btn, { small: true, onClick: () => bulkAction('non-web') }, '批量清理非 Web'),
            h(Btn, { small: true, onClick: () => bulkAction('idle-envs') }, '清理闲置靶机')),
        },
          h('div', { className: 'cau-toolbar' },
            h('input', {
              className: 'cau-input cau-input--search',
              placeholder: '搜索名称 / 语言 / 来源',
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            h(Select, {
              value: status,
              onChange: setStatus,
              options: [['all', '全部状态'], ['pending', '待开始'], ['queued', '排队中'], ['running', '审计中'], ['paused', '已暂停'], ['completed', '已完成'], ['failed', '失败']],
            }),
            selectedIds.length === 0 ? h('span', { className: 'cau-muted' }, `共 ${filtered.length} 个项目`) : h('div', { className: 'cau-row-actions' },
              h(Btn, { small: true, onClick: () => selectedIds.forEach((id) => act(id, 'pause')) }, '暂停'),
              h(Btn, { small: true, onClick: () => selectedIds.forEach((id) => act(id, 'resume')) }, '继续'),
              h(Btn, { small: true, onClick: () => selectedIds.forEach((id) => act(id, 'rerun')) }, '重跑'),
              h(Btn, { small: true, variant: 'danger', onClick: () => selectedIds.forEach((id) => act(id, 'delete')) }, '删除'))),
          filtered.length === 0
            ? h(Empty, { title: '没有匹配的审计项目', hint: '在 DSH 会话里对 AI 说「审计当前项目」，插件会自动创建并识别语言。' })
            : h('div', { className: 'cau-table-wrap' }, h('table', { className: 'cau-table' },
              h('thead', null, h('tr', null,
                h('th', { className: 'cau-th-check' }),
                h('th', null, '项目'),
                h('th', null, '语言'),
                h('th', null, '状态'),
                h('th', null, '流程'),
                h('th', null, '漏洞'),
                h('th', null, '创建时间'),
                h('th', null, '操作'))),
              h('tbody', null, filtered.map((project) => h('tr', { key: project.id, className: selected.has(project.id) ? 'is-selected' : '' },
                h('td', null, h('input', { type: 'checkbox', checked: selected.has(project.id), onChange: () => toggle(project.id) })),
                h('td', null, h('button', { type: 'button', className: 'cau-link', onClick: () => openProject(project.id) }, project.name),
                  h('div', { className: 'cau-sub' }, project.sourceType === 'github' ? project.sourceRef : project.archiveName ?? '')),
                h('td', null, project.language),
                h('td', null, h(StatusPill, { tone: project.status === 'failed' ? 'danger' : project.status === 'running' ? 'info' : project.status === 'completed' ? 'teal' : 'neutral' }, project.flow?.stepName ?? project.status),
                  h('div', { className: 'cau-sub' }, project.flow?.caption ?? '')),
                h('td', null, h('div', { className: 'cau-mini-progress' }, h('i', { style: { width: `${project.flow?.progress ?? 0}%` } }))),
                h('td', null, h('span', { title: '严重/高危/中危/低危/提示' },
                  `${project.counts?.critical ?? 0}/${project.counts?.high ?? 0}/${project.counts?.medium ?? 0}/${project.counts?.low ?? 0}/${project.counts?.info ?? 0}`)),
                h('td', { className: 'cau-nowrap' }, String(project.createdAt ?? '').replace('T', ' ').slice(0, 16)),
                h('td', null, h('div', { className: 'cau-row-actions' },
                  project.status === 'running' || project.verifyStatus === 'running'
                    ? h(Btn, { small: true, onClick: () => act(project.id, 'pause') }, '暂停')
                    : h(Btn, { small: true, onClick: () => act(project.id, 'resume') }, '继续'),
                  h(Btn, { small: true, onClick: () => act(project.id, 'rerun') }, '重跑'),
                  h(Btn, { small: true, variant: 'danger', onClick: () => act(project.id, 'delete') }, '删除'))))))))));
    }

    function NewAudit({ t, onCreated, toast }) {
      const [tab, setTab] = useState('zip');
      const [language, setLanguage] = useState('php');
      const [runtime, setRuntime] = useState('full');
      const [aiDedup, setAiDedup] = useState(true);
      const [aiRegrade, setAiRegrade] = useState(true);
      const [verifyHistory, setVerifyHistory] = useState(false);
      const [file, setFile] = useState(null);
      const [progress, setProgress] = useState(0);
      const [busy, setBusy] = useState(false);
      const [repoUrl, setRepoUrl] = useState('');
      const [preview, setPreview] = useState(null);
      const [ref, setRef] = useState('');
      const [error, setError] = useState('');

      const options = { runtime, aiDedup, aiRegrade, verifyHistory };

      async function submitZip() {
        if (file === null) { setError('请选择 .zip 文件'); return; }
        setBusy(true);
        setError('');
        try {
          const uploaded = await uploadZip(file, setProgress);
          const created = await api.create({ sourceType: 'zip', uploadId: uploaded.uploadId, language, options });
          if (created.ok !== true) throw new Error(created.error ?? '创建失败');
          onCreated(created.project.id);
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy(false);
          setProgress(0);
        }
      }

      async function doPreview() {
        setBusy(true);
        setError('');
        try {
          const result = await api.preview(repoUrl);
          setPreview(result);
          setRef(result.latestTag ?? result.defaultRef ?? '');
        } catch (failure) {
          setError(failure.message);
          setPreview(null);
        } finally {
          setBusy(false);
        }
      }

      async function submitGithub() {
        if (preview === null) { setError('请先预览仓库'); return; }
        setBusy(true);
        setError('');
        try {
          const result = await api.create({ sourceType: 'github', previewId: preview.previewId, ref, language, options });
          if (result.ok !== true) throw new Error(result.error ?? '创建失败');
          onCreated(result.project.id);
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy(false);
        }
      }

      return h('div', { className: 'cau-page' },
        h('h2', { className: 'cau-page-title' }, '新建审计'),
        h('p', { className: 'cau-page-sub' }, '收下源码后会进入排队；轮到名额就真的创建审计会话并开工。'),
        h(Card, { title: '来源' },
          h('div', { className: 'cau-tabs' },
            h('button', { type: 'button', className: `cau-tab${tab === 'zip' ? ' is-active' : ''}`, onClick: () => setTab('zip') }, '上传 Zip'),
            h('button', { type: 'button', className: `cau-tab${tab === 'github' ? ' is-active' : ''}`, onClick: () => setTab('github') }, 'GitHub 仓库')),
          tab === 'zip'
            ? h('div', { className: 'cau-form' },
              h(Field, { label: '源码压缩包', hint: '只收 .zip；大包按数 GB 预留，不会被几 MB 截断。' },
                h('input', { type: 'file', accept: '.zip,application/zip', className: 'cau-input', onChange: (event) => setFile(event.target.files?.[0] ?? null) })),
              progress > 0 ? h('div', { className: 'cau-upload-progress' }, h(Progress, { value: progress }), h('span', null, `${progress}%`)) : null)
            : h('div', { className: 'cau-form' },
              h(Field, { label: '仓库地址', hint: 'https:// 或 git@；私有仓库沿用本机 git 凭据，不会发起扫码登录。' },
                h('input', { className: 'cau-input', value: repoUrl, onChange: (event) => setRepoUrl(event.target.value), placeholder: 'https://github.com/org/repo.git' })),
              h('div', null, h(Btn, { onClick: doPreview, disabled: busy || repoUrl.trim().length === 0 }, '预览仓库')),
              preview === null ? null : h('div', { className: 'cau-preview' },
                h('div', { className: 'cau-preview-title' }, `${preview.repo} · ${preview.tags.length} 个 tag`),
                h('div', { className: 'cau-muted' }, `最新 tag：${preview.latestTag ?? '无'}；HEAD：${preview.commit || '未知'}`),
                preview.duplicate === null ? null : h('div', { className: 'cau-warn' }, `同一版本已有审计：${preview.duplicate.name}（${preview.duplicate.version}）`),
                h(Field, { label: '审计版本' },
                  preview.tags.length > 0
                    ? h(Select, { value: ref, onChange: setRef, options: preview.tags.map((tag) => [tag.name, tag.name]) })
                    : h('input', { className: 'cau-input', value: ref, onChange: (event) => setRef(event.target.value), placeholder: '分支 / 提交号' })))),
          h('div', { className: 'cau-form-actions' },
            h(Btn, { variant: 'primary', disabled: busy || (tab === 'zip' ? file === null : preview === null), onClick: tab === 'zip' ? submitZip : submitGithub }, busy ? '提交中…' : '创建并排队'))),
        h(Card, { title: '本次流程' },
          h('div', { className: 'cau-form' },
            h('div', { className: 'cau-inline' },
              h('label', { className: 'cau-radio' }, h('input', { type: 'radio', checked: runtime === 'full', onChange: () => setRuntime('full') }), '完整靶机（Compose 整站 + 单洞 + 组合链）'),
              h('label', { className: 'cau-radio' }, h('input', { type: 'radio', checked: runtime === 'none', onChange: () => setRuntime('none') }), '仅代码审计（审完即止）')),
            h('div', { className: 'cau-inline' },
              h(Toggle, { checked: aiDedup, onChange: setAiDedup, label: 'AI 去重（代码级验证前合并重复上报）' }),
              h(Toggle, { checked: aiRegrade, onChange: setAiRegrade, label: '红队二次评级（按实战价值重定级，只降不升）' })),
            h('div', { className: 'cau-inline' },
              h(Toggle, { checked: verifyHistory, onChange: setVerifyHistory, label: '历史版本验证（默认关闭；用已发现漏洞去打其它版本）' })))),
        h(Card, { title: '审计语言' },
          h('div', { className: 'cau-langs' }, LANGUAGES.map(([value, label]) => h('button', {
            key: value,
            type: 'button',
            className: `cau-lang${language === value ? ' is-active' : ''}`,
            onClick: () => setLanguage(value),
          }, label)))),
        error.length > 0 ? h('div', { className: 'cau-error' }, error) : null);
    }

    function ProjectDetail({ projectId, summary, detail, events, t, act, rerunStage, toast }) {
      const [tab, setTab] = useState('flow');
      const [confirm, setConfirm] = useState(null);
      const project = detail ?? summary;
      if (project === undefined || project === null) return h(Spinner, { label: '加载项目…' });
      const findings = (detail?.findings ?? []).slice().sort((left, right) => (SEVERITY_RANK[right.severity] ?? 0) - (SEVERITY_RANK[left.severity] ?? 0));
      const flow = project.flow ?? summary?.flow;
      const tabs = [
        ['flow', t('detail.flow')],
        ['events', `事件${events.length > 0 ? ` · ${events.length}` : ''}`],
        ['findings', `漏洞${findings.length > 0 ? ` · ${findings.length}` : ''}`],
        ['report', t('detail.report')],
        ['stages', t('detail.stages')],
      ];
      return h('div', { className: 'cau-page' },
        h('div', { className: 'cau-detail-head' },
          h('div', null,
            h('h2', { className: 'cau-page-title' }, project.name),
            h('div', { className: 'cau-page-sub' }, [
              project.sourceType === 'github' || project.sourceType === 'workspace' ? project.sourceRef : project.archiveName ?? '',
              project.sourceVersion ? `版本 ${project.sourceVersion}` : '版本未标记',
              project.language,
            ].filter(Boolean).join(' · '))),
          h('div', { className: 'cau-row-actions' },
            project.status === 'running' || project.verifyStatus === 'running'
              ? h(Btn, { onClick: () => act(project.id, 'pause') }, '暂停')
              : h(Btn, { onClick: () => act(project.id, 'resume') }, '继续'),
            h(Btn, { onClick: () => setConfirm({ action: 'rerun', title: '重跑整个项目', text: '将清空已有漏洞与阶段结果，重新开始。' }) }, '重跑'),
            h(Btn, { variant: 'danger', onClick: () => setConfirm({ action: 'delete', title: '删除项目', text: '删除后进入回收站，不提供还原。' }) }, '删除'))),
        h('div', { className: 'cau-detail-meta' },
          h(StatusPill, { tone: project.status === 'failed' ? 'danger' : project.status === 'running' ? 'info' : project.status === 'completed' ? 'teal' : 'neutral' }, project.flow?.caption ?? project.status),
          project.errorMessage ? h('span', { className: 'cau-error-inline' }, project.errorMessage) : null,
          h('span', { className: 'cau-muted' }, `严重 ${project.counts?.critical ?? 0} · 高危 ${project.counts?.high ?? 0} · 中危 ${project.counts?.medium ?? 0} · 低危 ${project.counts?.low ?? 0} · 提示 ${project.counts?.info ?? 0}`),
          project.targetUrl ? h('a', { className: 'cau-link', href: project.targetUrl, target: '_blank', rel: 'noreferrer' }, `靶机 ${project.targetUrl}`) : null,
          project.frontendRce === true ? h(StatusPill, { tone: 'danger' }, '前台 RCE') : null),
        h('div', { className: 'cau-tabs cau-tabs--underline' }, tabs.map(([key, label]) => h('button', {
          key, type: 'button', className: `cau-tab${tab === key ? ' is-active' : ''}`, onClick: () => setTab(key),
        }, label))),
        tab === 'flow' ? h(AgentFlow, { project: { ...project, flow }, t, scheme: 'light' }) : null,
        tab === 'events' ? h(EventFeed, { events, t }) : null,
        tab === 'findings' ? h(FindingsTable, { findings, t }) : null,
        tab === 'report' ? h(ReportPane, { project, detail, act, toast }) : null,
        tab === 'stages' ? h(StageRerun, { project, act: rerunStage }) : null,
        h(Modal, {
          open: confirm !== null,
          title: confirm?.title ?? '',
          onClose: () => setConfirm(null),
          footer: h('div', { className: 'cau-row-actions' },
            h(Btn, { onClick: () => setConfirm(null) }, '取消'),
            h(Btn, { variant: 'danger', onClick: () => { act(project.id, confirm.action); setConfirm(null); } }, '确认')),
        }, h('p', null, confirm?.text ?? '')));
    }

    function formatTime(value) {
      const text = String(value ?? '');
      const match = text.match(/T(\d{2}:\d{2}:\d{2})/u);
      return match === null ? text.slice(11, 19) : match[1];
    }

    function EventFeed({ events, t }) {
      const [phase, setPhase] = useState('all');
      const [follow, setFollow] = useState(true);
      const listRef = useRef(null);
      const filtered = events.filter((event) => phase === 'all' || event.phase === phase);
      useEffect(() => {
        if (follow && listRef.current !== null) listRef.current.scrollTop = listRef.current.scrollHeight;
      }, [filtered.length, follow]);
      return h(Card, {
        title: '过程回放',
        extra: h('div', { className: 'cau-row-actions' },
          ['all', 'audit', 'verify'].map((value) => h('button', {
            key: value, type: 'button', className: `cau-chip${phase === value ? ' is-active' : ''}`, onClick: () => setPhase(value),
          }, value === 'all' ? '全部' : value === 'audit' ? '审计' : '验证')),
          h(Toggle, { checked: follow, onChange: setFollow, label: '跟随最新' })),
      }, filtered.length === 0
        ? h(Empty, { title: '还没有过程事件', hint: '审计开始后，子智能体的工具调用与对话会出现在这里。' })
        : h('div', { className: 'cau-events', ref: listRef }, filtered.map((event) => h('div', { key: `${event.seq}-${event.ts}`, className: `cau-event cau-event--${event.kind}` },
          h('span', { className: 'cau-event-time' }, formatTime(event.at ?? event.ts)),
          h('span', { className: `cau-event-phase cau-event-phase--${event.phase}` }, event.phase === 'verify' ? '验证' : '审计'),
          h('span', { className: 'cau-event-text' }, event.text ?? '')))));
    }

    function FindingsTable({ findings, t }) {
      const [open, setOpen] = useState(null);
      if (findings.length === 0) {
        return h(Empty, { title: '还没有漏洞', hint: '多智能体审计完成后，通过代码级验证的漏洞会出现在这里。' });
      }
      return h('div', { className: 'cau-findings' }, findings.map((finding) => {
        const expanded = open === finding.id;
        return h('article', { key: finding.id, className: `cau-finding${expanded ? ' is-open' : ''}` },
          h('button', { type: 'button', className: 'cau-finding-head', onClick: () => setOpen(expanded ? null : finding.id) },
            h(SeverityBadge, { severity: finding.severity }),
            h('span', { className: 'cau-finding-title' }, finding.title),
            h('span', { className: 'cau-finding-file' }, `${finding.file}${finding.line === null || finding.line === undefined ? '' : `:${finding.line}`}`),
            h('span', { className: 'cau-finding-tags' },
              h('span', { className: 'cau-tag' }, finding.category),
              h('span', { className: `cau-tag${finding.verified === true ? ' cau-tag--ok' : finding.codeVerified === true ? ' cau-tag--partial' : ''}` },
                finding.verified === true ? '靶机已验证' : finding.codeVerified === true ? '代码级已验证' : '仅代码发现'),
              h('span', { className: 'cau-tag' }, AUTH_LABEL[finding.authRequired] ?? finding.authRequired))),
          expanded ? h('div', { className: 'cau-finding-body' },
            h('dl', { className: 'cau-dl' },
              h('dt', null, '编号'), h('dd', null, finding.id),
              h('dt', null, '原始严重度'), h('dd', null, finding.severityOriginal === null ? '—' : SEVERITY_LABEL[finding.severityOriginal] ?? finding.severityOriginal),
              h('dt', null, '实战评级'), h('dd', null, finding.regradeValue ?? '—'),
              h('dt', null, '入口'), h('dd', null, finding.entry || '—')),
            h('h4', null, '漏洞描述'),
            h('p', null, finding.description || '（未提供）'),
            finding.taintChain ? h('div', null, h('h4', null, '污点链'), h('pre', null, finding.taintChain)) : null,
            finding.codeSnippet ? h('div', null, h('h4', null, '关键代码'), h('pre', null, finding.codeSnippet)) : null,
            h('h4', null, '修复建议'),
            h('p', null, finding.recommendation || '（未提供）'),
            finding.regradeReason ? h('div', null, h('h4', null, '二次评级理由'), h('p', null, finding.regradeReason)) : null,
            finding.codeVerifyReason ? h('div', null, h('h4', null, '代码级验证结论'), h('p', null, finding.codeVerifyReason)) : null,
            finding.evidence?.request ? h('div', null, h('h4', null, '靶机验证证据'), h('pre', null, `请求：\n${finding.evidence.request}\n\n响应：\n${finding.evidence.response ?? ''}`)) : null)
            : null);
      }));
    }

    function ReportPane({ project, detail, act, toast }) {
      const report = project.report ?? detail?.report ?? null;
      const links = [];
      if (report !== null) {
        links.push(h('a', {
          key: 'html',
          className: 'cau-btn cau-btn--sm',
          href: `/codeaudit/api/projects/${encodeURIComponent(project.id)}/report?format=html`,
          target: '_blank',
          rel: 'noreferrer',
        }, '打开 HTML'));
        links.push(h('a', {
          key: 'md',
          className: 'cau-btn cau-btn--sm',
          href: `/codeaudit/api/projects/${encodeURIComponent(project.id)}/report?format=md`,
          target: '_blank',
          rel: 'noreferrer',
        }, '查看 Markdown'));
      }
      const actions = h('div', { className: 'cau-row-actions' },
        h(Btn, {
          variant: 'primary',
          onClick: async () => {
            const result = await act(project.id, 'generate-report');
            if (result !== null && result !== undefined && result.report !== undefined) toast('报告已生成', 'ok');
          },
        }, report === null ? '生成报告' : '重新生成'),
        links);
      const body = h('div', { className: 'cau-form' },
        h('p', { className: 'cau-muted' }, report === null
          ? '报告尚未生成。审计完成时会自动生成，也可以手动生成。'
          : `最近生成：${report.generatedAt}`),
        actions);
      return h(Card, { title: '审计报告' }, body);
    }

    function StageRerun({ project, act }) {
      const [busy, setBusy] = useState('');
      const rows = [...AUDIT_STAGES.filter((stage) => stage.key !== 'done').map((stage) => ({ ...stage, phase: 'audit' })),
        ...VERIFY_STAGES.filter((stage) => stage.key !== 'vdone').map((stage) => ({ ...stage, phase: 'verify' }))];
      async function run(stage) {
        setBusy(stage.key);
        try {
          await act(project.id, stage.key);
        } finally {
          setBusy('');
        }
      }
      return h(Card, { title: '分环节重跑' },
        h('p', { className: 'cau-muted' }, '从某个环节开始重跑会重置该环节及其下游产物；已完成的更早环节会复用。'),
        h('div', { className: 'cau-stage-list' }, rows.map((stage) => {
          const status = project.stageStatus?.[stage.key] ?? 'pending';
          return h('div', { key: stage.key, className: 'cau-stage-row' },
            h('span', { className: 'cau-stage-name' }, stage.label),
            h('span', { className: `cau-stage-status cau-stage-status--${status}` }, STAGE_STATUS_LABEL[status] ?? status),
            h('span', { className: 'cau-stage-phase' }, stage.phase === 'audit' ? '代码审计' : '靶机验证'),
            h(Btn, { small: true, disabled: busy === stage.key, onClick: () => run(stage) }, busy === stage.key ? '提交中…' : '从本环节重跑'));
        })));
    }

    function MonitorPage({ state, t, toast, refresh }) {
      const [repoUrl, setRepoUrl] = useState('');
      const [prefix, setPrefix] = useState('');
      const [intervalMin, setIntervalMin] = useState(30);
      const [busy, setBusy] = useState(false);
      const monitors = state.monitors ?? [];

      async function add() {
        setBusy(true);
        try {
          await api.monitorAdd({ repoUrl, projectPrefix: prefix, intervalMin });
          setRepoUrl('');
          setPrefix('');
          toast('监控已添加', 'ok');
          refresh();
        } catch (failure) {
          toast(failure.message, 'error');
        } finally {
          setBusy(false);
        }
      }

      async function onCheck(monitor) {
        try {
          const result = await api.monitorCheck(monitor.id);
          toast(result.triggered ? `发现新版本 ${result.latestTag}` : '没有新版本', 'ok');
          refresh();
        } catch (failure) {
          toast(failure.message, 'error');
        }
      }

      async function onToggle(monitor) {
        try {
          await api.monitorUpdate(monitor.id, { enabled: monitor.enabled !== true });
          refresh();
        } catch (failure) {
          toast(failure.message, 'error');
        }
      }

      async function onDelete(monitor) {
        try {
          await api.monitorDelete(monitor.id);
          refresh();
        } catch (failure) {
          toast(failure.message, 'error');
        }
      }

      const form = h('div', { className: 'cau-form cau-form--inline' },
        h(Field, { label: '仓库地址', wide: true },
          h('input', { className: 'cau-input', value: repoUrl, onChange: (event) => setRepoUrl(event.target.value), placeholder: 'https://github.com/org/repo.git' })),
        h(Field, { label: '名称前缀' },
          h('input', { className: 'cau-input', value: prefix, onChange: (event) => setPrefix(event.target.value), placeholder: '默认取仓库名' })),
        h(Field, { label: '间隔（分钟）' },
          h('input', { className: 'cau-input', type: 'number', min: 5, max: 1440, value: intervalMin, onChange: (event) => setIntervalMin(Number(event.target.value)) })),
        h('div', { className: 'cau-form-actions' },
          h(Btn, { variant: 'primary', disabled: busy || repoUrl.trim().length === 0, onClick: add }, busy ? '添加中…' : '添加监控')));

      let list;
      if (monitors.length === 0) {
        list = h(Empty, { title: '还没有监控', hint: '添加一个仓库后，插件会按间隔检查新版本。' });
      } else {
        const rows = monitors.map((monitor) => h('tr', { key: monitor.id },
          h('td', null, monitor.repoUrl),
          h('td', null, monitor.projectPrefix),
          h('td', null, monitor.lastReleaseTag ?? '未知'),
          h('td', null, `${monitor.intervalMin} 分钟`),
          h('td', null, monitor.lastChecked ? new Date(monitor.lastChecked).toLocaleString() : '—'),
          h('td', null, h('div', { className: 'cau-row-actions' },
            h(Btn, { small: true, onClick: () => onCheck(monitor) }, '立即检查'),
            h(Btn, { small: true, onClick: () => onToggle(monitor) }, monitor.enabled === true ? '停用' : '启用'),
            h(Btn, { small: true, variant: 'danger', onClick: () => onDelete(monitor) }, '删除')))));
        list = h('div', { className: 'cau-table-wrap' }, h('table', { className: 'cau-table' },
          h('thead', null, h('tr', null,
            h('th', null, '仓库'), h('th', null, '前缀'), h('th', null, '最新 tag'),
            h('th', null, '间隔'), h('th', null, '上次检查'), h('th', null, '操作'))),
          h('tbody', null, rows)));
      }

      return h('div', { className: 'cau-page' },
        h(Card, { title: '监控' },
          h('p', { className: 'cau-muted' }, '按间隔检查仓库的新 tag；发现新版本时新建一次审计，不改动旧项目。'),
          form,
          list));
    }

    function RecyclePage({ state }) {
      const rows = state.recycle ?? [];
      let body;
      if (rows.length === 0) {
        body = h(Empty, { title: '回收站为空' });
      } else {
        const trs = rows.map((row) => h('tr', { key: row.id },
          h('td', null, row.name),
          h('td', { className: 'cau-nowrap' }, row.sourceLink ?? row.sourceRef ?? ''),
          h('td', null, String(row.vulnCount ?? 0)),
          h('td', null, row.reason === 'bulk' ? '批量清理' : row.reason === 'non-web' ? '自动清理' : '手动删除'),
          h('td', { className: 'cau-nowrap' }, row.deletedAt ? new Date(row.deletedAt).toLocaleString() : '—')));
        body = h('div', { className: 'cau-table-wrap' }, h('table', { className: 'cau-table' },
          h('thead', null, h('tr', null,
            h('th', null, '名称'), h('th', null, '来源'), h('th', null, '漏洞数'),
            h('th', null, '原因'), h('th', null, '时间'))),
          h('tbody', null, trs)));
      }
      return h('div', { className: 'cau-page' },
        h(Card, { title: '回收站' },
          h('p', { className: 'cau-muted' }, '删除的项目只保留快照记录，默认不提供还原。'),
          body));
    }

    function SettingsPage({ state, t, toast, refresh }) {
      const [form, setForm] = useState(state.settings ?? {});
      const [saving, setSaving] = useState(false);
      const [test, setTest] = useState(null);

      useEffect(() => { setForm(state.settings ?? {}); }, [state.settings]);

      const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));

      async function save() {
        setSaving(true);
        try {
          const result = await api.saveSettings(form);
          setForm(result.settings);
          toast('设置已保存', 'ok');
          refresh();
        } catch (failure) {
          toast(failure.message, 'error');
        } finally {
          setSaving(false);
        }
      }

      async function runTest() {
        setTest({ pending: true });
        try {
          const result = await api.testSettings();
          setTest(result);
        } catch (failure) {
          setTest({ ok: false, error: failure.message });
        }
      }

      const numberField = (key, label, hint) => h(Field, { key, label, hint },
        h('input', {
          className: 'cau-input',
          type: 'number',
          value: form[key] ?? '',
          onChange: (event) => set(key)(Number(event.target.value)),
        }));

      const globalCard = h(Card, { key: 'global', title: '运行总闸' },
        h('div', { className: 'cau-form' },
          h(Toggle, {
            checked: form.globalEnabled !== false,
            onChange: set('globalEnabled'),
            label: '总闸开启（关闭后不再入队、不触发监控，正在跑的会暂停）',
          }),
          h(Toggle, {
            checked: form.protectPages === true,
            onChange: set('protectPages'),
            label: '保护页面（资源紧张时少开新任务，不中途杀掉已在跑的）',
          })));

      const limitsCard = h(Card, { key: 'limits', title: '并发与超时' },
        h('div', { className: 'cau-form cau-form--grid' },
          numberField('maxConcurrentAudit', '同时进行的代码审计', '默认 5，最多 10'),
          numberField('maxConcurrentVerify', '同时进行的靶机验证', '默认 5'),
          numberField('maxConcurrentEnv', '同时搭建的靶机环境', '默认 5，不占审计名额'),
          numberField('maxConcurrentChildren', '全局子智能体上限', '默认 24'),
          numberField('laneConcurrency', '单环节并行路数', 'DSH 每树默认上限 8'),
          numberField('laneBatchSize', '去重/验证/评级每批条数', '默认 10'),
          numberField('dedupeThreshold', 'AI 去重候选门槛', '低于门槛只做机械去重'),
          numberField('stageTimeoutMs', '单阶段最长运行（毫秒）', '默认 90 分钟'),
          numberField('idleTimeoutMs', '连续无输出（毫秒）', '默认 25 分钟'),
          numberField('verifyTimeoutMs', '单漏洞验证总时长（毫秒）', '默认 15 分钟'),
          numberField('verifyIdleTimeoutMs', '单漏洞无输出（毫秒）', '默认 5 分钟'),
          numberField('finishGraceMs', '收尾宽限（毫秒）', '默认 2 分钟'),
          numberField('historyMaxVersions', '历史版本最多验证数', '默认 3'),
          numberField('monitorIntervalMin', '监控默认间隔（分钟）', '默认 30')));

      const promptsCard = h(Card, { key: 'prompts', title: '提示词' },
        h('div', { className: 'cau-form' },
          h(Field, { label: '审计提示词追加', hint: '追加到每个审计阶段的系统提示末尾，不要覆盖结构化输出契约。', wide: true },
            h('textarea', {
              className: 'cau-input cau-textarea',
              rows: 5,
              value: form.auditPromptExtra ?? '',
              onChange: (event) => set('auditPromptExtra')(event.target.value),
            })),
          h(Field, { label: '验证提示词追加', wide: true },
            h('textarea', {
              className: 'cau-input cau-textarea',
              rows: 5,
              value: form.verifyPromptExtra ?? '',
              onChange: (event) => set('verifyPromptExtra')(event.target.value),
            }))));

      let testResult = null;
      if (test !== null) {
        if (test.pending === true) testResult = h('span', { className: 'cau-muted' }, '测试中…');
        else if (test.ok === true) testResult = h('span', { className: 'cau-ok' }, `可用：${test.provider} / ${test.model}（${test.models} 个模型，${test.latencyMs}ms）`);
        else testResult = h('span', { className: 'cau-error-inline' }, `不可用：${test.error}`);
      }

      const modelCard = h(Card, { key: 'model', title: '模型与网关' },
        h('div', { className: 'cau-form' },
          h('p', { className: 'cau-muted' }, `当前 DSH 模型：${state.capabilities?.model ?? '未知'}。网关与密钥沿用 DSH 的模型设置，插件不另存密钥。`),
          h(Field, { label: '模型覆盖（provider:model）', hint: '留空表示跟随 DSH 默认；例如 deepseek-official:deepseek-flash-cyber。' },
            h('input', {
              className: 'cau-input',
              value: form.modelOverride ?? '',
              onChange: (event) => set('modelOverride')(event.target.value),
              placeholder: 'provider:model',
            })),
          h('div', { className: 'cau-row-actions' },
            h(Btn, { onClick: runTest }, '连通测试'),
            testResult)));

      const dataCard = h(Card, { key: 'data', title: '数据目录' },
        h('div', { className: 'cau-form' },
          h('code', { className: 'cau-code' }, state.capabilities?.dataDir ?? '—'),
          h('p', { className: 'cau-muted' }, '源码、事件、证据与报告都在这个目录下；项目记录保存源码文件的位置。')));

      const actions = h('div', { key: 'actions', className: 'cau-form-actions' },
        h(Btn, { variant: 'primary', disabled: saving, onClick: save }, saving ? '保存中…' : '保存设置'));

      return h('div', { className: 'cau-page' },
        globalCard, limitsCard, promptsCard, modelCard, dataCard, actions);
    }

    class ConsoleBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        try {
          console.error('code-audit console crashed', error, info);
        } catch {
          /* console may be unavailable */
        }
        beacon('render-error', { message: String(error?.message ?? error) });
      }
      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'cau-root' },
            h(StyleSheet, null),
            h('div', { className: 'cau-page' },
              h(Card, { title: '控制台渲染出错' },
                h('p', null, String(this.state.error?.message ?? this.state.error)),
                h('p', { className: 'cau-muted' }, '请刷新页面；若仍然失败，请把这条信息反馈给插件维护者。'))));
        }
        return this.props.children;
      }
    }

    function ConsoleHost(props) {
      // `openPanel` / `closeRightbar` are forwarded from apply.
      const [scheme, setScheme] = useState(() => (props.readScheme ? props.readScheme() : 'light'));
      useEffect(() => {
        if (typeof props.subscribeScheme !== 'function') return undefined;
        const dispose = props.subscribeScheme(setScheme);
        return typeof dispose === 'function' ? dispose : undefined;
      }, []);
      return h(Console, { ...props, scheme });
    }

    function Console({ t, scheme, readScheme, subscribeScheme, openPanel, closeRightbar, variant, sessionId }) {
      const [state, setState] = useState({ projects: [], monitors: [], recycle: [], settings: {}, counts: {}, capabilities: null, loaded: false });
      const [projectId, setProjectId] = useState(null);
      const [detail, setDetail] = useState(null);
      const [detailRev, setDetailRev] = useState(0);
      const [events, setEvents] = useState([]);
      const [toast, setToast] = useState(null);
      const [loadError, setLoadError] = useState('');
      const [streamState, setStreamState] = useState('connecting');
      const detailRef = useRef(null);
      const bootSelected = useRef(false);
      const sessionCwdRef = useRef('');
      const detailTimer = useRef(null);
      const toastTimer = useRef(null);

      const showToast = (message, tone = 'info') => {
        setToast({ message, tone, at: Date.now() });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 4200);
      };

      const refreshState = () => api.state()
        .then((snapshot) => { setState({ ...snapshot, loaded: true }); showToast('已刷新', 'ok'); })
        .catch((failure) => showToast(failure.message, 'error'));

      useEffect(() => {
        beacon('console-mount', { variant: variant ?? 'panel', sessionId: sessionId ?? null });
      }, []);

      useEffect(() => {
        // The session-header view is narrower; give the graph the whole column by
        // closing the right file sidebar once when it opens.
        if (variant !== 'view') return undefined;
        if (typeof closeRightbar === 'function') closeRightbar();
        return undefined;
      }, [variant]);

      useEffect(() => {
        beacon('project', { projectId, sessionId: sessionId ?? null });
      }, [projectId]);

      const mergeProject = (project) => {
        setState((current) => {
          const rest = current.projects.filter((row) => row.id !== project.id);
          return { ...current, projects: [project, ...rest].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0)) };
        });
        if (detailRef.current !== null && detailRef.current.id === project.id) {
          if (detailTimer.current) clearTimeout(detailTimer.current);
          detailTimer.current = setTimeout(() => setDetailRev((value) => value + 1), 500);
        }
      };

      useEffect(() => {
        let alive = true;
        api.state().then((snapshot) => {
          if (!alive) return;
          setLoadError('');
          setState({ ...snapshot, loaded: true });
          beacon('state-ok', { projects: Array.isArray(snapshot.projects) ? snapshot.projects.length : -1 });
          const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
          if (bootSelected.current !== true) {
            bootSelected.current = true;
            if (typeof sessionId === 'string' && sessionId.length > 0) {
              const own = projects.find((project) => project.sessionId === sessionId);
              if (own !== undefined) {
                setProjectId(own.id);
              } else {
                // No audit bound to this Session yet: show the newest/running
                // one, then prefer an audit whose workspace is this Session's
                // working directory (legacy projects have no sessionId).
                const fallback = projects.find((project) => project.status === 'running' || project.verifyStatus === 'running') ?? projects[0];
                if (fallback !== undefined) setProjectId(fallback.id);
                api.session(sessionId).then((info) => {
                  const cwd = typeof info?.cwd === 'string' ? info.cwd : '';
                  if (cwd.length === 0) return;
                  sessionCwdRef.current = cwd;
                  const normalize = (value) => String(value).replace(/^\/private(?=\/)/u, '');
                  const bySource = projects.find((project) => (
                    project.sourceType === 'workspace'
                    && normalize(project.sourceRef) === normalize(cwd)
                  ));
                  if (bySource !== undefined) setProjectId(bySource.id);
                }).catch(() => undefined);
              }
            } else {
              const preferred = projects.find((project) => project.status === 'running' || project.verifyStatus === 'running') ?? projects[0];
              if (preferred !== undefined) setProjectId(preferred.id);
            }
          }
        }).catch((error) => {
          if (alive) setLoadError(error.message);
          beacon('state-error', { message: String(error.message) });
          showToast(`控制台状态加载失败：${error.message}`, 'error');
        });
        return () => { alive = false; };
      }, []);

      useEffect(() => {
        if (typeof EventSource === 'undefined') {
          const timer = setInterval(() => { api.state().then((snapshot) => setState({ ...snapshot, loaded: true })).catch(() => undefined); }, 2500);
          return () => clearInterval(timer);
        }
        let source = null;
        let closed = false;
        let failures = 0;
        let pollTimer = null;
        const startPolling = () => {
          if (pollTimer !== null) return;
          pollTimer = setInterval(() => { api.state().then((snapshot) => setState({ ...snapshot, loaded: true })).catch(() => undefined); }, 2500);
        };
        const connect = () => {
          if (closed) return;
          source = new EventSource('/codeaudit/api/stream');
          source.onopen = () => {
            failures = 0;
            setStreamState('live');
            beacon('sse-open');
          };
          source.onerror = () => {
            failures += 1;
            setStreamState('reconnecting');
            if (failures >= 3) startPolling();
          };
          source.onmessage = (event) => {
            let frame;
            try {
              frame = JSON.parse(event.data);
            } catch {
              return;
            }
            if (frame.type === 'snapshot') {
              setState({ ...frame.state, loaded: true });
              return;
            }
            if (frame.type === 'project') {
              mergeProject(frame.project);
              if (typeof sessionId === 'string' && sessionId.length > 0) {
                const normalize = (value) => String(value).replace(/^\/private(?=\/)/u, '');
                if (frame.project.sessionId === sessionId) {
                  setProjectId(frame.project.id);
                } else if (sessionCwdRef.current.length > 0
                  && frame.project.sourceType === 'workspace'
                  && normalize(frame.project.sourceRef) === normalize(sessionCwdRef.current)) {
                  setProjectId(frame.project.id);
                }
              } else {
                setProjectId((current) => current ?? frame.project.id);
              }
              return;
            }
            if (frame.type === 'events') {
              const projectId = frame.projectId;
              if (detailRef.current !== null && detailRef.current.id === projectId) {
                setEvents((current) => {
                  const seen = new Set(current.map((row) => row.seq));
                  const next = [...current, ...frame.events.filter((row) => !seen.has(row.seq))];
                  return next.slice(-1000);
                });
              }
              return;
            }
            if (frame.type === 'meta') {
              setState((current) => ({ ...current, monitors: frame.monitors ?? current.monitors, recycle: frame.recycle ?? current.recycle }));
              return;
            }
            if (frame.type === 'notice') {
              showToast(frame.message, frame.tone === 'error' ? 'error' : 'info');
            }
            if (frame.type === 'open-panel') {
              beacon('open-panel-frame');
              if (typeof openPanel === 'function') openPanel();
            }
          };
        };
        connect();
        return () => {
          closed = true;
          try { source?.close(); } catch { /* ignore */ }
          if (pollTimer !== null) clearInterval(pollTimer);
        };
      }, []);

      useEffect(() => {
        if (projectId === null) {
          detailRef.current = null;
          setDetail(null);
          setEvents([]);
          return undefined;
        }
        let alive = true;
        const id = projectId;
        Promise.all([api.project(id), api.events(id, 500)])
          .then(([project, eventPage]) => {
            if (!alive) return;
            detailRef.current = project;
            setDetail(project);
            setEvents(eventPage.events ?? []);
          })
          .catch((error) => showToast(`项目加载失败：${error.message}`, 'error'));
        return () => { alive = false; };
      }, [projectId, detailRev]);

      async function act(id, action) {
        try {
          const result = await api.action(id, action);
          if (action === 'delete') {
            showToast('已删除', 'ok');
            const rest = state.projects.filter((project) => project.id !== id);
            setProjectId(rest.length > 0 ? rest[0].id : null);
          } else if (action === 'pause') {
            showToast('已暂停', 'ok');
          } else if (action === 'resume') {
            showToast('已继续', 'ok');
          } else if (action === 'rerun') {
            showToast('已重新排队', 'ok');
          } else {
            showToast('操作已提交', 'ok');
          }
          setDetailRev((value) => value + 1);
          return result;
        } catch (failure) {
          showToast(failure.message, 'error');
          return null;
        }
      }

      async function rerunStage(id, stage) {
        try {
          await api.stage(id, stage, 'from');
          showToast(`已排入重跑：${stage}`, 'ok');
          setDetailRev((value) => value + 1);
        } catch (failure) {
          showToast(failure.message, 'error');
        }
      }

      const summary = projectId === null ? undefined : state.projects.find((project) => project.id === projectId);
      const hasProjects = state.projects.length > 0;

      let content;
      if (projectId !== null && (summary !== undefined || detail !== null)) {
        content = h(ProjectDetail, {
          projectId,
          summary,
          detail: detail !== null && detail.id === projectId ? detail : null,
          events,
          t,
          act,
          rerunStage,
          toast: showToast,
        });
      } else {
        content = h(Empty, {
          title: hasProjects ? '选择要查看的审计' : '还没有审计项目',
          hint: hasProjects
            ? '从右上角的项目选择器切换审计。'
            : '在 DSH 会话里打开源码，然后对 AI 说「审计当前项目」；插件会自动调用工具、识别语言并开始审计，实时流程会显示在这里。',
        });
      }

      if (state.loaded !== true) {
        const retry = () => {
          setLoadError('');
          api.state().then((snapshot) => { setState({ ...snapshot, loaded: true }); })
            .catch((error) => setLoadError(error.message));
        };
        return h('div', { className: 'cau-root' },
          h(StyleSheet, null),
          loadError.length === 0
            ? h(Spinner, { label: '加载控制台…' })
            : h('div', { className: 'cau-page' },
              h(Card, { title: '控制台状态加载失败' },
                h('p', null, loadError),
                h('p', { className: 'cau-muted' }, '请确认插件已启用，然后重试；必要时刷新页面。'),
                h(Btn, { onClick: retry }, '重试'))));
      }

      return h('div', { className: `cau-root${variant === 'view' ? ' cau-root--view' : ''}` },
        h(StyleSheet, null),
        h('main', { className: 'cau-main' },
          h('header', { className: 'cau-topbar' },
            h('div', null, h('h1', null, t('panel.title')), h('span', { className: 'cau-muted' }, '本地多智能体源码审计')),
            h('div', { className: 'cau-top-actions' },
              h('span', { className: `cau-stream cau-stream--${streamState}` }, streamState === 'live' ? '实时已连接' : streamState === 'reconnecting' ? '实时重连中' : '连接中'),
              h(Btn, { onClick: refreshState }, '刷新'))),
          h('div', { className: 'cau-content' }, content)),
        toast === null ? null : h('div', { className: `cau-toast cau-toast--${toast.tone}` }, toast.message));
    }

    function StyleSheet() {
      return h('style', null, CSS);
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const CSS = `
.cau-root {
  /* Blend with the DSH theme: no own background, all colors come from tokens. */
  --canvas: transparent;
  --card: transparent;
  --soft: color-mix(in srgb, var(--dsw-alias-label-primary, #1a1a1a) 6%, transparent);
  --ink: var(--dsw-alias-label-primary, #1a1a1a);
  --body: var(--dsw-alias-label-primary, #333333);
  --muted: var(--dsw-alias-label-secondary, #777777);
  --primary: var(--dsw-alias-brand-primary, #3b82f6);
  --primary-soft: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 12%, transparent);
  --teal: var(--dsw-alias-state-success-primary, #1a9b74);
  --hairline: var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  --line: var(--dsw-alias-border-l2, rgba(127,127,127,.4));
  --danger: var(--dsw-alias-state-error-primary, #d64545);
  --warning: var(--dsw-alias-state-warn-primary, #b97b0a);
  --text: var(--dsw-alias-label-primary, #1a1a1a);
  --serif: Georgia, "Songti SC", "Times New Roman", serif;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
  position: relative; display: flex; height: 100%; min-height: 560px; overflow: hidden;
  background: transparent; color: var(--body); font-family: var(--sans); font-size: 13px;
  color-scheme: inherit;
}
.cau-root * { box-sizing: border-box; }
.cau-nav { width: 206px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--hairline); background: var(--card); }
.cau-brand { display: flex; align-items: center; gap: 10px; padding: 18px 16px 14px; }
.cau-brand-mark { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, #3b82f6, #7fb0ff); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 18px; box-shadow: 0 6px 16px rgba(59,130,246,.3); }
.cau-brand b { display: block; font-family: var(--serif); font-size: 16px; letter-spacing: .02em; }
.cau-brand span { display: block; font-size: 10px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; }
.cau-nav nav { display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; }
.cau-nav-item { text-align: left; border: 0; background: transparent; color: var(--body); padding: 9px 12px; border-radius: 9px; font-size: 13px; cursor: pointer; font-family: var(--sans); }
.cau-nav-item:hover { background: var(--soft); color: var(--ink); }
.cau-nav-item.is-active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.cau-root--view .cau-nav--compact { width: 172px; }
.cau-root--view .cau-brand { padding: 14px 12px 10px; }
.cau-root--view .cau-brand span { display: none; }
.cau-root--view .cau-nav-item { padding: 8px 10px; font-size: 12.5px; }
.cau-root--view .cau-content { padding: 18px 18px 48px; }
.cau-nav-foot { margin-top: auto; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
.cau-stream::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 6px; background: var(--muted); vertical-align: middle; }
.cau-stream--live::before { background: var(--teal); box-shadow: 0 0 0 3px color-mix(in srgb, var(--teal) 18%, transparent); }
.cau-stream--reconnecting::before { background: var(--warning); }
.cau-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.cau-topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 26px; border-bottom: 1px solid var(--hairline); background: transparent; }
.cau-topbar h1 { margin: 0; font-family: var(--serif); font-size: 20px; letter-spacing: .02em; }
.cau-top-actions { display: flex; align-items: center; gap: 14px; }
.cau-content { flex: 1; min-height: 0; overflow: auto; padding: 22px 26px 60px; }
.cau-featured { display: flex; flex-direction: column; gap: 8px; }
.cau-featured-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cau-featured-head strong { font-family: var(--serif); font-size: 15px; }
.cau-page { display: flex; flex-direction: column; gap: 16px; max-width: 1180px; margin: 0 auto; }
.cau-page-title { margin: 0; font-family: var(--serif); font-size: 22px; }
.cau-page-sub { margin: -6px 0 0; color: var(--muted); font-size: 12.5px; }
.cau-card { background: transparent; border: 1px solid var(--hairline); border-radius: 14px; box-shadow: none; }
.cau-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 18px 0; }
.cau-card-head h3 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .02em; }
.cau-card-extra { display: flex; align-items: center; gap: 8px; }
.cau-card-body { padding: 14px 18px 18px; }
.cau-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.cau-stat { background: transparent; border: 1px solid var(--hairline); border-radius: 13px; padding: 15px 16px; }
.cau-stat b { display: block; font-family: var(--serif); font-size: 26px; line-height: 1.15; }
.cau-stat span { color: var(--muted); font-size: 11.5px; letter-spacing: .04em; }
.cau-stat--info b { color: var(--primary); }
.cau-stat--teal b { color: var(--teal); }
.cau-stat--danger b { color: var(--danger); }
.cau-grid { display: grid; gap: 16px; }
.cau-grid--2 { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.cau-dist { display: flex; flex-direction: column; gap: 8px; }
.cau-dist-row { display: grid; grid-template-columns: 52px 1fr 32px; gap: 10px; align-items: center; }
.cau-dist-label { font-size: 12px; }
.cau-dist-bar { height: 8px; background: var(--soft); border-radius: 999px; overflow: hidden; }
.cau-dist-bar i { display: block; height: 100%; border-radius: 999px; min-width: 2px; }
.cau-dist-count { text-align: right; color: var(--muted); font-size: 12px; }
.cau-recent { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.cau-recent li { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 9px; }
.cau-recent li:hover { background: var(--soft); }
.cau-recent-main { flex: 1; min-width: 0; text-align: left; border: 0; background: transparent; cursor: pointer; padding: 0; font-family: var(--sans); }
.cau-recent-name { display: block; color: var(--ink); font-size: 13px; }
.cau-recent-sub { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; }
.cau-active-list { display: flex; flex-direction: column; gap: 8px; }
.cau-active-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; background: var(--soft); border-radius: 10px; }
.cau-active-info { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cau-active-info b { font-size: 13px; }
.cau-active-info span { color: var(--muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 640px; }
.cau-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--hairline); background: transparent; color: var(--ink); border-radius: 9px; padding: 7px 13px; font-size: 12.5px; cursor: pointer; font-family: var(--sans); text-decoration: none; }
.cau-btn:hover { border-color: var(--line); background: var(--soft); }
.cau-btn:disabled { opacity: .5; cursor: not-allowed; }
.cau-btn--primary { background: var(--primary); border-color: var(--primary); color: #fff; box-shadow: none; }
.cau-btn--primary:hover { background: var(--primary); border-color: var(--primary); opacity: .92; }
.cau-btn--danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 38%, transparent); }
.cau-btn--danger:hover { background: color-mix(in srgb, var(--danger) 8%, transparent); }
.cau-btn--ghost { background: transparent; }
.cau-btn--sm { padding: 4px 9px; font-size: 11.5px; border-radius: 7px; }
.cau-row-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cau-link { border: 0; background: transparent; color: var(--primary); cursor: pointer; padding: 0; font-family: var(--sans); font-size: 12.5px; text-decoration: none; }
.cau-link:hover { text-decoration: underline; }
.cau-back { margin-bottom: 6px; display: inline-block; }
.cau-pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 9px; font-size: 11px; background: var(--soft); color: var(--body); border: 1px solid var(--hairline); }
.cau-pill--info { background: var(--primary-soft); color: var(--primary); border-color: transparent; }
.cau-pill--teal { background: color-mix(in srgb, var(--teal) 14%, transparent); color: var(--teal); border-color: transparent; }
.cau-pill--danger { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); border-color: transparent; }
.cau-sev { display: inline-flex; align-items: center; justify-content: center; min-width: 42px; padding: 2px 8px; border-radius: 999px; color: #fff; font-size: 11px; }
.cau-input { width: 100%; border: 1px solid var(--hairline); background: transparent; color: var(--ink); border-radius: 9px; padding: 8px 10px; font-size: 12.5px; font-family: var(--sans); }
.cau-input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(59,130,246,.12); }
.cau-input--search { max-width: 280px; }
.cau-textarea { resize: vertical; line-height: 1.6; }
.cau-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.cau-field-label { font-size: 11.5px; color: var(--muted); letter-spacing: .04em; }
.cau-field-hint { font-size: 11px; color: var(--muted); }
.cau-field--wide { grid-column: 1 / -1; }
.cau-form { display: flex; flex-direction: column; gap: 13px; }
.cau-form--inline { flex-direction: row; flex-wrap: wrap; align-items: flex-end; }
.cau-form--inline .cau-field { flex: 1; min-width: 160px; }
.cau-form--grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.cau-form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.cau-inline { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
.cau-radio { display: inline-flex; align-items: center; gap: 7px; color: var(--body); font-size: 12.5px; }
.cau-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--body); font-size: 12.5px; }
.cau-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.cau-toggle-track { width: 34px; height: 19px; border-radius: 999px; background: var(--line); position: relative; transition: background .18s; flex: none; }
.cau-toggle-dot { position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: #fff; transition: transform .18s; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
.cau-toggle input:checked + .cau-toggle-track { background: var(--primary); }
.cau-toggle input:checked + .cau-toggle-track .cau-toggle-dot { transform: translateX(15px); }
.cau-tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding-bottom: 12px; }
.cau-tab { border: 1px solid transparent; background: transparent; color: var(--muted); padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 12.5px; font-family: var(--sans); }
.cau-tab.is-active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.cau-tabs--underline { border-bottom: 1px solid var(--hairline); padding-bottom: 0; gap: 2px; }
.cau-tabs--underline .cau-tab { border-radius: 0; border: 0; border-bottom: 2px solid transparent; padding: 9px 13px; }
.cau-tabs--underline .cau-tab.is-active { background: transparent; border-bottom-color: var(--primary); color: var(--primary); }
.cau-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.cau-table-wrap { overflow: auto; border: 1px solid var(--hairline); border-radius: 11px; }
.cau-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.cau-table th { text-align: left; font-weight: 500; color: var(--muted); font-size: 11px; letter-spacing: .04em; padding: 9px 12px; background: var(--soft); position: sticky; top: 0; z-index: 1; }
.cau-table td { padding: 10px 12px; border-top: 1px solid var(--hairline); vertical-align: middle; color: var(--body); }
.cau-table tr:hover td { background: var(--soft); }
.cau-table tr.is-selected td { background: var(--primary-soft); }
.cau-th-check { width: 32px; }
.cau-nowrap { white-space: nowrap; }
.cau-sub { color: var(--muted); font-size: 11px; margin-top: 2px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cau-mini-progress { width: 92px; height: 7px; background: var(--soft); border-radius: 999px; overflow: hidden; }
.cau-mini-progress i { display: block; height: 100%; background: var(--primary); border-radius: 999px; transition: width .5s; }
.cau-progress { flex: 1; height: 7px; background: var(--soft); border-radius: 999px; overflow: hidden; }
.cau-progress-bar { display: block; height: 100%; border-radius: 999px; background: var(--primary); transition: width .6s cubic-bezier(.22,1,.36,1); }
.cau-progress-bar--teal { background: var(--teal); }
.cau-upload-progress { display: flex; align-items: center; gap: 10px; font-size: 11.5px; color: var(--muted); }
.cau-preview { background: transparent; border: 1px solid var(--hairline); border-radius: 11px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.cau-preview-title { font-weight: 600; }
.cau-warn { color: var(--warning); font-size: 12px; }
.cau-error { color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 32%, transparent); border-radius: 9px; padding: 9px 12px; font-size: 12px; }
.cau-error-inline { color: var(--danger); font-size: 12px; }
.cau-ok { color: var(--teal); font-size: 12px; }
.cau-muted { color: var(--muted); }
.cau-langs { display: flex; flex-wrap: wrap; gap: 8px; }
.cau-lang { border: 1px solid var(--hairline); background: transparent; color: var(--body); border-radius: 999px; padding: 6px 13px; cursor: pointer; font-size: 12px; font-family: var(--sans); }
.cau-lang.is-active { background: var(--primary); border-color: var(--primary); color: #fff; }
.cau-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.cau-detail-meta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 12px; }
.cau-flow { background: transparent; border: 1px solid var(--hairline); border-radius: 16px; padding: 18px 18px 14px; box-shadow: none; position: relative; overflow: hidden; }
.cau-flow::before { content: none; }
.cau-flow-head { position: relative; display: flex; align-items: center; gap: 16px; margin-bottom: 10px; }
.cau-flow-badge { width: 34px; height: 34px; border-radius: 50%; background: var(--primary); color: #fff; display: flex; align-items: center; justify-content: center; font-family: var(--serif); font-size: 16px; box-shadow: none; flex: none; }
.cau-flow-meta { display: flex; flex-direction: column; gap: 1px; flex: none; }
.cau-flow-caption { font-size: 11px; color: var(--muted); letter-spacing: .06em; }
.cau-flow-step { font-size: 15px; font-weight: 600; }
.cau-flow-progress { flex: 1; height: 6px; background: var(--soft); border-radius: 999px; overflow: hidden; }
.cau-flow-progress span { display: block; height: 100%; border-radius: 999px; background: var(--primary); transition: width .7s cubic-bezier(.22,1,.36,1); }
.cau-flow-activity { position: relative; font-size: 11.5px; color: var(--muted); padding: 2px 0 10px 50px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cau-flow-scroll { position: relative; overflow-x: auto; padding: 2px 0 8px; }
.cau-flow-canvas { position: relative; margin: 0; min-width: 100%; }
.cau-flow-edges { position: absolute; inset: 0; pointer-events: none; }
.cau-lane-label { position: absolute; left: 4px; width: 80px; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; color: var(--muted); }
.cau-node { position: absolute; display: flex; align-items: center; gap: 9px; padding: 0 11px; background: var(--dsw-alias-bg-layer-1, var(--soft)); border: 1.5px solid var(--hairline); border-radius: 12px; z-index: 1; cursor: default; text-align: left; font-family: var(--sans); transition: border-color .25s, box-shadow .25s, opacity .25s; }
.cau-node-glyph { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 13px; background: var(--soft); color: var(--muted); flex: none; }
.cau-node-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cau-node-body b { font-size: 12.5px; font-weight: 600; color: var(--ink); white-space: nowrap; }
.cau-node-body i { font-style: normal; font-size: 10.5px; color: var(--muted); }
.cau-node--pending { opacity: .55; border-style: dashed; }
.cau-node--active { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 16%, transparent); }
.cau-node--active .cau-node-glyph { background: var(--primary); color: #fff; }
.cau-node--active .cau-node-body i { color: var(--primary); }
.cau-node--done .cau-node-glyph { background: color-mix(in srgb, var(--teal) 14%, transparent); color: var(--teal); }
.cau-node--done .cau-node-body i { color: var(--teal); }
.cau-node--skipped { opacity: .7; }
.cau-node--paused { border-color: var(--warning); }
.cau-node--paused .cau-node-glyph { background: color-mix(in srgb, var(--warning) 14%, transparent); color: var(--warning); }
.cau-node--failed { border-color: var(--danger); }
.cau-node--failed .cau-node-glyph { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }
.cau-edge { fill: none; stroke-width: 1.6; stroke-linecap: round; }
.cau-edge--pending { stroke: var(--line); stroke-dasharray: 3 5; opacity: .5; }
.cau-edge--done { stroke: var(--teal); stroke-dasharray: 6 6; opacity: .9; animation: cau-dash 1.6s linear infinite; }
.cau-edge--flowing { stroke: var(--primary); stroke-dasharray: 6 6; animation: cau-dash .9s linear infinite; }
.cau-edge--bridge.cau-edge--flowing { animation-duration: 3.8s; }
.cau-edge--bridge.cau-edge--done { animation-duration: 5.2s; }
.cau-edge-label { font-size: 10px; fill: var(--muted); }
.cau-edge-label--flowing { fill: var(--primary); }
.cau-edge-label--done { fill: var(--teal); }
@keyframes cau-dash { to { stroke-dashoffset: -24px; } }
@media (prefers-reduced-motion: reduce) { .cau-edge--done, .cau-edge--flowing { animation: none; } }
.cau-flow-hint { font-size: 10.5px; color: var(--muted); padding: 2px 0 0 50px; letter-spacing: .04em; }
.cau-node--compact .cau-node-glyph { width: 24px; height: 24px; font-size: 12px; }
.cau-node--compact .cau-node-body b { font-size: 11.5px; }
.cau-node--compact { gap: 7px; padding: 0 8px; }
.cau-flow-note { font-size: 11.5px; color: var(--muted); padding: 4px 0 0 50px; }
.cau-events { max-height: 520px; overflow: auto; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.cau-event { display: grid; grid-template-columns: 64px 44px 1fr; gap: 8px; align-items: baseline; padding: 6px 8px; border-radius: 7px; }
.cau-event:hover { background: var(--soft); }
.cau-event-time { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11px; }
.cau-event-phase { font-size: 10px; text-align: center; border-radius: 999px; padding: 1px 0; background: var(--soft); color: var(--muted); }
.cau-event-phase--verify { background: var(--primary-soft); color: var(--primary); }
.cau-event-text { color: var(--body); word-break: break-word; }
.cau-event--error .cau-event-text { color: var(--danger); }
.cau-event--result .cau-event-text { color: var(--teal); }
.cau-event--tool_use .cau-event-text { color: var(--ink); }
.cau-chip { border: 1px solid var(--hairline); background: transparent; color: var(--muted); border-radius: 999px; padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: var(--sans); }
.cau-chip.is-active { background: var(--primary-soft); color: var(--primary); border-color: transparent; }
.cau-findings { display: flex; flex-direction: column; gap: 10px; }
.cau-finding { background: transparent; border: 1px solid var(--hairline); border-radius: 12px; overflow: hidden; }
.cau-finding-head { width: 100%; display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: transparent; border: 0; cursor: pointer; text-align: left; font-family: var(--sans); }
.cau-finding-title { font-size: 13px; font-weight: 600; color: var(--ink); flex: 1; min-width: 0; }
.cau-finding-file { font-size: 11px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.cau-finding-tags { display: flex; gap: 5px; flex-wrap: wrap; }
.cau-tag { font-size: 10px; color: var(--muted); background: var(--soft); border-radius: 999px; padding: 1px 8px; }
.cau-tag--ok { color: var(--teal); background: color-mix(in srgb, var(--teal) 14%, transparent); }
.cau-tag--partial { color: var(--warning); background: color-mix(in srgb, var(--warning) 14%, transparent); }
.cau-finding-body { padding: 4px 16px 16px; border-top: 1px dashed var(--hairline); }
.cau-finding-body h4 { margin: 14px 0 4px; font-size: 11px; color: var(--muted); letter-spacing: .04em; }
.cau-finding-body p { margin: 0; color: var(--body); line-height: 1.65; white-space: pre-wrap; }
.cau-finding-body pre { margin: 0; background: var(--soft); border: 1px solid var(--hairline); border-radius: 8px; padding: 10px 12px; overflow: auto; font-size: 11.5px; line-height: 1.55; }
.cau-dl { display: grid; grid-template-columns: 84px 1fr 84px 1fr; gap: 4px 10px; margin: 12px 0 0; font-size: 12px; }
.cau-dl dt { color: var(--muted); font-weight: 400; }
.cau-dl dd { margin: 0; color: var(--ink); }
.cau-stage-list { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.cau-stage-row { display: grid; grid-template-columns: 1fr 72px 84px 120px; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--hairline); border-radius: 9px; }
.cau-stage-name { font-size: 12.5px; }
.cau-stage-status { font-size: 11px; color: var(--muted); }
.cau-stage-status--running { color: var(--primary); }
.cau-stage-status--done { color: var(--teal); }
.cau-stage-status--failed { color: var(--danger); }
.cau-stage-status--paused { color: var(--warning); }
.cau-stage-phase { font-size: 11px; color: var(--muted); text-align: right; }
.cau-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: var(--soft); border: 1px solid var(--hairline); border-radius: 8px; padding: 8px 10px; color: var(--body); word-break: break-all; }
.cau-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 34px 16px; text-align: center; }
.cau-empty-art { width: 54px; height: 54px; border-radius: 50%; background: var(--soft); color: var(--muted); display: flex; align-items: center; justify-content: center; font-size: 26px; }
.cau-empty-title { font-size: 13.5px; font-weight: 600; color: var(--ink); }
.cau-empty-hint { font-size: 12px; color: var(--muted); max-width: 460px; }
.cau-empty-action { margin-top: 8px; }
.cau-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 60px 20px; color: var(--muted); font-size: 12.5px; }
.cau-spinner { width: 16px; height: 16px; border: 2px solid var(--hairline); border-top-color: var(--primary); border-radius: 50%; animation: cau-spin .8s linear infinite; }
@keyframes cau-spin { to { transform: rotate(360deg); } }
.cau-modal-mask { position: absolute; inset: 0; background: rgba(15,26,45,.38); display: flex; align-items: center; justify-content: center; z-index: 40; padding: 20px; }
.cau-modal { width: min(520px, 100%); background: var(--dsw-alias-bg-overlay, var(--soft)); border-radius: 14px; box-shadow: none; border: 1px solid var(--hairline); }
.cau-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--hairline); }
.cau-modal-head h3 { margin: 0; font-size: 14px; }
.cau-modal-close { border: 0; background: transparent; font-size: 18px; color: var(--muted); cursor: pointer; line-height: 1; }
.cau-modal-body { padding: 16px 18px; color: var(--body); line-height: 1.65; }
.cau-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--hairline); }
.cau-toast { position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%); background: var(--dsw-alias-bg-overlay, var(--soft)); color: var(--ink); border: 1px solid var(--hairline); padding: 9px 16px; border-radius: 10px; font-size: 12px; box-shadow: none; z-index: 50; max-width: 70%; }
.cau-toast--ok { background: color-mix(in srgb, var(--teal) 18%, var(--dsw-alias-bg-overlay, #fff)); color: var(--ink); }
.cau-toast--error { background: color-mix(in srgb, var(--danger) 16%, var(--dsw-alias-bg-overlay, #fff)); color: var(--ink); }
@media (max-width: 820px) {
  .cau-nav { width: 164px; }
  .cau-content { padding: 16px 14px 50px; }
  .cau-finding-head { flex-wrap: wrap; }
  .cau-stage-row { grid-template-columns: 1fr 64px 88px; }
}
`;

    // ------------------------------------------------------------------
    // Registration
    // ------------------------------------------------------------------

    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 20;
      return h('svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', opacity: props.active === false ? 0.72 : 1 },
      },
        h('path', { key: 'l', d: 'M8.4 7 5 10.5 8.4 14' }),
        h('path', { key: 'r', d: 'M15.6 7 19 10.5 15.6 14' }),
        h('circle', { key: 'c', cx: '12', cy: '11.5', r: '3.6' }),
        h('path', { key: 'h', d: 'M14.7 14.2 17 16.5' }),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'code-audit: dictionaries');
        const t = ctx.locale.bind(NS);
        const theme = (() => {
          try {
            return typeof ctx.get === 'function' ? ctx.get('theme') : ctx.theme;
          } catch {
            return undefined;
          }
        })();
        const layout = (() => {
          try {
            return typeof ctx.get === 'function' ? ctx.get('layout') : ctx.layout;
          } catch {
            return undefined;
          }
        })();
        const openPanel = () => {
          try {
            layout?.selectPanel?.('code-audit');
            beacon('open-panel-requested');
          } catch {
            /* layout service may be unavailable */
          }
        };
        const closeRightbar = () => {
          try {
            layout?.closeRightbar?.();
            beacon('close-rightbar');
          } catch {
            /* layout service may be unavailable */
          }
        };
        // Keep one lightweight stream alive even when the panel is closed so the
        // Host (or the agent) can ask the UI to open the console.
        if (typeof EventSource !== 'undefined') {
          try {
            const opener = new EventSource('/codeaudit/api/stream');
            opener.onmessage = (event) => {
              try {
                const frame = JSON.parse(event.data);
                if (frame?.type === 'open-panel') {
                  beacon('open-panel-frame');
                  openPanel();
                }
              } catch {
                /* ignore malformed frames */
              }
            };
            ctx.effect(() => () => {
              try { opener.close(); } catch { /* already closed */ }
            }, 'code-audit: open-panel listener');
          } catch {
            /* EventSource unavailable */
          }
        }
        const readScheme = () => {
          try {
            return theme?.getTheme?.()?.active?.colorScheme ?? 'light';
          } catch {
            return 'light';
          }
        };
        beacon('client-apply');
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          const onError = (event) => beacon('window-error', { message: String(event?.message ?? ''), line: event?.lineno ?? 0 });
          const onRejection = (event) => beacon('unhandled-rejection', { message: String(event?.reason ?? '').slice(0, 400) });
          window.addEventListener('error', onError);
          window.addEventListener('unhandledrejection', onRejection);
          ctx.effect(() => () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
          }, 'code-audit: error beacon');
        }
        const subscribeScheme = (listener) => {
          if (theme === undefined || theme === null) return undefined;
          const emit = () => listener(readScheme());
          emit();
          if (typeof ctx.on === 'function') {
            try {
              return ctx.on('theme/change', emit);
            } catch {
              return undefined;
            }
          }
          return undefined;
        };

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'code-audit',
        }, (props) => h(ConsoleBoundary, null, h(ConsoleHost, { ...props, t, readScheme, subscribeScheme, openPanel, closeRightbar }))));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'code-audit',
          order: 30,
          label: () => t('panel.title'),
        }, PanelIcon));
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'code-audit-view',
          order: 40,
          locale: NS,
          label: () => t('panel.title'),
        }, (props) => h(ConsoleBoundary, null, h(ConsoleHost, {
          ...props,
          t,
          readScheme,
          subscribeScheme,
          openPanel,
          closeRightbar,
          variant: 'view',
        }))));
      },
    };
  },
});
