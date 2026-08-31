(function (root, factory) {
    "use strict";
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.chobotsWebSocketTransport = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    var LOCAL_URL = "chobots-browser://local";
    var MAX_FRAME_BYTES = 256 * 1024;

    function create(root) {
        var socket = null;
        var socketUrl = null;
        var local = null;
        var unsubscribeLocal = null;
        var observers = new Set();
        var retryTimer = null;
        var relayCloseTimer = null;
        var terminal = false;

        function emit(event) {
            observers.forEach(function (listener) {
                try { listener(event); } catch (_) {}
            });
        }
        function relayGuest() {
            return Boolean(root.chobotsPlayMode && root.chobotsPlayMode.kind === "guest");
        }
        function canonical(url) {
            var anchor = root.document.createElement("a");
            anchor.href = url;
            return anchor.href;
        }
        function bounded(frame) {
            var text = JSON.stringify(frame);
            if (new root.TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES) {
                var error = new Error("game frame exceeds the protocol size limit");
                error.code = "frame_too_large";
                throw error;
            }
            return text;
        }
        function closeLocal(reason, notify) {
            if (!local || local.closed) return;
            var current = local;
            current.closed = true;
            local = null;
            if (unsubscribeLocal) { unsubscribeLocal(); unsubscribeLocal = null; }
            root.chobotsBrowserHost.disconnect(current.peerId, reason === "client_disconnect" ? reason : "transport_lost").catch(function () {});
            if (notify) emit({ type: "close", detail: { code: 1000, reason: reason || "client_disconnect" } });
        }
        function deliverLocal(actions) {
            if (!local || !actions) return;
            (actions.actions || actions).forEach(function (action) {
                if (action.Send && action.Send.peer_id === local.peerId) emit({ type: "frame", frame: action.Send.frame });
                if (action.Close && action.Close.peer_id === local.peerId) {
                    var detail = { code: action.Close.code, reason: action.Close.reason };
                    closeLocal(detail.reason, false);
                    emit({ type: "close", detail: detail });
                }
            });
        }
        function connectLocal(url) {
            if (!root.chobotsBrowserHost) { emit({ type: "error", detail: { code: "host_unavailable", message: "browser host is unavailable" } }); return; }
            local = { peerId: "local-svg-widget", closed: false, open: false };
            if (typeof root.chobotsBrowserHost.onActions === "function") unsubscribeLocal = root.chobotsBrowserHost.onActions(deliverLocal);
            root.chobotsBrowserHost.connect(local.peerId).then(function () {
                if (!local || local.closed) return;
                local.open = true;
                emit({ type: "open", detail: { url: url } });
            }).catch(function (error) {
                emit({ type: "error", detail: { code: error.code || "local_connect_failed", message: error.message || String(error) } });
                closeLocal("transport_lost", true);
            });
        }
        function connectNetwork(url, retries) {
            var current = new root.WebSocket(url);
            var opened = false;
            var pendingError = null;
            socket = current;
            socketUrl = url;
            current.onopen = function () { if (socket !== current || terminal) return; opened = true; emit({ type: "open", detail: { url: url } }); };
            current.onmessage = function (event) {
                try {
                    if (typeof event.data !== "string" || new root.TextEncoder().encode(event.data).byteLength > MAX_FRAME_BYTES) throw Object.assign(new Error("frame too large"), { code: "frame_too_large" });
                    emit({ type: "frame", frame: JSON.parse(event.data) });
                } catch (error) {
                    emit({ type: "error", detail: { code: error.code || "invalid_frame", message: error.message || String(error) } });
                    current.close(error.code === "frame_too_large" ? 4009 : 4008, error.code || "invalid_frame");
                }
            };
            current.onerror = function () {
                var detail = { code: "websocket_error", message: "WebSocket error" };
                if (!opened && retries > 0 && relayGuest()) pendingError = detail;
                else emit({ type: "error", detail: detail });
            };
            current.onclose = function (event) {
                if (current.__chobotsSuppressClose || terminal) return;
                if (socket === current) { socket = null; socketUrl = null; }
                if (!opened && retries > 0 && relayGuest() && event.code === 1006) {
                    retryTimer = root.setTimeout(function () { retryTimer = null; if (!socket && !terminal) connectNetwork(url, retries - 1); }, 100);
                    return;
                }
                if (pendingError) emit({ type: "error", detail: pendingError });
                terminal = true;
                emit({ type: "close", detail: { code: event.code, reason: event.reason } });
            };
        }
        function connect(url) {
            terminal = false;
            if (url === LOCAL_URL && relayGuest() && socket && socket.readyState <= 1) { emit({ type: "open", detail: { url: url } }); return; }
            if (socket && socketUrl && canonical(socketUrl) === canonical(url) && socket.readyState <= 1) { if (socket.readyState === 1) emit({ type: "open", detail: { url: url } }); return; }
            if (socket) { socket.__chobotsSuppressClose = true; socket.close(1000, "reconnect"); }
            if (local) closeLocal("reconnect", false);
            if (url === LOCAL_URL) connectLocal(url); else connectNetwork(url, relayGuest() ? 1 : 0);
        }
        function send(frame) {
            var text = bounded(frame);
            if (local) {
                if (!local.open || local.closed) throw new Error("Local browser transport is not open");
                root.chobotsBrowserHost.send(local.peerId, frame).catch(function (error) { emit({ type: "error", detail: { code: error.code || "local_send_failed", message: error.message || String(error) } }); });
                return;
            }
            if (!socket || socket.readyState !== 1) throw new Error("WebSocket is not open");
            socket.send(text);
        }
        function disconnect(reason) {
            terminal = true;
            if (retryTimer !== null) { root.clearTimeout(retryTimer); retryTimer = null; }
            if (relayCloseTimer !== null) { root.clearTimeout(relayCloseTimer); relayCloseTimer = null; }
            if (local) { closeLocal(reason || "client_disconnect", true); return; }
            if (socket) { var current = socket; socket = null; socketUrl = null; current.close(1000, reason || "client_disconnect"); }
        }
        return {
            observe: function (listener) { if (typeof listener !== "function") throw new TypeError("observer must be a function"); observers.add(listener); return function () { observers.delete(listener); }; },
            connect: connect,
            send: send,
            disconnect: disconnect
        };
    }
    return { create: create };
});
