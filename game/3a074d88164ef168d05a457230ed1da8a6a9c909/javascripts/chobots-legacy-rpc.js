(function (root, factory) {
    "use strict";
    var api = factory(root);
    if (typeof module === "object" && module.exports) module.exports = api;
    root.chobotsLegacyRpc = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
    "use strict";

    var BOOTSTRAP_KEY = [67, 104, 111, 98, 111, 116, 115, 87, 83, 75, 101, 121, 49, 54, 33, 63];
    var MAX_FRAME_BYTES = 256 * 1024;
    var DEFAULT_TIMEOUT_MS = 10 * 1000;
    var activeSession = null;

    function encodedLength(value) {
        return new TextEncoder().encode(value).byteLength;
    }

    function assertBoundedJson(value) {
        var json = JSON.stringify(value);
        if (json === undefined) throw new TypeError("legacy RPC payload is not JSON serializable");
        if (encodedLength(json) > MAX_FRAME_BYTES) throw rpcError("frame_too_large", "legacy RPC payload exceeds 256 KiB");
        return json;
    }

    function bytesToBase64(bytes) {
        var binary = "";
        for (var offset = 0; offset < bytes.length; offset += 32768) {
            binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + 32768, bytes.length)));
        }
        return btoa(binary);
    }

    function base64ToBytes(value) {
        if (typeof value !== "string" || value.length > Math.ceil(MAX_FRAME_BYTES * 4 / 3) + 4) {
            throw rpcError("frame_too_large", "legacy RPC payload exceeds 256 KiB");
        }
        var binary = atob(value);
        if (binary.length > MAX_FRAME_BYTES) throw rpcError("frame_too_large", "legacy RPC payload exceeds 256 KiB");
        var bytes = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    }

    function xor(bytes) {
        var result = new Uint8Array(bytes.length);
        for (var index = 0; index < bytes.length; index += 1) {
            result[index] = bytes[index] ^ BOOTSTRAP_KEY[index % BOOTSTRAP_KEY.length];
        }
        return result;
    }

    function encodeBootstrapPayload(value) {
        return bytesToBase64(xor(new TextEncoder().encode(assertBoundedJson(value))));
    }

    function decodeBootstrapPayload(value) {
        var decoded = new TextDecoder("utf-8", { fatal: true }).decode(xor(base64ToBytes(value)));
        if (encodedLength(decoded) > MAX_FRAME_BYTES) throw rpcError("frame_too_large", "legacy RPC payload exceeds 256 KiB");
        return JSON.parse(decoded);
    }

    function rpcError(code, message) {
        var error = new Error(message);
        error.code = code;
        return error;
    }

    function responseError(value) {
        if (value && typeof value === "object") return value;
        return rpcError("remote_error", value == null ? "legacy RPC call failed" : String(value));
    }

    function decodeFrameType(value) {
        if (value === "r") return "result";
        if (value === "e") return "error";
        return value;
    }

    function timeoutMs(options) {
        var value = options && Number(options.timeoutMs);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
    }

    function RpcSession(callTimeoutMs) {
        this.callTimeoutMs = callTimeoutMs;
        this.connected = false;
        this.closed = false;
        this.nextRequestId = 1;
        this.pending = new Map();
        this.unsubscribe = null;
        this.disconnectCalled = false;
    }

    RpcSession.prototype.call = function (service, method, args) {
        var session = this;
        if (!session.connected || session.closed) return Promise.reject(rpcError("session_closed", "legacy RPC session closed"));
        var requestId = String(session.nextRequestId++);
        var frame;
        try {
            frame = ["c", requestId, encodeBootstrapPayload([service, method, args || []])];
            if (encodedLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) {
                throw rpcError("frame_too_large", "legacy RPC frame exceeds 256 KiB");
            }
        } catch (error) {
            return Promise.reject(error);
        }
        return new Promise(function (resolve, reject) {
            var timer = root.setTimeout(function () {
                session.pending.delete(requestId);
                reject(rpcError("rpc_timeout", "legacy RPC call timed out after " + session.callTimeoutMs + "ms"));
            }, session.callTimeoutMs);
            session.pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
            try {
                root.chobotsWsSend(frame);
            } catch (error) {
                root.clearTimeout(timer);
                session.pending.delete(requestId);
                reject(error);
            }
        });
    };

    RpcSession.prototype.onFrame = function (frame) {
        if (this.closed || !Array.isArray(frame)) return;
        if (encodedLength(assertBoundedJson(frame)) > MAX_FRAME_BYTES) {
            this.close("frame_too_large");
            return;
        }
        var frameType = decodeFrameType(String(frame[0]));
        if (frameType !== "result" && frameType !== "error") return;
        var requestId = String(frame[1]);
        var pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        root.clearTimeout(pending.timer);
        try {
            var encoding = frame[3] == null ? "simple-xor-json" : String(frame[3]);
            var payload = encoding === "simple-xor-json" ? decodeBootstrapPayload(frame[2]) : frame[2];
            assertBoundedJson(payload);
            if (frameType === "error") pending.reject(responseError(payload));
            else pending.resolve(payload);
        } catch (error) {
            pending.reject(error);
        }
    };

    RpcSession.prototype.close = function (reason) {
        if (this.closed) return;
        this.closed = true;
        this.connected = false;
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        this.pending.forEach(function (pending) {
            root.clearTimeout(pending.timer);
            pending.reject(rpcError("session_closed", "legacy RPC session closed"));
        });
        this.pending.clear();
        if (!this.disconnectCalled) {
            this.disconnectCalled = true;
            root.chobotsWsDisconnect(reason || "client_disconnect");
        }
        if (activeSession === this) activeSession = null;
    };

    function connect(url, options) {
        if (activeSession && !activeSession.closed) {
            return Promise.reject(rpcError("session_active", "a legacy RPC session is already active"));
        }
        if (typeof root.chobotsObserveWs !== "function"
            || typeof root.chobotsWsConnect !== "function"
            || typeof root.chobotsWsSend !== "function"
            || typeof root.chobotsWsDisconnect !== "function") {
            return Promise.reject(rpcError("bridge_unavailable", "legacy RPC WebSocket bridge is unavailable"));
        }

        var session = new RpcSession(timeoutMs(options));
        activeSession = session;
        return new Promise(function (resolve, reject) {
            var settled = false;
            var connectionTimer = root.setTimeout(function () {
                if (settled) return;
                settled = true;
                session.close("connect_timeout");
                reject(rpcError("connect_timeout", "legacy RPC connection timed out"));
            }, session.callTimeoutMs);

            function fail(error, reason) {
                if (settled) {
                    session.close(reason);
                    return;
                }
                settled = true;
                root.clearTimeout(connectionTimer);
                session.close(reason);
                reject(error);
            }

            session.unsubscribe = root.chobotsObserveWs(function (event) {
                if (!event || session.closed) return;
                if (event.type === "open" && !settled) {
                    settled = true;
                    root.clearTimeout(connectionTimer);
                    session.connected = true;
                    resolve(session);
                } else if (event.type === "frame") {
                    session.onFrame(event.frame);
                } else if (event.type === "error") {
                    fail(responseError(event.detail), "transport_error");
                } else if (event.type === "close") {
                    fail(rpcError("transport_closed", "legacy RPC transport closed"), "transport_closed");
                }
            });

            try {
                root.chobotsWsConnect(url, {});
            } catch (error) {
                fail(error, "connect_failed");
            }
        });
    }

    return {
        connect: connect,
        encode: encodeBootstrapPayload,
        decode: decodeBootstrapPayload
    };
});
