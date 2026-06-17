#!/usr/bin/env node

import http from 'node:http';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);

function readArg(name, fallback) {
  const index = args.findIndex((arg) => arg === `--${name}`);
  if (index < 0) return fallback;
  return args[index + 1] ?? fallback;
}

const port = Number.parseInt(readArg('port', process.env.BRIDGE_HUB_PORT || '9239'), 10);
const host = readArg('host', process.env.BRIDGE_HUB_HOST || '0.0.0.0');

// nodeId → { nodeId, deviceName, token, exportSide, discoverable, ws }
const peers = new Map();
// requestId → { clientWs, targetNodeId }
const pendingRequests = new Map();

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function wsSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function visiblePeerList(excludeNodeId) {
  return [...peers.values()]
    .filter((p) => p.nodeId !== excludeNodeId && p.discoverable !== false)
    .map(({ nodeId, deviceName, exportSide }) => ({ nodeId, deviceName, exportSide }));
}

const server = http.createServer((req, res) => {
  if (!req.url) { sendJson(res, 404, { ok: false, message: 'not found' }); return; }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, peers: peers.size });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/peers') {
    const selfId = url.searchParams.get('selfId') || '';
    sendJson(res, 200, { ok: true, peers: visiblePeerList(selfId) });
    return;
  }

  sendJson(res, 404, { ok: false, message: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  let registeredNodeId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case 'register': {
        const nodeId = typeof msg.nodeId === 'string' ? msg.nodeId.trim() : '';
        if (!nodeId) { wsSend(ws, { type: 'error', message: 'nodeId required' }); return; }
        registeredNodeId = nodeId;
        peers.set(nodeId, {
          nodeId,
          deviceName: typeof msg.deviceName === 'string' && msg.deviceName.trim() ? msg.deviceName.trim() : nodeId,
          token: typeof msg.token === 'string' ? msg.token.trim() : '',
          exportSide: typeof msg.exportSide === 'string' ? msg.exportSide : '',
          discoverable: msg.discoverable !== false,
          ws
        });
        wsSend(ws, { type: 'registered', nodeId });
        wsSend(ws, { type: 'peers', peers: visiblePeerList(nodeId) });
        break;
      }

      case 'invoke': {
        const requestId = msg.requestId;
        const targetNodeId = typeof msg.targetNodeId === 'string' ? msg.targetNodeId.trim() : '';
        const target = peers.get(targetNodeId);
        if (!target) { wsSend(ws, { type: 'error', requestId, message: 'target node not found' }); return; }
        const expected = target.token;
        if (expected && msg.token !== expected) { wsSend(ws, { type: 'error', requestId, message: 'invalid token' }); return; }
        pendingRequests.set(requestId, { clientWs: ws, targetNodeId });
        wsSend(target.ws, {
          type: 'invoke', requestId,
          sourceNodeId: registeredNodeId,
          text: msg.text || '',
          targetTool: msg.targetTool,
          targetProjectPath: msg.targetProjectPath,
          targetSessionId: msg.targetSessionId
        });
        break;
      }

      case 'delta': {
        const pending = pendingRequests.get(msg.requestId);
        if (pending) wsSend(pending.clientWs, { type: 'delta', requestId: msg.requestId, delta: msg.delta });
        break;
      }

      case 'done': {
        const pending = pendingRequests.get(msg.requestId);
        if (pending) {
          pendingRequests.delete(msg.requestId);
          wsSend(pending.clientWs, { type: 'done', requestId: msg.requestId, text: msg.text });
        }
        break;
      }

      case 'error': {
        const pending = pendingRequests.get(msg.requestId);
        if (pending) {
          pendingRequests.delete(msg.requestId);
          wsSend(pending.clientWs, { type: 'error', requestId: msg.requestId, message: msg.message });
        }
        break;
      }

      case 'interrupt': {
        const targetNodeId = typeof msg.targetNodeId === 'string' ? msg.targetNodeId.trim() : '';
        const target = peers.get(targetNodeId);
        if (target) wsSend(target.ws, { type: 'interrupt', requestId: msg.requestId });
        break;
      }

      case 'ping':
        wsSend(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (registeredNodeId) {
      peers.delete(registeredNodeId);
      for (const [reqId, pending] of pendingRequests) {
        if (pending.targetNodeId === registeredNodeId) {
          wsSend(pending.clientWs, { type: 'error', requestId: reqId, message: 'peer disconnected' });
          pendingRequests.delete(reqId);
        }
      }
    }
  });

  ws.on('error', () => {});
});

server.listen(port, host, () => {
  console.log(`bridge hub listening on http://${host}:${port}`);
});
