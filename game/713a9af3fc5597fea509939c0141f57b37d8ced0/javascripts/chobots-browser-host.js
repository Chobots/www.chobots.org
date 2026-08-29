(function (window) {
    "use strict";

    const diagnostics = window.chobotsBrowserDiagnostics = {
        status: "loading",
        framesIn: 0,
        framesOut: 0,
        lastError: null,
        storagePersistence: "unknown"
    };
    const knownPeers = new Set();
    let worker = null;
    let port = null;
    let tickTimer = null;
    let nextRequestId = 1;
    let pending = new Map();
    let started = false;
    let startPromise = null;
    let shutdownPromise = null;
    let releaseLock = null;
    let lockReleased = Promise.resolve();
    const actionListeners = new Set();
    const shutdownTimeoutMs = 1000;

    function startTicks() {
        if (!tickTimer && started) {
            tickTimer = window.setInterval(function () {
                request({ type: "tick", now_ms: Date.now() }).catch(function () {});
            }, 250);
        }
    }

    async function withoutTicks(operation) {
        if (tickTimer) { window.clearInterval(tickTimer); tickTimer = null; }
        try { return await operation(); } finally { startTicks(); }
    }

    function statusElement() {
        return document.getElementById("chobotsBrowserStatus");
    }

    function setStatus(status, error) {
        diagnostics.status = status;
        diagnostics.lastError = error || null;
        const element = statusElement();
        if (element) {
            element.textContent = error ? status + ": " + error.code : status;
        }
    }

    function hostError(code, message) {
        const error = { code: code, message: message };
        setStatus("error", error);
        return error;
    }

    function rejectPending(error) {
        pending.forEach(function (request) { request.reject(error); });
        pending.clear();
    }

    function request(requestBody, transfer) {
        if (!port) {
            return Promise.reject(hostError("host_not_started", "browser host has not started"));
        }
        return new Promise(function (resolve, reject) {
            const id = nextRequestId++;
            pending.set(id, { resolve: resolve, reject: reject });
            port.postMessage({ id: id, request: requestBody }, transfer || []);
        });
    }

    function receive(event) {
        const envelope = event.data;
        const waiting = pending.get(envelope.id);
        if (!waiting) return;
        pending.delete(envelope.id);
        const response = envelope.response;
        if (response.type === "error") {
            waiting.reject(hostError(response.code, response.message));
            return;
        }
        if (response.type === "actions") {
            diagnostics.framesOut += response.actions.length;
            actionListeners.forEach(function (listener) {
                try { listener(response.actions || []); } catch (_) {}
            });
        }
        waiting.resolve(response);
    }

    async function acquireLock() {
        if (!navigator.locks || !navigator.locks.request) {
            throw hostError("locks_unavailable", "browser host locks are unavailable");
        }
        let acquired;
        const acquiredPromise = new Promise(function (resolve) { acquired = resolve; });
        navigator.locks.request("chobots-browser-host", { ifAvailable: true }, async function (lock) {
            if (!lock) {
                acquired(false);
                return;
            }
            acquired(true);
            lockReleased = new Promise(function (resolveLockReleased) {
                releaseLock = function () {
                    resolveLockReleased();
                };
            });
            await lockReleased;
        });
        if (!await acquiredPromise) {
            throw hostError("host_already_running", "a browser host is already running for this origin");
        }
    }

    async function start() {
        if (started) return;
        if (startPromise) return startPromise;
        startPromise = (async function () {
            await acquireLock();
            if (navigator.storage && typeof navigator.storage.persist === "function") {
                try {
                    diagnostics.storagePersistence = await navigator.storage.persist() ? "granted" : "denied";
                } catch (_) {
                    diagnostics.storagePersistence = "unavailable";
                }
            } else {
                diagnostics.storagePersistence = "unavailable";
            }
            const warning = document.getElementById("chobotsPersistenceWarning");
            if (warning) warning.hidden = diagnostics.storagePersistence === "granted";
            worker = new Worker(window.chobotsGameAssetRoot + "/javascripts/chobots-browser-worker.js");
            const channel = new MessageChannel();
            port = channel.port1;
            port.onmessage = receive;
            port.start();
            worker.postMessage({ type: "chobots_browser_port", port: channel.port2 }, [channel.port2]);
            worker.onerror = function () {
                rejectPending(hostError("worker_error", "browser Worker failed"));
            };
            const databaseName = new URLSearchParams(window.location.search).get("database") || "chobots-browser.sqlite3";
            const ready = await request({ type: "start", database_name: databaseName });
            if (ready.type !== "ready") {
                throw hostError("invalid_worker_response", "browser Worker returned an invalid response");
            }
            started = true;
            setStatus(ready.persistent ? "ready-persistent" : "ready-ephemeral");
            startTicks();
        })().catch(function (error) {
            if (!diagnostics.lastError) hostError("start_failed", "browser host failed to start");
            if (worker) worker.terminate();
            worker = null;
            if (port) port.close();
            port = null;
            if (releaseLock) {
                releaseLock();
                releaseLock = null;
            }
            startPromise = null;
            throw error;
        });
        return startPromise;
    }

    async function disconnect(peerId, reason) {
        if (!knownPeers.delete(peerId) || !started) return;
        return request({ type: "disconnect", peer_id: peerId, reason: reason || "client_closed" });
    }

    function shutdownAcknowledgement(disconnects) {
        return Promise.race([
            Promise.allSettled(disconnects).then(function (results) {
                const acknowledged = results.every(function (result) { return result.status === "fulfilled"; });
                return {
                    acknowledged: acknowledged,
                    code: acknowledged ? "disconnects_acknowledged" : "disconnects_failed"
                };
            }),
            new Promise(function (resolve) {
                window.setTimeout(function () {
                    resolve({ acknowledged: false, code: "shutdown_timeout" });
                }, shutdownTimeoutMs);
            })
        ]);
    }

    function stop() {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async function () {
            if (tickTimer) {
                window.clearInterval(tickTimer);
                tickTimer = null;
            }
            setStatus("stopping");
            const peers = Array.from(knownPeers);
            const acknowledgement = await shutdownAcknowledgement(peers.map(function (peerId) {
                return disconnect(peerId, "host_shutdown");
            }));
            if (!acknowledgement.acknowledged) {
                rejectPending({ code: acknowledgement.code, message: "browser host shutdown timed out" });
            }
            if (port && acknowledgement.acknowledged) {
                await request({ type: "shutdown" }).catch(function () {});
            }
            if (worker) worker.terminate();
            worker = null;
            if (port) port.close();
            port = null;
            started = false;
            if (releaseLock) {
                releaseLock();
                await lockReleased;
                releaseLock = null;
            }
            setStatus("stopped");
            return acknowledgement;
        })();
        return shutdownPromise;
    }

    window.chobotsBrowserHost = {
        start: start,
        async connect(peerId) {
            await start();
            knownPeers.add(peerId);
            return request({ type: "connect", peer_id: peerId });
        },
        async send(peerId, frame) {
            await start();
            diagnostics.framesIn += 1;
            return request({ type: "frame", peer_id: peerId, frame: frame });
        },
        disconnect: disconnect,
        stop: stop,
        async exportDatabase() {
            await start();
            const response = await withoutTicks(function () { return request({ type: "export_database" }); });
            return response.bytes;
        },
        async importDatabase(bytes) {
            await start();
            const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            if (view.byteLength > 64 * 1024 * 1024) throw { code: "database_too_large", message: "database file exceeds the 64 MiB import limit" };
            return withoutTicks(function () { return request({ type: "import_database", bytes: view }, [view.buffer]); });
        },
        async resetDatabase() {
            await start();
            return withoutTicks(function () { return request({ type: "reset_database" }); });
        },
        onActions(listener) {
            if (typeof listener !== "function") throw new TypeError("action listener must be a function");
            actionListeners.add(listener);
            return function () { actionListeners.delete(listener); };
        }
    };

    if (window.chobotsPlayMode && window.chobotsPlayMode.kind === "host") {
        setStatus("loading");
    }

    function bestEffortShutdown() {
        stop().catch(function () {});
    }

    window.addEventListener("beforeunload", bestEffortShutdown);
    window.addEventListener("pagehide", bestEffortShutdown);

    window.addEventListener("DOMContentLoaded", function () {
        if (!window.chobotsPlayMode || window.chobotsPlayMode.kind !== "host") return;
        const databaseControls = document.getElementById("chobotsDatabaseControls");
        if (databaseControls) databaseControls.hidden = false;
        const storageStatus = document.getElementById("chobotsStorageStatus");
        if (storageStatus) storageStatus.textContent = diagnostics.storagePersistence === "granted" ? "storage protected" : "storage best effort";
        const exportButton = document.getElementById("chobotsExportDatabase");
        const importInput = document.getElementById("chobotsImportDatabase");
        const resetButton = document.getElementById("chobotsResetDatabase");
        if (exportButton) exportButton.addEventListener("click", async function () {
            const bytes = await window.chobotsBrowserHost.exportDatabase();
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.sqlite3" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = "chobots-private-world.sqlite3";
            link.click();
            URL.revokeObjectURL(url);
        });
        if (importInput) importInput.addEventListener("change", async function () {
            const file = importInput.files && importInput.files[0];
            if (!file) return;
            if (file.size > 64 * 1024 * 1024) { hostError("database_too_large", "database file exceeds the 64 MiB import limit"); importInput.value = ""; return; }
            if (window.confirm("Replace the current private-world database with this file?")) {
                await window.chobotsBrowserHost.importDatabase(await file.arrayBuffer()).catch(function () {});
            }
            importInput.value = "";
        });
        if (resetButton) resetButton.addEventListener("click", async function () {
            if (window.prompt("Type RESET to erase this private world") === "RESET") {
                resetButton.disabled = true;
                try {
                    const response = await window.chobotsBrowserHost.resetDatabase();
                    if (!response || response.type !== "reset_complete") {
                        throw hostError("invalid_worker_response", "browser Worker returned an invalid response");
                    }
                    window.location.reload();
                } catch (_) {
                    resetButton.disabled = false;
                }
            }
        });
    });
})(window);
