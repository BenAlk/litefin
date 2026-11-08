/**
 * ============================================================================
 * Litefin - Linux Kiosk Platform Adapter
 * ============================================================================
 * Handles platform-specific functionality for Litefin running as a dedicated
 * TV appliance on Linux (Raspberry Pi 4B, Chromium kiosk via `cage`):
 * - Physical keyboard shortcut mappings (D-Pad, Home, Media keys, Shortcuts)
 * - Client device identification for Jellyfin session authorization
 * - User idle tracking for screensavers and sleep timers
 *
 * Detected via a custom Chromium `--user-agent` token (see PlatformInfo.js)
 * rather than Tauri/Electron markers, since this runs as a plain kiosk
 * browser tab, not a packaged desktop app shell - see DesktopAdapter.js for
 * that case. Fullscreen is not handled here: `chromium --kiosk` is already
 * full-screen at the OS level, no in-page toggle is needed.
 *
 * Exit/reboot/shutdown are not wired up yet - the project plan routes these
 * through a bridge daemon (Phase 3) that does not exist yet.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { router } from '../core/Router.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';

// Initialize dedicated logger for Linux adapter events
const log = logger.create('LinuxAdapter');

// ============================================================================
// Standard Keyboard Key Code Mappings for the Linux Kiosk
// ============================================================================
const LINUX_KEYS = {
    // Spatial navigation controls (Arrow keys and Enter)
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ENTER: 13,

    // Navigation and cancellation keys
    ESCAPE: 27,
    BACKSPACE: 8,

    // Home - remapped from the TV/Fire TV remote's Home button to a spare
    // key by keyd in Phase 4. Inactive until that remapping exists. Insert,
    // not an F-key: Chromium hardcodes F1/F3/F5/F6/F10/F11/F12 to its own
    // browser actions (e.g. F1 = Chrome Help) which page JS can't suppress,
    // even in --kiosk mode (confirmed by testing).
    HOME: 45,

    // Playback control keys
    SPACE: 32,

    // Standard media keys, as remapped from the TV/Fire TV remote in Phase 4
    MEDIA_PLAY: 415,
    MEDIA_PAUSE: 19,
    MEDIA_PLAY_PAUSE: 179,
    MEDIA_STOP: 178,
    MEDIA_NEXT: 176,
    MEDIA_PREV: 177,
    FAST_FORWARD: 228,
    REWIND: 227
};

class LinuxAdapter {
    constructor() {
        // Enforce singleton initialization lifecycle
        this._initialized = false;

        // Cached human-readable device name
        this._deviceName = null;

        // Tracks timestamp of last user input for screensaver coordination
        this._lastInputTime = Date.now();
    }

    /**
     * ========================================================================
     * Linux Adapter Bootstrap
     * ========================================================================
     * Invoked during App.init() startup sequence when running in the Linux
     * kiosk. Hooks window listeners and input event processors.
     * ========================================================================
     */
    init() {
        // Prevent duplicate initialization sequences
        if (this._initialized) {
            log.warn('LinuxAdapter already initialized, skipping bootstrap.');
            return;
        }
        this._initialized = true;

        log.info('Initializing LinuxAdapter for Linux kiosk runtime...');

        // Expose adapter reference on global window for runtime inspection
        if (typeof window !== 'undefined') {
            window.linuxAdapter = this;
        }

        // Initialize interaction timer baseline
        this._lastInputTime = Date.now();

        // Register global physical keyboard handler
        this._setupKeyHandler();

        // Register pointer and wheel listeners to report user activity
        // (no mouse normally attached, but the Pi could have one for setup)
        document.addEventListener('mousemove', () => this.reportInput(), { passive: true });
        document.addEventListener('mousedown', () => this.reportInput(), { passive: true });
        document.addEventListener('wheel', () => this.reportInput(), { passive: true });

        // Query device identity
        this._loadDeviceInfo();

        log.info('LinuxAdapter successfully initialized.');
    }

    /**
     * Retrieves idle duration in milliseconds since the last recorded interaction.
     * @returns {number} Idle duration in ms.
     */
    get idleTime() {
        return Date.now() - (this._lastInputTime || Date.now());
    }

    /**
     * Reports an active user input interaction to reset idle/screensaver timers.
     */
    reportInput() {
        this._lastInputTime = Date.now();
    }

    /**
     * @returns {boolean} True indicating this is the Linux kiosk runtime.
     */
    get isLinuxKiosk() {
        return true;
    }

    /**
     * ========================================================================
     * Physical Keyboard Handler
     * ========================================================================
     * Listens for physical keyboard events (remapped remote input, in the
     * finished appliance) across the entire application:
     * - Maps Arrow keys to directional spatial navigation events.
     * - Maps Home to jumping to the home screen.
     * - Maps Escape and Backspace to unified back navigation.
     * - Maps Space and standard media keys to playback controls.
     * ========================================================================
     * @private
     */
    _setupKeyHandler() {
        document.addEventListener('keydown', (e) => {
            // Register interaction timestamp immediately
            this.reportInput();

            const keyCode = e.keyCode;

            // Identify whether user is actively typing inside an input or textarea
            const activeElem = document.activeElement;
            const isTextInput =
                Boolean(activeElem) &&
                (activeElem.tagName === 'TEXTAREA' ||
                    activeElem.isContentEditable ||
                    (activeElem.tagName === 'INPUT' &&
                        !['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(activeElem.type)));

            // -----------------------------------------------------------------
            // Form Input Field Guard: Allow All Letters and Characters
            // -----------------------------------------------------------------
            // When user is typing inside an input field, textarea, or editable element,
            // never intercept or suppress any typing, editing, navigation, or letter keys.
            if (isTextInput) {
                // Escape always triggers back navigation / dialog dismissal
                if (keyCode === LINUX_KEYS.ESCAPE) {
                    e.preventDefault();
                    eventBus.emit('key:back', e);
                    return;
                }

                // Let all other keys pass through to native text input handling.
                return;
            }

            // Detect if video player is currently active in view
            const isPlayerActive = window.location.hash.startsWith('#/player');

            // -----------------------------------------------------------------
            // Directional Key Suppression
            // -----------------------------------------------------------------
            // Prevent default browser scrolling when browsing outside form inputs
            const navKeys = [LINUX_KEYS.LEFT, LINUX_KEYS.RIGHT, LINUX_KEYS.UP, LINUX_KEYS.DOWN, LINUX_KEYS.ENTER];
            if (isPlayerActive && keyCode === LINUX_KEYS.SPACE) {
                navKeys.push(LINUX_KEYS.SPACE);
            }
            if (navKeys.includes(keyCode)) {
                e.preventDefault();
            }

            // -----------------------------------------------------------------
            // Central Key Mapping Switch
            // -----------------------------------------------------------------
            switch (keyCode) {
                // Space bar play/pause toggle when player view is active
                case LINUX_KEYS.SPACE:
                    if (isPlayerActive) {
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                    }
                    break;

                // Directional D-Pad navigation
                case LINUX_KEYS.LEFT:
                    eventBus.emit('key:left', e);
                    break;
                case LINUX_KEYS.RIGHT:
                    eventBus.emit('key:right', e);
                    break;
                case LINUX_KEYS.UP:
                    eventBus.emit('key:up', e);
                    break;
                case LINUX_KEYS.DOWN:
                    eventBus.emit('key:down', e);
                    break;

                // Enter / Selection
                case LINUX_KEYS.ENTER:
                    eventBus.emit('key:enter', e);
                    break;

                // Escape always triggers back navigation
                case LINUX_KEYS.ESCAPE:
                    e.preventDefault();
                    eventBus.emit('key:back', e);
                    break;

                // Backspace acts as Back
                case LINUX_KEYS.BACKSPACE:
                    e.preventDefault();
                    eventBus.emit('key:back', e);
                    break;

                // Home jumps to the home screen
                case LINUX_KEYS.HOME:
                    e.preventDefault();
                    router.navigate('/home');
                    break;

                // Media Play / Pause keys
                case LINUX_KEYS.MEDIA_PLAY:
                    e.preventDefault();
                    eventBus.emit('key:play', e);
                    break;

                case LINUX_KEYS.MEDIA_PAUSE:
                    e.preventDefault();
                    eventBus.emit('key:pause', e);
                    break;

                case LINUX_KEYS.MEDIA_PLAY_PAUSE:
                    e.preventDefault();
                    eventBus.emit('key:playPause', e);
                    break;

                case LINUX_KEYS.MEDIA_STOP:
                    e.preventDefault();
                    eventBus.emit('key:stop', e);
                    break;

                case LINUX_KEYS.MEDIA_NEXT:
                    e.preventDefault();
                    eventBus.emit('key:next', e);
                    break;

                case LINUX_KEYS.MEDIA_PREV:
                    e.preventDefault();
                    eventBus.emit('key:previous', e);
                    break;

                case LINUX_KEYS.REWIND:
                    e.preventDefault();
                    eventBus.emit('key:rewind', e);
                    break;

                case LINUX_KEYS.FAST_FORWARD:
                    e.preventDefault();
                    eventBus.emit('key:fastForward', e);
                    break;

                default:
                    // Broadcast generic key for unmapped or custom bindings
                    eventBus.emit('key:any', { keyCode, event: e });
                    break;
            }
        });
    }

    /**
     * ========================================================================
     * Device Information Discovery
     * ========================================================================
     * @private
     */
    _loadDeviceInfo() {
        this._deviceName = 'Litefin Linux Kiosk (Raspberry Pi)';
        log.info(`Detected device: ${this._deviceName}`);
    }

    /**
     * Retrieves the human-readable device name for Jellyfin authorization.
     * @returns {string} Device name identifier.
     */
    getDeviceName() {
        if (!this._deviceName) {
            this._loadDeviceInfo();
        }
        return this._deviceName || 'Litefin Linux Kiosk';
    }

    /**
     * ========================================================================
     * Application Exit Handler
     * ========================================================================
     * Flushes pending storage state to disk. Does not actually exit/reboot/
     * shut down yet - routes through the Phase 3 bridge daemon once it exists.
     */
    exit() {
        log.info('Exit requested - no bridge daemon yet, flushing storage only.');
        storage.flush();
    }
}

// Export singleton instance and class definition
export const linuxAdapter = new LinuxAdapter();
export default linuxAdapter;
