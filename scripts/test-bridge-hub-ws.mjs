#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';

const HUB_PORT = 9261;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error(`waitFor timeout: ${url}`);
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
}

async function main() {
  const hub = spawn('node', ['/root/codex-bridge/scripts/bridge-hub.mjs', '--port', String(HUB_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  hub.stderr.on('data', (d) => process.stderr.write(d));

  try {
    await waitFor(`http://127.0.0.1:${HUB_PORT}/health`);

    // --- Test 1: register peer A ---
    const wsA = await connectWs(`ws://127.0.0.1:${HUB_PORT}`);
    wsA.send(JSON.stringify({ type: 'register', nodeId: 'node-a', deviceName: 'Device A', token: 'tok-a', exportSide: 'A' }));
    const regA = await nextMessage(wsA);
    assert.equal(regA.type, 'registered');
    assert.equal(regA.nodeId, 'node-a');
    const peersA = await nextMessage(wsA); // peers push after register
    assert.equal(peersA.type, 'peers');

    // --- Test 2: register peer B, sees peer A ---
    const wsB = await connectWs(`ws://127.0.0.1:${HUB_PORT}`);
    wsB.send(JSON.stringify({ type: 'register', nodeId: 'node-b', deviceName: 'Device B', token: 'tok-b', exportSide: 'B' }));
    await nextMessage(wsB); // registered
    const peersB = await nextMessage(wsB); // peers push
    assert.equal(peersB.type, 'peers');
    assert.ok(peersB.peers.some((p) => p.nodeId === 'node-a'), 'B should see A');

    // --- Test 3: HTTP /peers ---
    const httpPeers = await fetch(`http://127.0.0.1:${HUB_PORT}/peers`).then((r) => r.json());
    assert.equal(httpPeers.ok, true);
    assert.equal(httpPeers.peers.length, 2);

    // --- Test 4: invoke A→B, B streams back ---
    const invokePromise = new Promise((resolve) => {
      const deltas = [];
      wsA.on('message', function handler(d) {
        const msg = JSON.parse(d.toString());
        if (msg.requestId !== 'req-1') return;
        if (msg.type === 'delta') deltas.push(msg.delta);
        if (msg.type === 'done') {
          wsA.off('message', handler);
          resolve({ deltas, text: msg.text });
        }
      });
    });

    // B listens for invoke and streams back
    wsB.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'invoke') {
        wsB.send(JSON.stringify({ type: 'delta', requestId: msg.requestId, delta: 'hello ' }));
        wsB.send(JSON.stringify({ type: 'delta', requestId: msg.requestId, delta: 'world' }));
        wsB.send(JSON.stringify({ type: 'done', requestId: msg.requestId, text: 'hello world' }));
      }
    });

    wsA.send(JSON.stringify({ type: 'invoke', requestId: 'req-1', targetNodeId: 'node-b', token: 'tok-b', text: 'ping' }));
    const result = await invokePromise;
    assert.deepEqual(result.deltas, ['hello ', 'world']);
    assert.equal(result.text, 'hello world');

    // --- Test 5: interrupt forwarding ---
    const interruptPromise = nextMessage(wsB);
    wsA.send(JSON.stringify({ type: 'interrupt', requestId: 'req-2', targetNodeId: 'node-b', token: 'tok-b' }));
    const interruptMsg = await interruptPromise;
    assert.equal(interruptMsg.type, 'interrupt');
    assert.equal(interruptMsg.requestId, 'req-2');

    // --- Test 6: peer disconnect cleans up pending request ---
    const wsC = await connectWs(`ws://127.0.0.1:${HUB_PORT}`);
    wsC.send(JSON.stringify({ type: 'register', nodeId: 'node-c', token: 'tok-c', exportSide: 'A' }));
    await nextMessage(wsC); // registered
    await nextMessage(wsC); // peers

    const errorPromise = new Promise((resolve) => {
      wsA.on('message', function handler(d) {
        const msg = JSON.parse(d.toString());
        if (msg.requestId === 'req-3' && msg.type === 'error') {
          wsA.off('message', handler);
          resolve(msg);
        }
      });
    });
    wsA.send(JSON.stringify({ type: 'invoke', requestId: 'req-3', targetNodeId: 'node-c', token: 'tok-c', text: 'test' }));
    await sleep(50);
    wsC.close();
    const errMsg = await errorPromise;
    assert.equal(errMsg.message, 'peer disconnected');

    // --- Test 7: invalid token rejected ---
    wsA.send(JSON.stringify({ type: 'invoke', requestId: 'req-4', targetNodeId: 'node-b', token: 'wrong-token', text: 'test' }));
    const errToken = await new Promise((resolve) => {
      wsA.on('message', function handler(d) {
        const msg = JSON.parse(d.toString());
        if (msg.requestId === 'req-4') { wsA.off('message', handler); resolve(msg); }
      });
    });
    assert.equal(errToken.type, 'error');
    assert.match(errToken.message, /invalid token/);

    wsA.close();
    wsB.close();

    console.log('bridge-hub-ws test ok');
  } finally {
    hub.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
