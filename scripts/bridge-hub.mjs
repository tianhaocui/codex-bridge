#!/usr/bin/env node

import http from 'node:http';

const args = process.argv.slice(2);

function readArg(name, fallback) {
  const index = args.findIndex((arg) => arg === `--${name}`);
  if (index < 0) return fallback;
  return args[index + 1] ?? fallback;
}

const port = Number.parseInt(readArg('port', process.env.BRIDGE_HUB_PORT || '9239'), 10);
const host = readArg('host', process.env.BRIDGE_HUB_HOST || '0.0.0.0');
const token = readArg('token', process.env.BRIDGE_HUB_TOKEN || '');
const ttlMs = Number.parseInt(readArg('ttl', process.env.BRIDGE_HUB_TTL_MS || '45000'), 10);

if (!token) {
  console.error('缺少 hub token。请通过 --token 或 BRIDGE_HUB_TOKEN 提供。');
  process.exit(1);
}

const peers = new Map();

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function cleanupExpiredPeers() {
  const now = Date.now();
  for (const [nodeId, peer] of peers.entries()) {
    if (now - peer.lastSeenAt > ttlMs) {
      peers.delete(nodeId);
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function pipeWebStreamToNodeResponse(body, res) {
  if (!body) {
    res.end();
    return;
  }
  const reader = body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      res.write(Buffer.from(value));
    }
  }
  res.end();
}

function requireToken(candidate) {
  return typeof candidate === 'string' && candidate === token;
}

const server = http.createServer(async (req, res) => {
  cleanupExpiredPeers();

  if (!req.url) {
    sendJson(res, 404, { ok: false, message: 'not found' });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, peers: peers.size, ttlMs });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/register') {
    try {
      const body = await readJsonBody(req);
      if (!requireToken(body.token)) {
        sendJson(res, 401, { ok: false, message: 'invalid token' });
        return;
      }
      if (typeof body.nodeId !== 'string' || !body.nodeId.trim()) {
        sendJson(res, 400, { ok: false, message: 'nodeId required' });
        return;
      }
      if (typeof body.invokeUrl !== 'string' || !body.invokeUrl.trim()) {
        sendJson(res, 400, { ok: false, message: 'invokeUrl required' });
        return;
      }
      peers.set(body.nodeId, {
        nodeId: body.nodeId,
        deviceName: typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim() : body.nodeId,
        invokeUrl: body.invokeUrl.trim(),
        exportSide: typeof body.exportSide === 'string' ? body.exportSide : '',
        lastSeenAt: Date.now()
      });
      sendJson(res, 200, { ok: true, nodeId: body.nodeId, ttlMs });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error?.message || 'register failed' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/peers') {
    if (!requireToken(url.searchParams.get('token'))) {
      sendJson(res, 401, { ok: false, message: 'invalid token' });
      return;
    }
    const selfId = url.searchParams.get('selfId') || '';
    const list = [...peers.values()]
      .filter((peer) => peer.nodeId !== selfId)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((peer) => ({
        nodeId: peer.nodeId,
        deviceName: peer.deviceName,
        invokeUrl: peer.invokeUrl,
        exportSide: peer.exportSide,
        lastSeenAt: peer.lastSeenAt
      }));
    sendJson(res, 200, { ok: true, peers: list });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/relay/health') {
    if (!requireToken(url.searchParams.get('token'))) {
      sendJson(res, 401, { ok: false, message: 'invalid token' });
      return;
    }
    const targetNodeId = (url.searchParams.get('targetNodeId') || '').trim();
    if (!targetNodeId) {
      sendJson(res, 400, { ok: false, message: 'targetNodeId required' });
      return;
    }
    const target = peers.get(targetNodeId);
    if (!target) {
      sendJson(res, 404, { ok: false, message: 'target node not found' });
      return;
    }
    try {
      const healthUrl = target.invokeUrl.replace(/\/invoke\/?$/, '/health');
      const upstream = await fetch(healthUrl);
      const text = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
      res.end(text);
    } catch (error) {
      sendJson(res, 502, { ok: false, message: error?.message || 'target health failed' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/unregister') {
    try {
      const body = await readJsonBody(req);
      if (!requireToken(body.token)) {
        sendJson(res, 401, { ok: false, message: 'invalid token' });
        return;
      }
      const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
      if (!nodeId) {
        sendJson(res, 400, { ok: false, message: 'nodeId required' });
        return;
      }
      peers.delete(nodeId);
      sendJson(res, 200, { ok: true, nodeId });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error?.message || 'unregister failed' });
    }
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/relay/invoke' || url.pathname === '/relay/interrupt')) {
    try {
      const body = await readJsonBody(req);
      if (!requireToken(body.token)) {
        sendJson(res, 401, { ok: false, message: 'invalid token' });
        return;
      }
      const targetNodeId = typeof body.targetNodeId === 'string' ? body.targetNodeId.trim() : '';
      if (!targetNodeId) {
        sendJson(res, 400, { ok: false, message: 'targetNodeId required' });
        return;
      }
      const target = peers.get(targetNodeId);
      if (!target) {
        sendJson(res, 404, { ok: false, message: 'target node not found' });
        return;
      }

      const targetUrl = url.pathname === '/relay/invoke'
        ? target.invokeUrl
        : target.invokeUrl.replace(/\/invoke\/?$/, '/interrupt');

      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: url.pathname === '/relay/invoke'
          ? { 'Content-Type': 'application/json' }
          : { 'x-bridge-token': token },
        body: url.pathname === '/relay/invoke'
          ? JSON.stringify({
              token,
              text: body.text || '',
              stream: body.stream !== false,
              targetTool: body.targetTool,
              targetProjectPath: body.targetProjectPath,
              targetSessionId: body.targetSessionId
            })
          : undefined
      });

      res.statusCode = upstream.status;
      const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', upstream.headers.get('cache-control') || 'no-cache, no-transform');
      await pipeWebStreamToNodeResponse(upstream.body, res);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error?.message || 'relay failed' });
    }
    return;
  }

  sendJson(res, 404, { ok: false, message: 'not found' });
});

setInterval(cleanupExpiredPeers, Math.max(5000, Math.floor(ttlMs / 2))).unref();

server.listen(port, host, () => {
  console.log(`bridge hub listening on http://${host}:${port}`);
});
