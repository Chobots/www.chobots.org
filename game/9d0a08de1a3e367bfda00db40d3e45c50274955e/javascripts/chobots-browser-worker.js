"use strict";

let wasmServer;
let requestQueue = Promise.resolve();
let hostPort;
const maxDatabaseBytes = 64 * 1024 * 1024;

async function server() {
    if (!wasmServer) {
        const wasm = await import("../wasm/chobots-browser-server/chobots_browser_server.js");
        await wasm.default();
        wasmServer = new wasm.BrowserServer();
    }
    return wasmServer;
}

function transferable(response) {
    if (response && response.type === "database_export" && response.bytes) {
        const bytes = response.bytes instanceof Uint8Array ? response.bytes : new Uint8Array(response.bytes);
        return [bytes.buffer];
    }
    return [];
}

function handleRequest(event) {
    const envelope = event.data;
    requestQueue = requestQueue
        .then(async function () {
            const runtime = await server();
            if (envelope.request && envelope.request.type === "export_database") {
                try {
                    const bytes = runtime.exportDatabaseBytes();
                    hostPort.postMessage({ id: envelope.id, response: { type: "database_export", bytes: bytes } }, [bytes.buffer]);
                } catch (_) {
                    hostPort.postMessage({ id: envelope.id, response: { type: "error", code: "invalid_database", message: "database file is invalid or unavailable" } });
                }
                return;
            }
            if (envelope.request && envelope.request.type === "import_database") {
                const value = envelope.request.bytes;
                const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
                if (bytes.byteLength > maxDatabaseBytes) {
                    hostPort.postMessage({ id: envelope.id, response: { type: "error", code: "database_too_large", message: "database file exceeds the 64 MiB import limit" } });
                    return;
                }
                envelope.request.bytes = bytes;
                try {
                    runtime.importDatabaseBytes(bytes);
                    hostPort.postMessage({ id: envelope.id, response: { type: "reset_complete" } });
                } catch (_) {
                    hostPort.postMessage({ id: envelope.id, response: { type: "error", code: "invalid_database", message: "database file is invalid or unavailable" } });
                }
                return;
            }
            const response = await runtime.handle(envelope.request);
            hostPort.postMessage({ id: envelope.id, response: response }, transferable(response));
        })
        .catch(function (error) {
            hostPort.postMessage({
                id: envelope.id,
                response: { type: "error", code: "worker_error", message: "browser Worker failed" }
            });
            console.error("Chobots browser Worker failed", error);
        });
}

self.onmessage = function (event) {
    const initialization = event.data;
    if (!initialization || initialization.type !== "chobots_browser_port" || !initialization.port) {
        return;
    }
    hostPort = initialization.port;
    hostPort.onmessage = handleRequest;
    hostPort.start();
};
