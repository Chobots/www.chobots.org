(function (window) {
    "use strict";

    const MAX_MESSAGE_BYTES = 256 * 1024;
    const SESSION_KEY = "chobots-relay-host";
    const peers = new Map();
    const localPolicyCloses = new WeakSet();
    function browserCloseCode(code) {
        return code === 1000 || (code >= 3000 && code <= 4999) ? code : 4000 + (code % 1000);
    }
    const encoder = new TextEncoder();
    const diagnostics = window.chobotsRelayDiagnostics = {
        status: "disconnected", peerCount: 0, inviteUrl: null, invites: [], lastError: null
    };
    let socket = null;
    let credentials = null;
    let relayUrl = null;
    let operations = Promise.resolve();
    let reconnectTimer = null;
    let reconnectDelay = 250;
    let manuallyDisconnected = false;
    let unsubscribeActions = null;
    let transitions = Promise.resolve();
    let generation = 0;

    function element(id) { return document.getElementById(id); }
    function render(status, error) {
        diagnostics.status = status;
        if (error) diagnostics.lastError = error;
        diagnostics.peerCount = peers.size;
        const statusNode = element("chobotsRelayStatus");
        const countNode = element("chobotsRelayPeerCount");
        const inviteNode = element("chobotsShareLink");
        if (statusNode) statusNode.textContent = status;
        if (countNode) countNode.textContent = String(peers.size);
        if (inviteNode) {
            inviteNode.value = diagnostics.inviteUrl || "";
        }
    }
    function fail(code, message) {
        const error = { code: code, message: message };
        diagnostics.lastError = error;
        return error;
    }
    function validId(value) {
        return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.~-]+$/.test(value);
    }
    function normalizeRelayUrl(value) {
        let parsed;
        try { parsed = new URL(value); } catch (_) { throw fail("invalid_relay_url", "relay URL must be an absolute WSS URL"); }
        const local = parsed.protocol === "ws:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
        if ((parsed.protocol !== "wss:" && !local) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
            throw fail("invalid_relay_url", "relay URL must be a credential-free WSS origin");
        }
        return parsed.origin;
    }
    function encoded(value) {
        let text;
        try { text = JSON.stringify(value); } catch (_) { throw fail("relay_frame_invalid", "relay frame is not serializable"); }
        if (typeof text !== "string") throw fail("relay_frame_invalid", "relay frame is not serializable");
        if (encoder.encode(text).byteLength > MAX_MESSAGE_BYTES) throw fail("relay_frame_too_large", "relay frame exceeds 256 KiB");
        return text;
    }
    function send(value) {
        if (!socket || socket.readyState !== window.WebSocket.OPEN) throw fail("relay_offline", "multiplayer relay is offline");
        socket.send(encoded(value));
    }
    function saveCredentials() {
        if (credentials) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ relay_url: relayUrl, instance_id: credentials.instance_id, host_capability: credentials.host_capability }));
    }
    function loadCredentials() {
        try {
            const value = JSON.parse(sessionStorage.getItem(SESSION_KEY));
            return value && validId(value.instance_id) && validId(value.host_capability) && typeof value.relay_url === "string" ? value : null;
        } catch (_) { return null; }
    }
    function inviteUrl(token) {
        const invite = new URL("/play.html", window.location.origin);
        invite.searchParams.set("join", token);
        return invite.toString();
    }
    function workerDisconnectReason(reason) {
        if (reason === "relay_host_disconnected") return "host_shutdown";
        if (reason === "relay_peer_disconnected" || reason === "runtime_closed") return "client_closed";
        return "transport_lost";
    }
    async function retirePeer(peerId, reason) {
        if (!peers.delete(peerId)) return;
        render(socket ? "multiplayer online" : "multiplayer offline");
        await window.chobotsBrowserHost.disconnect(peerId, workerDisconnectReason(reason));
    }
    async function rejectWorkerFrame(peerId, error) {
        diagnostics.lastError = error && error.code ? error : fail("relay_frame_invalid", "relay frame could not be sent");
        try { send({ type: "close_peer", peer_id: peerId, code: 1009, reason: diagnostics.lastError.code }); } catch (_) {}
        await retirePeer(peerId, diagnostics.lastError.code);
    }
    async function processWorkerActions(actions) {
        for (const action of actions || []) {
            if (action.Send) {
                const peer = peers.get(action.Send.peer_id);
                if (!peer) continue;
                const sequence = peer.outbound;
                try {
                    if (!Number.isSafeInteger(sequence) || sequence >= Number.MAX_SAFE_INTEGER) throw fail("relay_sequence_error", "relay sequence is exhausted");
                    send({ type: "frame", peer_id: action.Send.peer_id, sequence: sequence, frame: action.Send.frame });
                    peer.outbound = sequence + 1;
                } catch (error) {
                    await rejectWorkerFrame(action.Send.peer_id, error);
                }
            } else if (action.Close) {
                if (!peers.has(action.Close.peer_id)) continue;
                try { send({ type: "close_peer", peer_id: action.Close.peer_id, code: action.Close.code, reason: action.Close.reason }); }
                catch (error) { diagnostics.lastError = error && error.code ? error : fail("relay_close_failed", "relay close could not be sent"); }
                await retirePeer(action.Close.peer_id, "runtime_closed");
            }
        }
    }
    function workerActions(actions) {
        operations = operations.then(function () { return processWorkerActions(actions); }).catch(function (error) {
            diagnostics.lastError = error && error.code ? error : fail("relay_action_failed", "relay action failed");
        });
    }
    async function disconnectPeers(reason) {
        const ids = Array.from(peers.keys());
        peers.clear();
        render("multiplayer offline");
        await Promise.allSettled(ids.map(function (peerId) { return window.chobotsBrowserHost.disconnect(peerId, workerDisconnectReason(reason)); }));
        render("multiplayer offline");
    }
    async function route(message) {
        if (!message || typeof message.type !== "string") throw fail("invalid_relay_message", "invalid relay message");
        if (message.type === "instance_created") {
            if (!validId(message.instance_id) || !validId(message.host_capability)) throw fail("invalid_relay_message", "invalid relay credentials");
            const invites = Array.isArray(message.invites) ? message.invites : (validId(message.invite_token) ? [{ invite_token: message.invite_token, label: null, created_at_ms: Date.now(), revoked: false }] : null);
            if (!invites) throw fail("invalid_relay_message", "invalid relay invite list");
            credentials = { instance_id: message.instance_id, host_capability: message.host_capability };
            saveCredentials();
            setInvites(invites);
            reconnectDelay = 250;
            diagnostics.lastError = null;
            render("multiplayer online");
            return;
        }
        if (message.type === "invite_list") {
            setInvites(message.invites);
            render("multiplayer online");
            return;
        }
        if (message.type === "peer_connected") {
            if (!validId(message.peer_id) || peers.has(message.peer_id) || peers.size >= 32) throw fail("invalid_relay_peer", "invalid relay peer");
            peers.set(message.peer_id, { inbound: -1, outbound: 0 });
            await window.chobotsBrowserHost.connect(message.peer_id);
            render("multiplayer online");
            return;
        }
        if (message.type === "frame") {
            const peer = peers.get(message.peer_id);
            if (!peer || !Number.isSafeInteger(message.sequence) || message.sequence !== peer.inbound + 1) throw fail("relay_sequence_error", "relay frame sequence is out of order");
            encoded(message.frame);
            peer.inbound = message.sequence;
            await window.chobotsBrowserHost.send(message.peer_id, message.frame);
            return;
        }
        if (message.type === "peer_disconnected") {
            await retirePeer(message.peer_id, "relay_peer_disconnected");
            return;
        }
        if (message.type !== "pong" && message.type !== "error") throw fail("invalid_relay_message", "unknown relay message");
        if (message.type === "error") diagnostics.lastError = fail("relay_error", "relay rejected a request");
    }
    function setInvites(invites) {
        if (!Array.isArray(invites) || invites.length > 128) throw fail("invalid_relay_message", "invalid relay invite list");
        const seen = new Set();
        diagnostics.invites = invites.map(function (invite) {
            if (!invite || !validId(invite.invite_token) || seen.has(invite.invite_token) || (invite.label !== null && invite.label !== undefined && (typeof invite.label !== "string" || encoder.encode(invite.label).byteLength > 64)) || !Number.isSafeInteger(invite.created_at_ms) || invite.created_at_ms < 0 || typeof invite.revoked !== "boolean") {
                throw fail("invalid_relay_message", "invalid relay invite list");
            }
            seen.add(invite.invite_token);
            return { invite_token: invite.invite_token, label: invite.label || null, created_at_ms: invite.created_at_ms, revoked: invite.revoked };
        });
        const active = diagnostics.invites.find(function (invite) { return !invite.revoked; });
        diagnostics.inviteUrl = active ? inviteUrl(active.invite_token) : null;
    }
    function canReconnect() { return navigator.onLine !== false && document.visibilityState !== "hidden"; }
    function cancelReconnect() {
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    function queueTransition(operation) {
        const result = transitions.catch(function () {}).then(operation);
        transitions = result.catch(function () {});
        return result;
    }
    function scheduleReconnect(expectedGeneration) {
        const expected = Number.isSafeInteger(expectedGeneration) ? expectedGeneration : generation;
        if (expected !== generation || socket || manuallyDisconnected || !relayUrl || reconnectTimer || !canReconnect()) return;
        reconnectTimer = window.setTimeout(function () {
            reconnectTimer = null;
            if (expected !== generation || manuallyDisconnected) return;
            const savedUrl = relayUrl;
            const savedCredentials = credentials;
            queueTransition(function () { return open(expected, Boolean(savedCredentials), savedUrl, savedCredentials, !savedCredentials); }).catch(function () {});
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
    }
    function lost(current, expectedGeneration) {
        if (expectedGeneration !== generation || socket !== current) return Promise.resolve();
        socket = null;
        return queueTransition(async function () {
            if (expectedGeneration !== generation || socket) return;
            await disconnectPeers("relay_connection_lost");
            if (expectedGeneration !== generation || socket) return;
            scheduleReconnect(expectedGeneration);
        });
    }
    function closed(current, expectedGeneration, event) {
        if (expectedGeneration !== generation || socket !== current) return Promise.resolve();
        if (localPolicyCloses.delete(current)) return lost(current, expectedGeneration);
        if (event && event.code === 1008) {
            socket = null;
            manuallyDisconnected = false;
            cancelReconnect();
            return queueTransition(async function () {
                if (expectedGeneration !== generation || socket) return;
                credentials = null;
                sessionStorage.removeItem(SESSION_KEY);
                diagnostics.inviteUrl = null;
                diagnostics.lastError = fail("relay_authority_rejected", "relay invite or host session expired or was revoked");
                await disconnectPeers("relay_authority_rejected");
                if (expectedGeneration !== generation || socket) return;
                render("multiplayer reconnecting");
                scheduleReconnect(expectedGeneration);
            });
        }
        return lost(current, expectedGeneration);
    }
    async function open(expectedGeneration, resume, requestedUrl, requestedCredentials, freshCreate) {
        if (expectedGeneration !== generation) return;
        const normalizedUrl = normalizeRelayUrl(requestedUrl);
        await window.chobotsBrowserHost.start();
        if (expectedGeneration !== generation) return;
        if (!unsubscribeActions) {
            if (typeof window.chobotsBrowserHost.onActions !== "function") throw fail("relay_worker_unavailable", "browser host action stream is unavailable");
            unsubscribeActions = window.chobotsBrowserHost.onActions(workerActions);
        }
        manuallyDisconnected = false;
        const previous = socket;
        socket = null;
        if (previous) previous.close(1000, "replaced");
        await operations.catch(function () {});
        if (expectedGeneration !== generation) return;
        await disconnectPeers("relay_host_replaced");
        if (expectedGeneration !== generation) return;
        relayUrl = normalizedUrl;
        credentials = requestedCredentials;
        if (freshCreate) {
            diagnostics.inviteUrl = null;
            diagnostics.invites = [];
            sessionStorage.removeItem(SESSION_KEY);
        }
        const current = new window.WebSocket(normalizedUrl.replace(/\/$/, "") + "/v1/host");
        if (expectedGeneration !== generation) { current.close(1000, "stale authority"); return; }
        socket = current;
        render("multiplayer connecting");
        current.onopen = function () {
            if (expectedGeneration !== generation || socket !== current) { current.close(1000, "stale authority"); return; }
            try {
                if (resume && credentials) send({ type: "resume_instance", instance_id: credentials.instance_id, host_capability: credentials.host_capability });
                else {
                    const message = { type: "create_instance", protocol_version: 1 };
                    if (requestedCredentials && requestedCredentials.label) message.label = requestedCredentials.label;
                    send(message);
                }
                if (resume) render("multiplayer online");
            } catch (error) { localPolicyCloses.add(current); current.close(browserCloseCode(1008), "authentication failed"); }
        };
        current.onmessage = function (event) {
            operations = operations.then(async function () {
                if (expectedGeneration !== generation || socket !== current) return;
                if (typeof event.data !== "string" || encoder.encode(event.data).byteLength > MAX_MESSAGE_BYTES) throw fail("relay_frame_too_large", "relay message exceeds 256 KiB");
                await route(JSON.parse(event.data));
            }).catch(async function (error) {
                if (expectedGeneration !== generation || socket !== current) return;
                diagnostics.lastError = error.code ? error : fail("invalid_relay_message", "invalid relay message");
                localPolicyCloses.add(current);
                current.close(browserCloseCode(diagnostics.lastError.code === "relay_frame_too_large" ? 1009 : 1008), diagnostics.lastError.code);
                await lost(current, expectedGeneration);
            });
        };
        current.onclose = function (event) { closed(current, expectedGeneration, event); };
        current.onerror = function () { if (expectedGeneration === generation && socket === current) diagnostics.lastError = fail("relay_socket_error", "relay connection failed"); };
    }
    function create(url, label) {
        let normalizedUrl;
        try { normalizedUrl = normalizeRelayUrl(url); }
        catch (error) { return Promise.reject(error); }
        const expectedGeneration = ++generation;
        cancelReconnect();
        manuallyDisconnected = false;
        const initial = label && String(label).trim() ? { label: String(label).trim() } : null;
        return queueTransition(function () { return open(expectedGeneration, false, normalizedUrl, initial, true); });
    }
    function resume() {
        const saved = loadCredentials();
        if (!saved) return Promise.reject(fail("relay_resume_unavailable", "no relay session is available"));
        let normalizedUrl;
        try { normalizedUrl = normalizeRelayUrl(saved.relay_url); }
        catch (error) { return Promise.reject(error); }
        const expectedGeneration = ++generation;
        cancelReconnect();
        manuallyDisconnected = false;
        const savedCredentials = { instance_id: saved.instance_id, host_capability: saved.host_capability };
        return queueTransition(function () { return open(expectedGeneration, true, normalizedUrl, savedCredentials, false); });
    }
    function ensureRelay() {
        if (socket) return transitions;
        return loadCredentials() ? resume() : create(window.chobotsPlayMode && window.chobotsPlayMode.relayUrl);
    }
    function disconnect() {
        const expectedGeneration = ++generation;
        manuallyDisconnected = true;
        cancelReconnect();
        return queueTransition(async function () {
            if (expectedGeneration !== generation) return;
            credentials = null;
            sessionStorage.removeItem(SESSION_KEY);
            const current = socket;
            socket = null;
            if (current) {
                if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: "close_instance" }));
                current.close(1000, "host disconnect");
            }
            await operations.catch(function () {});
            await disconnectPeers("relay_host_disconnected");
            if (expectedGeneration !== generation) return;
            if (unsubscribeActions) unsubscribeActions();
            unsubscribeActions = null;
            diagnostics.inviteUrl = null;
            diagnostics.invites = [];
            render("disconnected");
        });
    }

    async function copyInvite(inviteToken) {
        const invite = inviteToken ? diagnostics.invites.find(function (candidate) { return candidate.invite_token === inviteToken && !candidate.revoked; }) : diagnostics.invites.find(function (candidate) { return !candidate.revoked; });
        const url = invite ? inviteUrl(invite.invite_token) : diagnostics.inviteUrl;
        if (!url || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw fail("invite_unavailable", "relay invite is unavailable");
        await navigator.clipboard.writeText(url);
        return url;
    }

    async function copyInviteCode(inviteToken) {
        const invite = inviteToken ? diagnostics.invites.find(function (candidate) { return candidate.invite_token === inviteToken && !candidate.revoked; }) : diagnostics.invites.find(function (candidate) { return !candidate.revoked; });
        if (!invite || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw fail("invite_unavailable", "relay invite is unavailable");
        await navigator.clipboard.writeText(invite.invite_token);
        return invite.invite_token;
    }

    window.chobotsRelayHost = { start: ensureRelay, create: create, resume: resume, disconnect: disconnect, copyInvite: copyInvite, copyInviteCode: copyInviteCode };
    window.addEventListener("online", function () { scheduleReconnect(generation); });
    document.addEventListener("visibilitychange", function () { scheduleReconnect(generation); });
    window.addEventListener("DOMContentLoaded", function () {
        const copyButton = element("chobotsShareCopyLink");
        const copyCodeButton = element("chobotsShareCopyCode");
        if (copyButton) copyButton.addEventListener("click", function () { copyInvite().catch(function (error) { render("multiplayer offline", error); }); });
        if (copyCodeButton) copyCodeButton.addEventListener("click", function () { copyInviteCode().catch(function (error) { render("multiplayer offline", error); }); });
        render("disconnected");
    });
})(window);
