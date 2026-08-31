(function (root) {
    "use strict";

    var DEFAULT_NATIVE_SERVER_CODE = "default-server";
    var DEFAULT_NATIVE_SERVER_WS_URL = "wss://default-server.chobots.org/ws/game";

    function validInviteToken(value) {
        return typeof value === "string"
            && value.length >= 1
            && value.length <= 128
            && /^[A-Za-z0-9_.~-]+$/.test(value);
    }

    function loopback(hostname) {
        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    }

    function deriveRelayOrigin(locationLike) {
        if (locationLike.protocol === "http:" && loopback(locationLike.hostname)) {
            return "ws://localhost:8080";
        }
        if (locationLike.protocol !== "https:") return null;
        var base = locationLike.hostname.replace(/^www\./i, "");
        if (!base) return null;
        return "wss://relay." + base + ":443";
    }

    function resolvePlayMode(locationLike, search) {
        var params = new URLSearchParams(search || "");
        if (params.get("serverMode") === "native") {
            return { kind: "native", relayUrl: null, inviteToken: null, wsUrl: DEFAULT_NATIVE_SERVER_WS_URL };
        }
        var token = params.get("join");
        var relayOrigin = deriveRelayOrigin(locationLike);
        if (token !== null) {
            if (token === DEFAULT_NATIVE_SERVER_CODE) {
                return { kind: "native", relayUrl: null, inviteToken: token, wsUrl: DEFAULT_NATIVE_SERVER_WS_URL };
            }
            if (!validInviteToken(token) || !relayOrigin) {
                return { kind: "invalid-guest", relayUrl: null, inviteToken: null, wsUrl: null };
            }
            return {
                kind: "guest",
                relayUrl: relayOrigin + "/v1/join/" + encodeURIComponent(token),
                inviteToken: token,
                wsUrl: null
            };
        }
        return { kind: "host", relayUrl: relayOrigin, inviteToken: null, wsUrl: null };
    }

    var api = {
        validInviteToken: validInviteToken,
        deriveRelayOrigin: deriveRelayOrigin,
        resolvePlayMode: resolvePlayMode,
        DEFAULT_NATIVE_SERVER_CODE: DEFAULT_NATIVE_SERVER_CODE,
        DEFAULT_NATIVE_SERVER_WS_URL: DEFAULT_NATIVE_SERVER_WS_URL
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root && root.location) root.chobotsPlayMode = resolvePlayMode(root.location, root.location.search);
})(typeof window !== "undefined" ? window : null);
