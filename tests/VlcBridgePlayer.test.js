import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';

// Node 20 has no global WebSocket client without an experimental flag;
// Chromium (where VlcBridgePlayer.js actually runs in production) has one
// natively, so this polyfill is test-environment-only, verified against
// the real `ws` package rather than assumed.
globalThis.WebSocket = WebSocket;

// VlcBridgePlayer.js imports utils/Logger.js, which touches `window` and
// `localStorage` at module load time (browser globals that don't exist in
// plain Node). Other tests in this suite (e.g. SubtitleFormatting.test.js)
// polyfill the same way before importing anything that pulls in Logger.
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.window = globalThis;

// Must be a dynamic import: static imports are all linked (and their module
// bodies evaluated) before any top-level statement in this file runs, so a
// static import here would hit Logger.js's `window`/`localStorage` access
// before the polyfills above take effect.
const { VlcBridgePlayer } = await import('../src/player/core/VlcBridgePlayer.js');

function startFakeBridge() {
    // WebSocketServer binds asynchronously: `wss.address()` is still null
    // immediately after construction, and only populated once the
    // underlying 'listening' event fires. Wait for it before handing back
    // `port`, otherwise callers race the bind and crash on `.port` of null.
    return new Promise((resolve) => {
        const received = [];
        const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        let socket = null;
        let connectionCount = 0;
        wss.on('connection', (ws) => {
            socket = ws;
            connectionCount += 1;
            ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
        });
        wss.on('listening', () => {
            resolve({
                port: wss.address().port,
                received,
                send: (type, data) => socket.send(JSON.stringify({ type, data })),
                disconnectClient: () => socket.close(),
                getConnectionCount: () => connectionCount,
                close: () => new Promise((res) => wss.close(res))
            });
        });
    });
}

function waitUntil(fn, timeoutMs = 1000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            if (fn()) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting'));
            setTimeout(check, 5);
        };
        check();
    });
}

test('play sends a load command with url, start position in ticks, and tracks', async () => {
    const bridge = await startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });

    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 300000000 });
    await waitUntil(() => bridge.received.length > 0);

    assert.deepEqual(bridge.received[0], { command: 'load', url: 'http://server/x.mkv', startPositionTicks: 300000000 });

    player.destroy();
    await bridge.close();
});

test('loadedmetadata event updates getDuration and fires onEvent', async () => {
    const bridge = await startFakeBridge();
    const events = [];
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: (e) => events.push(e), wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    bridge.send('loadedmetadata', { duration: 7199, audioTracks: [], subtitleTracks: [] });
    await waitUntil(() => player.getDuration() === 7199);

    assert.ok(events.some((e) => e.type === 'loadedmetadata'));

    player.destroy();
    await bridge.close();
});

test('timeupdate event updates getCurrentTime', async () => {
    const bridge = await startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    bridge.send('timeupdate', { time: 42 });
    await waitUntil(() => player.getCurrentTime() === 42);

    player.destroy();
    await bridge.close();
});

test('pause and playing events update isPaused', async () => {
    const bridge = await startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    bridge.send('pause', {});
    await waitUntil(() => player.isPaused() === true);
    bridge.send('playing', {});
    await waitUntil(() => player.isPaused() === false);

    player.destroy();
    await bridge.close();
});

test('setSubtitleStreamIndex and setAudioStreamIndex send the right commands', async () => {
    const bridge = await startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    player.setSubtitleStreamIndex(3);
    player.setAudioStreamIndex(2);
    await waitUntil(() => bridge.received.length >= 3);

    assert.deepEqual(bridge.received[1], { command: 'setSubtitleTrack', index: 3 });
    assert.deepEqual(bridge.received[2], { command: 'setAudioTrack', index: 2 });

    player.destroy();
    await bridge.close();
});

test('stop sends a stop command', async () => {
    const bridge = await startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    await player.stop();
    await waitUntil(() => bridge.received.length >= 2);

    assert.deepEqual(bridge.received[1], { command: 'stop' });

    player.destroy();
    await bridge.close();
});

test('ended event forwards onEvent with type ended', async () => {
    const bridge = await startFakeBridge();
    const events = [];
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: (e) => events.push(e), wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    bridge.send('ended', {});
    await waitUntil(() => events.some((e) => e.type === 'ended'));

    player.destroy();
    await bridge.close();
});

test('seek sends a seek command with the given ticks, matching how JellyfinPlayer.js calls it (not awaited)', async () => {
    const bridge = await startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    player.seek(300000000, {});
    await waitUntil(() => bridge.received.length >= 2);

    assert.deepEqual(bridge.received[1], { command: 'seek', ticks: 300000000 });

    player.destroy();
    await bridge.close();
});

test('reconnects after the bridge connection drops, and re-sends the current load state', async () => {
    const bridge = await startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}`, reconnectDelayMs: 5 });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    bridge.disconnectClient();
    await waitUntil(() => bridge.getConnectionCount() === 2, 2000);
    await waitUntil(() => bridge.received.length >= 2, 2000);

    assert.deepEqual(bridge.received[1], { command: 'load', url: 'http://server/x.mkv', startPositionTicks: 0 });

    player.destroy();
    await bridge.close();
});

test('surfaces an error event only after repeated reconnect failures, not on the first drop', async () => {
    const events = [];
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: (e) => events.push(e), wsUrl: 'ws://127.0.0.1:1', reconnectDelayMs: 5, maxReconnectAttempts: 3 });

    await assert.rejects(() => player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 }));
    await waitUntil(() => events.some((e) => e.type === 'error'), 2000);

    player.destroy();
});

test('setIntroSkipperTimestamps sends the ticks over the websocket', async () => {
    const bridge = await startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    player.setIntroSkipperTimestamps(300000000, 900000000);
    await waitUntil(() => bridge.received.length >= 2);

    assert.deepEqual(bridge.received[1], { command: 'setIntroSkipperTimestamps', introStartTicks: 300000000, introEndTicks: 900000000 });

    player.destroy();
    await bridge.close();
});

test('calling play() again (e.g. next episode) does not leak the previous connection or let its stale close handler clobber the new one', async () => {
    const bridge = await startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}`, reconnectDelayMs: 5 });

    await player.play({ url: 'http://server/episode1.mkv', playerStartPositionTicks: 0 });
    await player.play({ url: 'http://server/episode2.mkv', playerStartPositionTicks: 0 });
    const wsAfterSecondPlay = player._ws;

    // Give the first socket's close event, and any stale reconnect it might
    // schedule, plenty of time to fire before asserting nothing changed.
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(bridge.getConnectionCount(), 2);
    assert.equal(player._ws, wsAfterSecondPlay);

    player.destroy();
    await bridge.close();
});

test('getVolume/setVolume track local state without crashing (not forwarded to VLC - real volume is via HDMI-CEC)', async () => {
    const bridge = await startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    assert.equal(player.getVolume(), 100);
    player.setVolume(42);
    assert.equal(player.getVolume(), 42);
    assert.equal(bridge.received.length, 1); // no command sent to the bridge

    player.destroy();
    await bridge.close();
});
