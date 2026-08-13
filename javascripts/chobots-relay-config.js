(function (window) {
    "use strict";

    var loopbackPage = window.location.hostname === "localhost"
        || window.location.hostname === "127.0.0.1"
        || window.location.hostname === "[::1]";
    if (typeof window.CHOBOTS_RELAY_DEV_MODE !== "boolean") {
        window.CHOBOTS_RELAY_DEV_MODE = loopbackPage;
    }

    // Deployments must replace this with their explicit relay WSS origins.
    // An empty or missing policy intentionally rejects every remote invite.
    if (!Array.isArray(window.CHOBOTS_RELAY_ORIGINS)) {
        window.CHOBOTS_RELAY_ORIGINS = Object.freeze([]);
    }
})(window);
