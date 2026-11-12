// Deliberately vulnerable demo service used only by the plugin's own smoke test.
// It ships no dependencies so the audit pipeline can read every file quickly.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const port = Number(process.env.PORT || 3000);

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(String(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Intentional command injection: attacker-controlled cmd reaches execSync.
  if (url.pathname === '/run') {
    const cmd = url.searchParams.get('cmd') || 'echo hi';
    const output = execSync(cmd).toString();
    send(res, 200, output);
    return;
  }

  // Intentional path traversal: p is joined without any containment check.
  if (url.pathname === '/file') {
    const p = url.searchParams.get('p') || 'package.json';
    const data = fs.readFileSync(path.join(process.cwd(), p));
    send(res, 200, data);
    return;
  }

  // Intentional SQL string concatenation (no real database is contacted).
  if (url.pathname === '/user') {
    const id = url.searchParams.get('id') || '1';
    const query = 'SELECT * FROM users WHERE id=' + id;
    send(res, 200, query);
    return;
  }

  if (url.pathname === '/') {
    send(res, 200, 'code-audit demo');
    return;
  }

  send(res, 404, 'not found');
});

server.listen(port, () => {
  console.log(`demo listening on ${port}`);
});
