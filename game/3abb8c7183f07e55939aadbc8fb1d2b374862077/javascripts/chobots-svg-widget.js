(function (root, factory) {
    "use strict";
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.chobotsSvgWidget = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    var DEFAULT_WS = "wss://default-server.chobots.org/ws/game";
    var LOCALES = new Set(["deDE", "enIN", "enUS", "ruRU", "uaUA"]);
    var MAX_COMPRESSED = 12 * 1024 * 1024;
    var MAX_SVG = 16 * 1024 * 1024;

    function stableError(code) { var error = new Error(code); error.code = code; return error; }
    function loopback(host) { return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"; }
    function validWsUrl(value, URLCtor) {
        try { var url = new URLCtor(value); return url.protocol === "wss:" || (url.protocol === "ws:" && loopback(url.hostname)); } catch (_) { return false; }
    }
    function localeFor(root, params) {
        var override = params.get("locale");
        if (LOCALES.has(override)) return override;
        var language = String(root.navigator && root.navigator.language || root.document && root.document.documentElement.lang || "enUS").replace("-", "");
        var aliases = { de: "deDE", en: "enUS", ru: "ruRU", uk: "uaUA", ua: "uaUA" };
        return LOCALES.has(language) ? language : aliases[language.slice(0, 2).toLowerCase()] || "enUS";
    }
    function resolveRequest(root) {
        var params = new root.URLSearchParams(root.location.search || "");
        var login = params.get("login") || params.get("user") || params.get("u") || "go!";
        if (login.length < 1 || login.length > 64) throw stableError("invalid_request");
        var explicit = params.get("wsUrl");
        if (explicit) {
            if (!validWsUrl(explicit, root.URL)) throw stableError("unsupported_world");
            return { login: login, locale: localeFor(root, params), wsUrl: explicit };
        }
        var join = params.get("join");
        if (join && join !== "default-server") {
            var mode = root.chobotsPlayMode;
            if (!mode || mode.kind !== "guest" || !mode.relayUrl) throw stableError("unsupported_world");
            return { login: login, locale: localeFor(root, params), wsUrl: mode.relayUrl };
        }
        return { login: login, locale: localeFor(root, params), wsUrl: DEFAULT_WS };
    }
    function base64Bytes(root, value) {
        if (typeof value !== "string" || value.length > Math.ceil(MAX_COMPRESSED * 4 / 3) + 4) throw stableError("render_limit");
        var binary;
        try { binary = root.atob(value); } catch (_) { throw stableError("invalid_response"); }
        var bytes = new Uint8Array(binary.length);
        for (var offset = 0; offset < binary.length; offset += 32768) {
            var end = Math.min(offset + 32768, binary.length);
            for (var index = offset; index < end; index += 1) bytes[index] = binary.charCodeAt(index);
        }
        if (bytes.length > MAX_COMPRESSED) throw stableError("render_limit");
        return bytes;
    }
    function hex(bytes) { return Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join(""); }
    async function inflate(root, compressed) {
        if (typeof root.DecompressionStream !== "function") throw stableError("renderer_unavailable");
        var stream = new root.Blob([compressed]).stream().pipeThrough(new root.DecompressionStream("gzip"));
        var reader = stream.getReader(), parts = [], total = 0;
        while (true) { var item = await reader.read(); if (item.done) break; total += item.value.length; if (total > MAX_SVG) throw stableError("render_limit"); parts.push(item.value); }
        var output = new Uint8Array(total), at = 0;
        parts.forEach(function (part) { output.set(part, at); at += part.length; });
        return output;
    }
    function safeSvgAttribute(name, value) {
        name = String(name).toLowerCase();
        value = String(value);
        var namespace = (name === "xmlns" && value === "http://www.w3.org/2000/svg") ||
            (name === "xmlns:xlink" && value === "http://www.w3.org/1999/xlink");
        return !name.startsWith("on") && (namespace || !/(?:https?:|javascript:|data:text\/html)/i.test(value)) &&
            (!/url\(/i.test(value) || /url\(\s*['"]?#/i.test(value));
    }
    function validateSvg(root, bytes) {
        var text;
        try { text = new root.TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (_) { throw stableError("invalid_svg"); }
        var documentNode = new root.DOMParser().parseFromString(text, "image/svg+xml");
        var svg = documentNode.documentElement;
        if (!svg || svg.namespaceURI !== "http://www.w3.org/2000/svg" || svg.localName !== "svg" || documentNode.querySelector("parsererror")) throw stableError("invalid_svg");
        var forbidden = "script,foreignObject,iframe,object,embed,audio,video,animate,animateMotion,animateTransform,set";
        if (svg.querySelector(forbidden)) throw stableError("invalid_svg");
        Array.from(svg.querySelectorAll("*")).concat([svg]).forEach(function (element) {
            Array.from(element.attributes || []).forEach(function (attribute) {
                if (!safeSvgAttribute(attribute.name, attribute.value)) throw stableError("invalid_svg");
            });
        });
        var width = Number(svg.getAttribute("width")), height = Number(svg.getAttribute("height"));
        if (width !== 235 || height !== 308) throw stableError("invalid_svg");
        return text;
    }
    async function descriptorBytes(root, session, descriptor) {
        if (!descriptor || descriptor.version !== 1) throw stableError(descriptor && descriptor.code || "invalid_response");
        if (descriptor.status === "error") throw stableError(descriptor.code || "renderer_unavailable");
        var chunks;
        if (descriptor.status === "inline") chunks = [descriptor.data];
        else if (descriptor.status === "transfer") {
            if (!Number.isInteger(descriptor.chunkCount) || descriptor.chunkCount < 1 || descriptor.chunkCount > 128) throw stableError("invalid_response");
            chunks = new Array(descriptor.chunkCount);
            var next = 0;
            await Promise.all(Array.from({ length: Math.min(4, descriptor.chunkCount) }, async function () {
                while (next < descriptor.chunkCount) {
                    var requested = next++, response = await session.call("SvgWidgetService", "getSvgWidgetChunk", [descriptor.transferId, requested]);
                    if (!response || response.status !== "chunk" || response.transferId !== descriptor.transferId || response.index !== requested || chunks[requested] !== undefined) throw stableError(response && response.code || "invalid_response");
                    chunks[requested] = response.data;
                }
            }));
        } else throw stableError("invalid_response");
        var pieces = chunks.map(function (chunk) { return base64Bytes(root, chunk); });
        var total = pieces.reduce(function (sum, value) { return sum + value.length; }, 0);
        if (total !== descriptor.compressedSize || total > MAX_COMPRESSED) throw stableError("size_mismatch");
        var compressed = new Uint8Array(total), at = 0;
        pieces.forEach(function (piece) { compressed.set(piece, at); at += piece.length; });
        var digest = hex(new Uint8Array(await root.crypto.subtle.digest("SHA-256", compressed)));
        if (digest !== String(descriptor.sha256).toLowerCase()) throw stableError("hash_mismatch");
        return { compressed: compressed, chunks: chunks.length };
    }
    function createController(options) {
        var root = options.root || window, image = options.image, state = options.state;
        var transport = options.transport, rpc = options.rpc || root.chobotsLegacyRpc;
        var objectUrl = null, terminal = false;
        function dispatch(name, detail) { if (!terminal) { terminal = true; root.dispatchEvent(new root.CustomEvent(name, { detail: detail })); } }
        async function request() {
            var selected = resolveRequest(root), session;
            try {
                session = await rpc.connect(selected.wsUrl, { transport: transport, timeoutMs: options.timeoutMs || 20000 });
                var descriptor = await session.call("SvgWidgetService", "getSvgWidget", [selected.login, selected.locale]);
                var data = await descriptorBytes(root, session, descriptor);
                var svgBytes = await inflate(root, data.compressed);
                if (descriptor.originalSize !== svgBytes.length) throw stableError("size_mismatch");
                validateSvg(root, svgBytes);
                objectUrl = root.URL.createObjectURL(new root.Blob([svgBytes], { type: "image/svg+xml" }));
                image.src = objectUrl;
                if (typeof image.decode === "function") await image.decode();
                if (state) state.textContent = "";
                dispatch("chobots-svg-widget-rendered", { login: selected.login, width: 235, height: 308, compressedBytes: data.compressed.length, svgBytes: svgBytes.length, chunks: data.chunks });
                return selected;
            } catch (error) {
                if (objectUrl) { root.URL.revokeObjectURL(objectUrl); objectUrl = null; }
                dispatch("chobots-svg-widget-error", { code: error.code || "renderer_unavailable" });
                throw error;
            } finally { if (session) session.close("widget_complete"); }
        }
        root.addEventListener("pagehide", function () { if (objectUrl) { root.URL.revokeObjectURL(objectUrl); objectUrl = null; } }, { once: true });
        return { request: request, start: request };
    }
    return { createController: createController, resolveRequest: resolveRequest, safeSvgAttribute: safeSvgAttribute };
});
