# code-audit-demo

A tiny Node HTTP service used as the code-audit console smoke-test target.

Endpoints:

- `GET /run?cmd=<shell>` executes a shell command.
- `GET /file?p=<path>` reads a file relative to the working directory.
- `GET /user?id=<id>` builds a SQL statement by string concatenation.

Run with `node server.js` or `docker compose up --build`.
