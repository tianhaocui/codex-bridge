#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const HUB_PORT = 9259;
const TARGET_PORT = 9260;
const HUB_TOKEN = 'bridge-test-token';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`waitFor timeout: ${url}`);
}

function readNdjson(response) {
  return new Promise(async (resolve, reject) => {
    if (!response.body) {
      reject(new Error('response body missing'));
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const items = [];
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        items.push(JSON.parse(line));
      }
      if (done) break;
    }
    if (buffer.trim()) {
      items.push(JSON.parse(buffer.trim()));
    }
    resolve(items);
  });
}

function startMockTargetServer() {
  const state = {
    invokeCalls: [],
    interrupted: false
  };
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/interrupt') {
      state.interrupted = req.headers['x-bridge-token'] === HUB_TOKEN;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/invoke') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        state.invokeCalls.push(body);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.write(JSON.stringify({ type: 'delta', delta: 'hello ' }) + '\n');
        await sleep(30);
        res.write(JSON.stringify({ type: 'delta', delta: 'world' }) + '\n');
        await sleep(30);
        res.end(JSON.stringify({ type: 'done', text: 'hello world' }) + '\n');
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  return {
    state,
    async start() {
      await new Promise((resolve) => server.listen(TARGET_PORT, '127.0.0.1', resolve));
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function main() {
  const target = startMockTargetServer();
  await target.start();

  const hub = spawn('node', ['/Users/wulingren/codex-bridge-macapp/scripts/bridge-hub.mjs', '--port', String(HUB_PORT), '--token', HUB_TOKEN, '--ttl', '2000'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  hub.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  try {
    await waitFor(`http://127.0.0.1:${HUB_PORT}/health`);

    const registerResponse = await fetch(`http://127.0.0.1:${HUB_PORT}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: HUB_TOKEN,
        nodeId: 'node-a',
        deviceName: 'Test Device A',
        invokeUrl: `http://127.0.0.1:${TARGET_PORT}/invoke`,
        exportSide: 'A'
      })
    });
    assert.equal(registerResponse.status, 200);

    const peersResponse = await fetch(`http://127.0.0.1:${HUB_PORT}/peers?token=${encodeURIComponent(HUB_TOKEN)}`);
    const peersPayload = await peersResponse.json();
    assert.equal(peersPayload.ok, true);
    assert.equal(peersPayload.peers.length, 1);
    assert.equal(peersPayload.peers[0].nodeId, 'node-a');

    const relayHealth = await fetch(`http://127.0.0.1:${HUB_PORT}/relay/health?token=${encodeURIComponent(HUB_TOKEN)}&targetNodeId=node-a`);
    assert.equal(relayHealth.status, 200);

    const relayResponse = await fetch(`http://127.0.0.1:${HUB_PORT}/relay/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: HUB_TOKEN,
        targetNodeId: 'node-a',
        text: 'ping',
        stream: true,
        targetTool: 'claude',
        targetProjectPath: '/tmp/demo-project',
        targetSessionId: 'session-123'
      })
    });
    assert.equal(relayResponse.status, 200);
    assert.match(relayResponse.headers.get('content-type') || '', /application\/x-ndjson/);
    const relayItems = await readNdjson(relayResponse);
    assert.deepEqual(relayItems, [
      { type: 'delta', delta: 'hello ' },
      { type: 'delta', delta: 'world' },
      { type: 'done', text: 'hello world' }
    ]);
    assert.equal(target.state.invokeCalls.length, 1);
    assert.equal(target.state.invokeCalls[0].text, 'ping');
    assert.equal(target.state.invokeCalls[0].targetTool, 'claude');
    assert.equal(target.state.invokeCalls[0].targetProjectPath, '/tmp/demo-project');
    assert.equal(target.state.invokeCalls[0].targetSessionId, 'session-123');

    const interruptResponse = await fetch(`http://127.0.0.1:${HUB_PORT}/relay/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: HUB_TOKEN,
        targetNodeId: 'node-a'
      })
    });
    assert.equal(interruptResponse.status, 200);
    await interruptResponse.text();
    assert.equal(target.state.interrupted, true);

    const unregisterResponse = await fetch(`http://127.0.0.1:${HUB_PORT}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: HUB_TOKEN,
        nodeId: 'node-a'
      })
    });
    assert.equal(unregisterResponse.status, 200);

    const peersAfterUnregister = await fetch(`http://127.0.0.1:${HUB_PORT}/peers?token=${encodeURIComponent(HUB_TOKEN)}`);
    const peersAfterPayload = await peersAfterUnregister.json();
    assert.equal(peersAfterPayload.peers.length, 0);

    const ttlRegister = await fetch(`http://127.0.0.1:${HUB_PORT}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: HUB_TOKEN,
        nodeId: 'node-b',
        deviceName: 'TTL Device',
        invokeUrl: `http://127.0.0.1:${TARGET_PORT}/invoke`,
        exportSide: 'B'
      })
    });
    assert.equal(ttlRegister.status, 200);
    await sleep(2600);
    const peersAfterTtl = await fetch(`http://127.0.0.1:${HUB_PORT}/peers?token=${encodeURIComponent(HUB_TOKEN)}`);
    const peersAfterTtlPayload = await peersAfterTtl.json();
    assert.equal(peersAfterTtlPayload.peers.length, 0);

    console.log('bridge-hub test ok');
  } finally {
    hub.kill();
    await target.stop();
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
