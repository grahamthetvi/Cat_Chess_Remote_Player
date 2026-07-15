const trueDefaultSettings = 
// When updated, update the README
{
    // possible values: "left", "right", "up", "down"
    "sidebarEdge": "left",
    // Cloudflare Tunnel + WebSocket: 720p/2500 still overflows (purple blank
    // video while audio/mouse work). Prefer 540p @ ~1.5 Mbps.
    "bitrate": 1500,
    "fps": 30,
    "videoFrameQueueSize": 5,
    // possible values: "720p", "1080p", "1440p", "4k", "native", "custom"
    "videoSize": "custom",
    // only works if videoSize=custom
    "videoSizeCustom": {
        "width": 960,
        "height": 540
    },
    // possible values: "h264", "h265", "av1", "auto"
    "videoCodec": "h264",
    "forceVideoElementRenderer": false,
    // Canvas + VideoDecoder avoids MediaStreamTrackGenerator edge cases in Chrome
    // and matches the Firefox WebSocket path more closely.
    "canvasRenderer": true,
    // Canvas only: when true, draw only on requestAnimationFrame (stable, may add ~0–17 ms). When false, draw on frame submit (low latency).
    "canvasVsync": false,
    "playAudioLocal": false,
    "audioSampleQueueSize": 20,
    // possible values: "highres", "normal"
    "mouseScrollMode": "highres",
    // possible values: "relative", "follow", "pointAndDrag"
    "mouseMode": "follow",
    // possible values: "touch", "mouseRelative", "localCursor", "pointAndDrag"
    "touchMode": "mouseRelative",
    "localCursorSensitivity": 1,
    "controllerConfig": {
        "invertAB": false,
        "invertXY": false,
        // possible values: null or a number, example: 60, 120
        "sendIntervalOverride": null
    },
    // possible values: "auto", "webrtc", "websocket"
    // Force WebSocket for Cloudflare Tunnel / HTTPS reverse-proxy setups.
    // WebRTC UDP cannot traverse the tunnel; WebSocket reuses the HTTPS path.
    "dataTransport": "websocket",
    "language": "en",
    "enterFullscreenOnStreamStart": false,
    "toggleFullscreenWithKeybind": false,
    // possible values: "standard", "old"
    "pageStyle": "standard",
    "hdr": false,
    "useSelectElementPolyfill": false,
    // Bump when tunnel-safe defaults change so stale localStorage cannot force 1080p/10Mbps.
    "_tunnelSchema": 4
};
export default trueDefaultSettings;
