import { logger } from '../../utils/Logger.js';

const log = logger.create('VlcBridgePlayer');

export class VlcBridgePlayer {
    constructor(options) {
        this.container = options.container;
        this.settings = options.settings;
        this.onEvent = options.onEvent || (() => {});
        this._wsUrl = options.wsUrl || 'ws://127.0.0.1:8082';
        this._reconnectDelayMs = options.reconnectDelayMs || 1000;
        this._maxReconnectAttempts = options.maxReconnectAttempts || 5;

        this._ws = null;
        this._destroyed = false;
        this._reconnectAttempts = 0;
        // Bumped on every play() so a prior connection attempt's stale 'close'
        // listener (which can still fire after it's been superseded - closing
        // a socket doesn't cancel its in-flight event delivery) can tell it no
        // longer owns the connection and skip its reconnect logic entirely.
        this._connectionGeneration = 0;
        this._currentPlayOptions = null;
        this._duration = 0;
        this._currentTime = 0;
        this._paused = true;
        this._muted = false;
        this._volume = 100;
        this._audioTracks = [];
        this._subtitleTracks = [];
    }

    async play(options) {
        // This player instance is reused across playback sessions (e.g. the
        // next episode in a queue calls play() again). Without closing a
        // leftover socket first, _connectWithRetry() would open a second
        // WebSocket/server-side Session while the first is abandoned and
        // never torn down - start every play() from a clean slate.
        this._connectionGeneration += 1;
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
        this._currentPlayOptions = options;
        this._reconnectAttempts = 0;
        await this._connectWithRetry();
    }

    _connectWithRetry() {
        // Captured once per play() call, not per retry attempt - retries of
        // the same play() call share this generation; only a later play()
        // call bumps it and invalidates them.
        const generation = this._connectionGeneration;
        return new Promise((resolve, reject) => {
            const attempt = () => {
                if (this._destroyed || generation !== this._connectionGeneration) return;
                this._ws = new WebSocket(this._wsUrl);
                let settled = false;

                this._ws.addEventListener('open', () => {
                    settled = true;
                    this._reconnectAttempts = 0;
                    this._sendLoad();
                    resolve();
                }, { once: true });

                this._ws.addEventListener('message', (event) => this._handleMessage(event));

                // The browser/ws WebSocket emits 'error' on connection failure in addition
                // to 'close'. Without a listener here, Node treats it as an uncaught
                // exception and crashes before the 'close' handler below ever runs its
                // retry/reject logic. Swallow it here; 'close' is what actually decides
                // whether to retry or surface the error event.
                this._ws.addEventListener('error', () => {});

                this._ws.addEventListener('close', () => {
                    if (this._destroyed || generation !== this._connectionGeneration) return;
                    this._reconnectAttempts += 1;
                    if (this._reconnectAttempts > this._maxReconnectAttempts) {
                        const message = 'Bridge daemon connection lost after repeated reconnect attempts';
                        this.onEvent({ type: 'error', data: { message } });
                        if (!settled) reject(new Error(message));
                        return;
                    }
                    setTimeout(attempt, this._reconnectDelayMs);
                });
            };
            attempt();
        });
    }

    _sendLoad() {
        this._send({
            command: 'load',
            url: this._currentPlayOptions.url,
            startPositionTicks: this._currentPlayOptions.playerStartPositionTicks || 0,
            audioTrack: this._currentPlayOptions.audioStreamIndex,
            subtitleTrack: this._currentPlayOptions.subtitleStreamIndex
        });
    }

    seek(positionTicks, options) {
        this._send({ command: 'seek', ticks: positionTicks });
    }

    _send(message) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(message));
        }
    }

    _handleMessage(event) {
        const { type, data } = JSON.parse(event.data);

        switch (type) {
            case 'loadedmetadata':
                this._duration = data.duration;
                this._audioTracks = data.audioTracks;
                this._subtitleTracks = data.subtitleTracks;
                break;
            case 'timeupdate':
                this._currentTime = data.time;
                break;
            case 'pause':
                this._paused = true;
                break;
            case 'playing':
                this._paused = false;
                break;
        }

        log.debug(`Event: ${type}`);
        this.onEvent({ type, data });
    }

    async stop() {
        this._send({ command: 'stop' });
    }

    destroy() {
        this._destroyed = true;
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
    }

    getCurrentTime() {
        return this._currentTime;
    }

    getDuration() {
        return this._duration;
    }

    isPaused() {
        return this._paused;
    }

    isBuffering() {
        return false;
    }

    setMuted(muted) {
        this._muted = muted;
    }

    isMuted() {
        return this._muted;
    }

    // Local UI state only, like setMuted/isMuted above - not forwarded to VLC.
    // Real audio output volume on this hardware goes through the TV/soundbar
    // over HDMI-CEC, not VLC's own internal digital volume.
    setVolume(volume) {
        this._volume = volume;
    }

    getVolume() {
        return this._volume;
    }

    setSubtitleStreamIndex(index) {
        this._send({ command: 'setSubtitleTrack', index });
    }

    setAudioStreamIndex(index) {
        this._send({ command: 'setAudioTrack', index });
    }

    setIntroSkipperTimestamps(introStartTicks, introEndTicks) {
        this._send({ command: 'setIntroSkipperTimestamps', introStartTicks, introEndTicks });
    }

    supportsNativeAudioTracks() {
        return true;
    }
}
