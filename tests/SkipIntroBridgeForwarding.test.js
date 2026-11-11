import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// ============================================================================
// Skip Intro Plugin: Bridge Forwarding Decision Test Suite
// ============================================================================
// skip-intro/index.js imports a .css file, which Node's native ESM loader
// cannot resolve (see SkipIntroAutoSkipLoop.test.js for the same pattern).
// We read the plugin source, strip static imports, and evaluate it in a vm
// context to reach the pure shouldForwardIntroToBridge() function without a
// real import.
// ============================================================================

const pluginSource = readFileSync(
    new URL('../src/plugins/installed/skip-intro/index.js', import.meta.url),
    'utf8'
)
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export function/gm, 'function')
    .replace('export default skipIntroPlugin;', '({ shouldForwardIntroToBridge, skipIntroPlugin });');

function loadPluginModule() {
    const context = vm.createContext({
        i18n: {
            t: (key) => key,
            translateDOM() {}
        },
        PlayerSettings: {
            get: () => 'Skip'
        },
        document: {
            createElement: () => ({ innerHTML: '' }),
            activeElement: null
        }
    });

    return vm.runInContext(pluginSource, context);
}

const { shouldForwardIntroToBridge } = loadPluginModule();

test('forwards when there is an intro segment and the action is AskToSkip', () => {
    assert.equal(shouldForwardIntroToBridge([{ start: 0, end: 900000000 }], 'AskToSkip'), true);
});

test('does not forward when the action is Skip (auto-skip already handles it with no UI)', () => {
    assert.equal(shouldForwardIntroToBridge([{ start: 0, end: 900000000 }], 'Skip'), false);
});

test('does not forward when the action is None', () => {
    assert.equal(shouldForwardIntroToBridge([{ start: 0, end: 900000000 }], 'None'), false);
});

test('does not forward when there is no intro segment for this item', () => {
    assert.equal(shouldForwardIntroToBridge([], 'AskToSkip'), false);
});
