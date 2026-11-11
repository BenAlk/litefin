/**
 * ============================================================================
 * Litefin Linux Kiosk — Device Profile
 * ============================================================================
 * Capability detection and Jellyfin profile generation for the Raspberry Pi
 * kiosk build, which plays media via the VLC bridge daemon (VlcBridgePlayer)
 * rather than through browser decoders. Capabilities below reflect VLC's
 * tested support on this hardware (see phase1/test-matrix.md), not the
 * Chromium kiosk tab's own (irrelevant) media capabilities.
 * ============================================================================
 */

import { BaseProfile } from './BaseProfile.js';

let _cachedCapabilities = null;

export function getDeviceCapabilities() {
    if (_cachedCapabilities) return _cachedCapabilities;

    _cachedCapabilities = {
        modelName: 'Litefin Linux Kiosk (Raspberry Pi)',
        deviceId: BaseProfile.getFallbackDeviceId('litefin_linux_'),
        screenWidth: 1920,
        screenHeight: 1080,
        uhd: true,
        uhd8K: false,
        hdr10: false,
        hdr10Plus: false,
        hlg: false,
        dolbyVision: true,
        hevc: true,
        av1: false,
        vp9: false,
        vp8: false,
        ac3: true,
        eac3: true,
        dts: true,
        truehd: true,
        mpeg2video: true,
        mpegts: true,
        mp2: true,
        maxAudioChannels: 8
    };
    return _cachedCapabilities;
}

export function clearCapabilitiesCache() {
    _cachedCapabilities = null;
}

export function buildJellyfinProfile(options = {}) {
    const caps = getDeviceCapabilities();
    const maxBitrate = (options && options.manualBitrate) || 120000000;

    const videoCodecs = ['hevc', 'h264'];
    const audioCodecs = ['aac', 'mp3', 'flac', 'opus', 'ac3', 'eac3', 'dts', 'truehd'];
    const audioCodecString = audioCodecs.join(',');

    return {
        Name: 'Litefin Linux Kiosk (VLC Bridge)',
        MaxStreamingBitrate: maxBitrate,
        MaxStaticBitrate: maxBitrate,
        MaxStaticMusicBitrate: 40000000,
        MusicStreamingTranscodingBitrate: 192000,
        DirectPlayProfiles: [
            {
                Container: 'mkv,mp4,m4v,ts',
                Type: 'Video',
                VideoCodec: videoCodecs.join(','),
                AudioCodec: audioCodecString
            },
            {
                Container: 'mp3,flac,aac,m4a,m4b,ogg,opus,wav',
                Type: 'Audio',
                AudioCodec: audioCodecString
            }
        ],
        TranscodingProfiles: [
            {
                Container: 'ts',
                Type: 'Video',
                AudioCodec: audioCodecString,
                VideoCodec: videoCodecs.join(','),
                Context: 'Streaming',
                Protocol: 'hls',
                MaxAudioChannels: String(caps.maxAudioChannels),
                MinSegments: '1',
                BreakOnNonKeyFrames: true
            },
            {
                Container: 'mp3',
                Type: 'Audio',
                AudioCodec: 'mp3',
                Context: 'Streaming',
                Protocol: 'http'
            }
        ],
        CodecProfiles: [
            {
                Type: 'Video',
                Codec: 'h264',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        Property: 'VideoProfile',
                        Value: 'high|main|baseline|constrained baseline',
                        IsRequired: false
                    },
                    // H.264 direct-play is capped at a 1080p-equivalent level regardless of
                    // the `uhd` flag above, which only applies to HEVC — Phase 1 never
                    // validated 4K H.264 on this hardware. Above this, the server transcodes.
                    { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '41', IsRequired: false },
                    { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false },
                    { Condition: 'EqualsAny', Property: 'VideoRangeType', Value: 'SDR', IsRequired: false }
                ]
            },
            {
                Type: 'Video',
                Codec: 'hevc',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        Property: 'VideoProfile',
                        Value: 'main|main 10',
                        IsRequired: false
                    },
                    // SDR and the HDR10-compatible Dolby Vision base layer ('DOVIWithHDR10')
                    // direct-play. Raw HDR10 is excluded (capabilities.hdr10 = false above —
                    // Phase 1 only validated DV7/8 with its HDR10 fallback, not plain HDR10),
                    // and raw Dolby Vision profile 5 ('DOVI') is excluded too since it has no
                    // fallback base layer and Phase 1 never validated it on this hardware —
                    // matches "Dolby Vision 7/8 direct-play with HDR10 fallback (profile 5
                    // transcodes)" from the design spec.
                    {
                        Condition: 'EqualsAny',
                        Property: 'VideoRangeType',
                        Value: 'SDR|DOVIWithHDR10',
                        IsRequired: false
                    },
                    { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '10', IsRequired: false }
                ]
            },
            // ---------------------------------------------------------------------
            // Audio Channel Cap Conditions
            // ---------------------------------------------------------------------
            {
                Type: 'VideoAudio',
                Conditions: [
                    {
                        Condition: 'LessThanEqual',
                        Property: 'AudioChannels',
                        Value: String(caps.maxAudioChannels),
                        IsRequired: false
                    }
                ]
            },
            {
                Type: 'Audio',
                Conditions: [
                    {
                        Condition: 'LessThanEqual',
                        Property: 'AudioChannels',
                        Value: String(caps.maxAudioChannels),
                        IsRequired: false
                    }
                ]
            }
        ],
        SubtitleProfiles: BaseProfile.getSubtitleProfiles(),
        ResponseProfiles: BaseProfile.getResponseProfiles()
    };
}

export function getDeviceId() {
    return getDeviceCapabilities().deviceId;
}

export function getDeviceName() {
    return getDeviceCapabilities().modelName;
}

export default {
    getDeviceCapabilities,
    clearCapabilitiesCache,
    buildJellyfinProfile,
    getDeviceId,
    getDeviceName
};
