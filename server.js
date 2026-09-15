'use strict';

const http = require('http');
const { URL } = require('url');
const router = require('./api');
const { readJsonBody, HttpError } = require('./router');

const PORT = Number(process.env.PORT) || 4000;

// Default includes your live frontend so this works out of the box; add more
// origins (comma-separated) via the CORS_ORIGIN env var if you deploy the
// frontend elsewhere too (e.g. a custom domain).
const DEFAULT_ORIGINS = ['https://empty-trackload.onrender.com', 'http://localhost:8080', 'http://127.0.0.1:8080'];
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : DEFAULT_ORIGINS)
  .map((s) => s.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return send(res, 400, { error: 'Bad request URL' });
  }

  const found = router.match(req.method, url.pathname);
  if (!found) {
    return send(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
  }

  const query = Object.fromEntries(url.searchParams.entries());

  try {
    let body = {};
    if (req.method === 'POST' || req.method === 'PATCH') {
      body = await readJsonBody(req);
    }
    const ctx = { req, res, params: found.params, query, body };
    const result = await found.handler(ctx);
    return send(res, result.status || 200, result.body ?? {});
  } catch (err) {
    if (err instanceof HttpError) {
      return send(res, err.statusCode, { error: err.message, details: err.details });
    }
    if (err.statusCode) {
      return send(res, err.statusCode, { error: err.message });
    }
    console.error('Unhandled error:', err);
    return send(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`LoadMatch backend listening on http://localhost:${PORT}`);
  console.log(`Allowed CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
