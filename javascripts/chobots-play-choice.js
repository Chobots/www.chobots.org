(function (root) {
    "use strict";

    var DEFAULT_DATABASE = "chobots-browser.sqlite3";
    var STORAGE_PREFIX = "chobots-play-mode:v1:";

    function validDatabaseName(value) {
        return typeof value === "string"
            && value.length > ".sqlite3".length
            && value.length <= 128
            && value.endsWith(".sqlite3")
            && value.indexOf("..") === -1
            && /^[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite3$/.test(value);
    }

    function databaseName(search) {
        var candidate = new URLSearchParams(search || "").get("database");
        return validDatabaseName(candidate) ? candidate : DEFAULT_DATABASE;
    }

    function storageKey(database) {
        return STORAGE_PREFIX + (validDatabaseName(database) ? database : DEFAULT_DATABASE);
    }

    function loadHostMode(storage, database) {
        var value = storage.getItem(storageKey(database));
        return value === "private" || value === "public" ? value : null;
    }

    function saveHostMode(storage, database, mode) {
        if (mode !== "private" && mode !== "public") throw new Error("invalid host mode");
        storage.setItem(storageKey(database), mode);
    }

    function validInviteToken(value) {
        return typeof value === "string"
            && value.length >= 1
            && value.length <= 128
            && /^[A-Za-z0-9_.~-]+$/.test(value);
    }

    function inviteToken(input, baseUrl) {
        var value = typeof input === "string" ? input.trim() : "";
        if (validInviteToken(value)) return value;
        var parsed;
        try { parsed = new URL(value, baseUrl); } catch (_) { return null; }
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.pathname.endsWith("/play.html")) return null;
        var values = parsed.searchParams.getAll("join");
        return values.length === 1 && validInviteToken(values[0]) ? values[0] : null;
    }

    var api = {
        databaseName: databaseName,
        loadHostMode: loadHostMode,
        saveHostMode: saveHostMode,
        inviteToken: inviteToken
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.chobotsPlayChoice = api;
})(typeof window !== "undefined" ? window : null);
