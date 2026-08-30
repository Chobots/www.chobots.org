(function (window) {
    "use strict";

    function browserCloseCode(code) {
        return code === 1000 || (code >= 3000 && code <= 4999) ? code : 4000 + (code % 1000);
    }

    var socket = null;
    var socketUrl = null;
    var localTransport = null;
    var relayDisconnectTimer = null;
    var relayHandshakeRetryTimer = null;
    function relayGuestMode() {
        return Boolean(window.chobotsPlayMode && window.chobotsPlayMode.kind === "guest");
    }
    function canonicalNetworkUrl(url) {
        var link = document.createElement("a");
        link.href = url;
        return link.href;
    }
    var unsubscribeLocalActions = null;
    var LOCAL_URL = "chobots-browser://local";
    var MAX_GAME_FRAME_BYTES = 256 * 1024;
    var diagnostics = /(?:^|[?&])wsDebug=1(?:&|$)/.test(window.location.search);
    window.chobotsTransportDiagnostics = { status: "closed", mode: null, lastError: null, frames: [] };

    function recordFrame(direction, frame) {
        if (!diagnostics) return;
        window.chobotsTransportDiagnostics.frames.push({ direction: direction, frame: frame });
    }

    function setTransportStatus(status, mode, error) {
        window.chobotsTransportDiagnostics.status = status;
        window.chobotsTransportDiagnostics.mode = mode || null;
        window.chobotsTransportDiagnostics.lastError = error || null;
    }

    function serializedFrame(frame) {
        var text = JSON.stringify(frame);
        if (new TextEncoder().encode(text).byteLength > MAX_GAME_FRAME_BYTES) throw { code: "frame_too_large", message: "game frame exceeds the protocol size limit" };
        return text;
    }

    function log() {
        if (diagnostics && window.console && console.log) {
            console.log.apply(console, arguments);
        }
    }

    function swf() {
        return window.ch_game_window || document.querySelector("ruffle-player, object, embed");
    }

    function callSwf(name, args) {
        var target = swf();
        if (target && typeof target[name] === "function") {
            try {
                target[name].apply(target, args || []);
            } catch (error) {
                log("SWF callback failed", name, error);
            }
        }
    }

    function closeLocal(transport, code, reason, notify) {
        if (!transport || transport.closed) return;
        transport.closed = true;
        if (localTransport === transport) localTransport = null;
        if (unsubscribeLocalActions) {
            unsubscribeLocalActions();
            unsubscribeLocalActions = null;
        }
        setTransportStatus("closed", "local");
        var disconnectReason = reason === "client_disconnect" ? reason : "transport_lost";
        window.chobotsBrowserHost.disconnect(transport.peerId, disconnectReason).catch(function () {});
        if (notify) callSwf("chobotsOnWsClose", [{ code: code || 1000, reason: reason || "client_disconnect" }]);
    }

    function deliverLocalActions(transport, response) {
        if (!response || response.type !== "actions") return;
        (response.actions || []).forEach(function (action) {
            var send = action.Send;
            var close = action.Close;
            if (send && send.peer_id === transport.peerId) {
                recordFrame("in", send.frame);
                callSwf("chobotsOnWsFrame", [send.frame]);
            } else if (close && close.peer_id === transport.peerId) {
                recordFrame("close", { code: close.code, reason: close.reason });
                closeLocal(transport, close.code, close.reason, true);
            }
        });
    }

    function connectLocal(url) {
        if (!window.chobotsBrowserHost) {
            var unavailable = { code: "host_unavailable", message: "browser host is unavailable" };
            setTransportStatus("error", "local", unavailable);
            callSwf("chobotsOnWsError", [unavailable]);
            return;
        }
        var transport = { peerId: "local-ruffle", closed: false };
        localTransport = transport;
        if (typeof window.chobotsBrowserHost.onActions === "function") {
            unsubscribeLocalActions = window.chobotsBrowserHost.onActions(function (actions) {
                if (localTransport === transport && !transport.closed) deliverLocalActions(transport, { type: "actions", actions: actions });
            });
        }
        setTransportStatus("connecting", "local");
        window.chobotsBrowserHost.connect(transport.peerId).then(function (response) {
            if (localTransport !== transport || transport.closed) return;
            setTransportStatus("open", "local");
            callSwf("chobotsOnWsOpen", [{ url: url }]);
        }).catch(function (error) {
            if (localTransport !== transport || transport.closed) return;
            var detail = { code: error.code || "local_connect_failed", message: error.message || String(error) };
            setTransportStatus("error", "local", detail);
            callSwf("chobotsOnWsError", [detail]);
            closeLocal(transport, 1011, detail.code, true);
        });
    }

    function connectNetwork(url, retriesRemaining) {
        var nextSocket = new WebSocket(url);
        var opened = false;
        var pendingError = null;
        socket = nextSocket;
        socketUrl = url;
        setTransportStatus("connecting", "websocket");
        nextSocket.onopen = function () {
            opened = true;
            setTransportStatus("open", "websocket");
            callSwf("chobotsOnWsOpen", [{ url: url }]);
        };
        nextSocket.onclose = function (event) {
            if (nextSocket.__chobotsSuppressClose) return;
            if (socket === nextSocket) {
                socket = null;
                socketUrl = null;
            }
            if (!opened && retriesRemaining > 0 && relayGuestMode() && event.code === 1006) {
                setTransportStatus("connecting", "websocket");
                relayHandshakeRetryTimer = window.setTimeout(function () {
                    relayHandshakeRetryTimer = null;
                    if (socket === null) connectNetwork(url, retriesRemaining - 1);
                }, 100);
                return;
            }
            if (pendingError) {
                setTransportStatus("error", "websocket", pendingError);
                callSwf("chobotsOnWsError", [pendingError]);
            }
            setTransportStatus("closed", "websocket");
            callSwf("chobotsOnWsClose", [{ code: event.code, reason: event.reason }]);
            var relayStatus = document.getElementById("chobotsRelayGuestText") || document.getElementById("chobotsRelayGuestStatus");
            if (relayStatus && relayGuestMode()) relayStatus.textContent = event.code === 1008 ? "invite invalid or expired" : "relay disconnected";
        };
        nextSocket.onerror = function () {
            var error = { code: "websocket_error", message: "WebSocket error" };
            if (!opened && retriesRemaining > 0 && relayGuestMode()) pendingError = error;
            else {
                setTransportStatus("error", "websocket", error);
                callSwf("chobotsOnWsError", [error]);
            }
        };
        nextSocket.onmessage = function (event) {
            try {
                if (typeof event.data !== "string" || new TextEncoder().encode(event.data).byteLength > MAX_GAME_FRAME_BYTES) throw { code: "frame_too_large", message: "game frame exceeds the protocol size limit" };
                callSwf("chobotsOnWsFrame", [JSON.parse(event.data)]);
            } catch (error) {
                var detail = error && error.code ? error : { code: "invalid_frame", message: String(error) };
                callSwf("chobotsOnWsError", [detail]);
                nextSocket.close(browserCloseCode(detail.code === "frame_too_large" ? 1009 : 1008), detail.code);
            }
        };
    }

    window.chobotsWsConnect = function (url, clientMetadata) {
        log("ws connect", url, clientMetadata || {});
        if (relayHandshakeRetryTimer !== null) {
            window.clearTimeout(relayHandshakeRetryTimer);
            relayHandshakeRetryTimer = null;
        }
        // The browser-host runtime advertises a logical local address even to
        // relayed clients. A relay guest is already connected to that runtime
        // through its standalone relay tunnel; preserve the physical WSS
        // socket across the legacy client's logical server-selection cycle.
        if (url === LOCAL_URL
            && relayGuestMode()
            && socket
            && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            if (relayDisconnectTimer !== null) {
                window.clearTimeout(relayDisconnectTimer);
                relayDisconnectTimer = null;
            }
            socket.__chobotsSuppressClose = false;
            setTransportStatus("open", "websocket");
            callSwf("chobotsOnWsOpen", [{ url: url }]);
            return;
        }
        if (socket
            && socketUrl
            && canonicalNetworkUrl(socketUrl) === canonicalNetworkUrl(url)
            && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            setTransportStatus(socket.readyState === WebSocket.OPEN ? "open" : "connecting", "websocket");
            if (socket.readyState === WebSocket.OPEN)
                callSwf("chobotsOnWsOpen", [{ url: url }]);
            return;
        }
        if (socket) {
            socket.__chobotsSuppressClose = true;
            socket.close(1000, "reconnect");
        }
        if (localTransport) closeLocal(localTransport, 1000, "reconnect", false);
        if (url === LOCAL_URL) {
            connectLocal(url);
            return;
        }
        connectNetwork(url, relayGuestMode() ? 1 : 0);
    };

    window.chobotsWsDisconnect = function (reason) {
        if (relayHandshakeRetryTimer !== null) {
            window.clearTimeout(relayHandshakeRetryTimer);
            relayHandshakeRetryTimer = null;
        }
        if (localTransport) {
            closeLocal(localTransport, 1000, reason || "client_disconnect", true);
            return;
        }
        if (socket) {
            if (reason === "client_disconnect"
                && relayGuestMode()) {
                var relaySocket = socket;
                if (relayDisconnectTimer !== null) window.clearTimeout(relayDisconnectTimer);
                relayDisconnectTimer = window.setTimeout(function () {
                    relayDisconnectTimer = null;
                    if (socket === relaySocket) relaySocket.close(1000, reason);
                // The legacy client briefly disconnects while switching from
                // the relay URL to the host runtime's logical local URL.
                // Under load that follow-up can arrive on a later task, so
                // retain the physical relay tunnel for a bounded grace period.
                }, 1000);
                return;
            }
            socket.close(1000, reason || "client_disconnect");
        }
    };

    window.chobotsWsSend = function (frame) {
        recordFrame("out", frame);
        if (localTransport) {
            if (localTransport.closed || window.chobotsTransportDiagnostics.status !== "open") {
                throw new Error("Local browser transport is not open");
            }
            var byteLength;
            try {
                byteLength = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
            } catch (error) {
                callSwf("chobotsOnWsError", [{ code: "invalid_frame", message: String(error) }]);
                return;
            }
            if (byteLength > MAX_GAME_FRAME_BYTES) {
                var tooLarge = { code: "frame_too_large", message: "game frame exceeds the protocol size limit" };
                callSwf("chobotsOnWsError", [tooLarge]);
                closeLocal(localTransport, 1009, tooLarge.code, true);
                return;
            }
            var transport = localTransport;
            log("local send", Array.isArray(frame) ? frame[0] : frame && (frame.t || frame.type));
            window.chobotsBrowserHost.send(transport.peerId, frame).then(function () {
            }).catch(function (error) {
                if (localTransport !== transport || transport.closed) return;
                var detail = { code: error.code || "local_send_failed", message: error.message || String(error) };
                setTransportStatus("error", "local", detail);
                callSwf("chobotsOnWsError", [detail]);
                closeLocal(transport, 1011, detail.code, true);
            });
            return;
        }
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket is not open");
        }
        log("ws send", Array.isArray(frame) ? frame[0] : frame && (frame.t || frame.type), Array.isArray(frame) ? frame[1] : frame && (frame.i || frame.id), frame && (frame.e || frame.payloadEncoding));
        try {
            socket.send(serializedFrame(frame));
        } catch (error) {
            var detail = error && error.code ? error : { code: "invalid_frame", message: String(error) };
            callSwf("chobotsOnWsError", [detail]);
            socket.close(browserCloseCode(detail.code === "frame_too_large" ? 1009 : 1008), detail.code);
        }
    };
})(window);
