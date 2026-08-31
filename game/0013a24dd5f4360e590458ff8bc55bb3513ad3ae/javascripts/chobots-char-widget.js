(function (root, factory) {
    "use strict";
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.chobotsCharWidget = api;
})(typeof window !== "undefined" ? window : null, function () {
    "use strict";

    var DEFAULT_WS_URL = "wss://default-server.chobots.org/ws/game";
    var LOCAL_WS_URL = "chobots-browser://local";
    var SUPPORTED_LOCALES = ["deDE", "enIN", "enUS", "ruRU", "uaUA"];
    var MESSAGES = {
        deDE: {
            charAge: "Alter {0}", daysAgo: "Vor {} Tagen", onlineDate: "Letztes mal online",
            onlineNow: "Jetzt online!", statusAgent: "Agent", statusCitizen: "Staatsbürger",
            statusModerator: "Moderator", today: "heute", yesterday: "Gestern"
        },
        enIN: {
            charAge: "Age {0}", daysAgo: "days ago", onlineDate: "Last visit:",
            onlineNow: "Online now!", statusAgent: "Agent", statusCitizen: "Citizen",
            statusModerator: "Moderator", today: "today", yesterday: "yesterday"
        },
        enUS: {
            charAge: "Age {0}", daysAgo: "days ago", onlineDate: "Last visit:",
            onlineNow: "Online now!", statusAgent: "Agent", statusCitizen: "Citizen",
            statusModerator: "Moderator", today: "today", yesterday: "yesterday"
        },
        ruRU: {
            charAge: "Возраст {0}", daysAgo: "дней назад", onlineDate: "Последний логин: {0}",
            onlineNow: "Сейчас онлайн!", statusAgent: "Агент", statusCitizen: "Гражданин",
            statusModerator: "Модератор", today: "сегодня", yesterday: "вчера"
        },
        uaUA: {
            charAge: "Вік {0}", daysAgo: "днів тому", onlineDate: "Останній логін: {0}",
            onlineNow: "Зараз онлайн!", statusAgent: "Агент", statusCitizen: "Громадянин",
            statusModerator: "Модератор", today: "сьогодні", yesterday: "вчора"
        }
    };

    function widgetError(code, message) {
        var error = new Error(message || code);
        error.code = code;
        return error;
    }

    function characterLength(value) {
        return Array.from(value).length;
    }

    function boundedString(value, name, minimum, maximum) {
        if (typeof value !== "string"
            || characterLength(value) < minimum
            || characterLength(value) > maximum
            || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
            throw widgetError("invalid_character_card", "character widget " + name + " is invalid");
        }
        return value;
    }

    function signedInteger(value, name) {
        if (!Number.isFinite(value) || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
            throw widgetError("invalid_character_card", "character widget " + name + " is invalid");
        }
        return value;
    }

    function nonNegativeInteger(value, name) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw widgetError("invalid_character_card", "character widget " + name + " is invalid");
        }
        return value;
    }

    function booleanValue(value, name) {
        if (typeof value !== "boolean") {
            throw widgetError("invalid_character_card", "character widget " + name + " is invalid");
        }
        return value;
    }

    function normalizeItem(value, name) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw widgetError("invalid_character_card", "character widget " + name + " is invalid");
        }
        return {
            fileName: boundedString(value.fileName, name + " filename", 1, 128),
            placement: boundedString(value.placement == null ? "" : value.placement, name + " placement", 0, 16),
            color: value.color == null ? null : signedInteger(value.color, name + " color")
        };
    }

    function normalizePublicCard(value) {
        if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
            throw widgetError("invalid_character_card", "character widget schema version is invalid");
        }
        if (!Array.isArray(value.clothes) || value.clothes.length > 128) {
            throw widgetError("invalid_character_card", "character widget clothes are invalid");
        }
        if (!value.presence || typeof value.presence !== "object" || Array.isArray(value.presence)) {
            throw widgetError("invalid_character_card", "character widget presence is invalid");
        }
        var online = booleanValue(value.presence.online, "online state");
        var lastOnlineDays = value.presence.lastOnlineDays == null
            ? null
            : signedInteger(value.presence.lastOnlineDays, "last online days");
        if (!online && lastOnlineDays == null) {
            throw widgetError("invalid_character_card", "character widget last online days are missing");
        }
        return {
            version: 1,
            login: boundedString(value.login, "login", 1, 64),
            body: boundedString(value.body, "body", 1, 128),
            color: signedInteger(value.color, "color"),
            locale: boundedString(value.locale, "locale", 1, 16),
            ageDays: nonNegativeInteger(value.ageDays, "age"),
            citizen: booleanValue(value.citizen, "citizen flag"),
            agent: booleanValue(value.agent, "agent flag"),
            moderator: booleanValue(value.moderator, "moderator flag"),
            presence: { online: online, lastOnlineDays: lastOnlineDays },
            clothes: value.clothes.map(function (item) { return normalizeItem(item, "clothing"); }),
            playerCard: value.playerCard == null ? null : normalizeItem(value.playerCard, "player card")
        };
    }

    function normalizeLegacyCard(charView, lastOnlineDays) {
        if (!charView || typeof charView !== "object") {
            throw widgetError("character_not_found", "character was not found");
        }
        var online = Boolean(charView.online || charView.server);
        return normalizePublicCard({
            version: 1,
            login: charView.login || charView.id,
            body: charView.body || "default",
            color: charView.color == null ? 0xAAAAAA : charView.color,
            locale: charView.locale || "enUS",
            ageDays: charView.ageDays == null ? charView.age : charView.ageDays,
            citizen: Boolean(charView.citizen),
            agent: Boolean(charView.agent),
            moderator: Boolean(charView.moderator),
            presence: {
                online: online,
                lastOnlineDays: online ? null : lastOnlineDays
            },
            clothes: Array.isArray(charView.clothes) ? charView.clothes.map(function (item) {
                return {
                    fileName: item.fileName,
                    placement: item.placement || "",
                    color: item.color == null ? null : item.color
                };
            }) : [],
            playerCard: charView.playerCard == null ? null : {
                fileName: charView.playerCard.fileName,
                placement: charView.playerCard.placement || "",
                color: charView.playerCard.color == null ? null : charView.playerCard.color
            }
        });
    }

    function selectedLocale(locale) {
        return SUPPORTED_LOCALES.indexOf(locale) >= 0 ? locale : "enUS";
    }

    function localizedText(locale, card) {
        var messages = MESSAGES[selectedLocale(locale)];
        var suffix;
        if (card.presence.online) {
            suffix = messages.onlineNow;
        } else if (card.presence.lastOnlineDays === 0) {
            suffix = messages.today;
        } else if (card.presence.lastOnlineDays === 1) {
            suffix = messages.yesterday;
        } else {
            suffix = String(card.presence.lastOnlineDays) + " " + messages.daysAgo;
        }
        return {
            age: messages.charAge.replace("{0}", String(card.ageDays)),
            online: card.presence.online ? messages.onlineNow : messages.onlineDate + " " + suffix,
            citizen: messages.statusCitizen,
            agent: messages.statusAgent,
            moderator: messages.statusModerator
        };
    }

    function nativeEndpoint(wsUrl, login) {
        var endpoint = new URL(wsUrl);
        if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
            throw widgetError("invalid_character_source", "character widget native URL is invalid");
        }
        endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
        endpoint.pathname = "/api/char-widget";
        endpoint.search = "";
        endpoint.hash = "";
        endpoint.searchParams.set("login", login);
        return endpoint.toString();
    }

    function requestedLogin(params) {
        if (params.has("login")) return params.get("login");
        if (params.has("user")) return params.get("user");
        if (params.has("u")) return params.get("u");
        return "go!";
    }

    function buildRequest(root, playMode) {
        var params = new URLSearchParams(root.location && root.location.search || "");
        var login = requestedLogin(params);
        var explicitWsUrl = params.get("wsUrl");
        var request = {
            login: login,
            locale: selectedLocale(params.get("locale") || "enUS"),
            bridgeOnly: params.get("bridgeOnly") === "1",
            kind: null,
            wsUrl: null,
            endpoint: null
        };
        if (explicitWsUrl && /^wss?:\/\//i.test(explicitWsUrl)) {
            request.kind = "native";
            request.wsUrl = explicitWsUrl;
            request.endpoint = nativeEndpoint(explicitWsUrl, login);
        } else if (explicitWsUrl) {
            request.kind = "hosted";
            request.wsUrl = explicitWsUrl;
        } else if (!params.has("join")) {
            request.kind = "native";
            request.wsUrl = DEFAULT_WS_URL;
            request.endpoint = nativeEndpoint(DEFAULT_WS_URL, login);
        } else if (playMode && playMode.kind === "native") {
            request.kind = "native";
            request.wsUrl = playMode.wsUrl || DEFAULT_WS_URL;
            request.endpoint = nativeEndpoint(request.wsUrl, login);
        } else if (playMode && playMode.kind === "guest") {
            request.kind = "hosted";
            request.wsUrl = playMode.relayUrl;
        } else if (playMode && playMode.kind === "host") {
            request.kind = "hosted";
            request.wsUrl = LOCAL_WS_URL;
        } else {
            request.kind = "invalid";
        }
        return request;
    }

    function defaultLoadScript(root, url) {
        return new Promise(function (resolve, reject) {
            if (!root.document || !root.document.head) {
                reject(widgetError("script_load_failed", "character widget script loader is unavailable"));
                return;
            }
            var script = root.document.createElement("script");
            script.src = url;
            script.async = true;
            script.onload = resolve;
            script.onerror = function () { reject(widgetError("script_load_failed", "failed to load " + url)); };
            root.document.head.appendChild(script);
        });
    }

    function createController(options) {
        options = options || {};
        var root = options.window;
        if (!root) throw new TypeError("character widget window is required");
        var request = buildRequest(root, options.playMode);
        var fetchImpl = options.fetch || root.fetch;
        var loadScript = options.loadScript || function (url) { return defaultLoadScript(root, url); };
        var lookupStarted = false;
        var lookupPromise = null;
        var payload = null;
        var player = null;
        var flashIsReady = false;
        var delivered = false;
        var hasRendered = false;

        function dispatch(type, detail) {
            if (typeof root.dispatchEvent === "function" && typeof root.CustomEvent === "function") {
                root.dispatchEvent(new root.CustomEvent(type, { detail: detail }));
            }
        }

        function fail(detail) {
            if (controller.failure) return;
            controller.failure = typeof detail === "string" ? { code: detail } : detail;
            dispatch("chobots-char-widget-error", controller.failure);
        }

        function deliver() {
            if (request.bridgeOnly || delivered || !payload || !player || !flashIsReady
                || typeof player.chobotsRenderCharacterCard !== "function") return;
            delivered = true;
            try {
                player.chobotsRenderCharacterCard(payload);
                dispatch("chobots-char-widget-delivered", payload);
            } catch (error) {
                fail({ code: "character_render_failed", message: error.message || String(error) });
            }
        }

        function rpcReady() {
            if (options.legacyRpcReady) {
                return Promise.resolve(typeof options.legacyRpcReady === "function"
                    ? options.legacyRpcReady()
                    : options.legacyRpcReady);
            }
            return Promise.resolve().then(function () {
                if (!root.chobotsLegacyRpc) throw widgetError("transport_unavailable", "legacy RPC did not load");
                return root.chobotsLegacyRpc;
            });
        }

        async function lookupNative() {
            if (typeof fetchImpl !== "function") throw widgetError("transport_unavailable", "character endpoint is unavailable");
            var response = await fetchImpl(request.endpoint, {
                cache: "no-store",
                credentials: "omit",
                headers: { accept: "application/json" }
            });
            if (response.status === 404) throw widgetError("character_not_found", "character was not found");
            if (!response.ok) throw widgetError("character_lookup_failed", "character endpoint returned " + response.status);
            return normalizePublicCard(await response.json());
        }

        async function lookupHosted() {
            var rpc = await rpcReady();
            var session = await rpc.connect(request.wsUrl, {});
            try {
                var charView = await session.call("CharService", "getCharViewLogin", [request.login]);
                if (!charView) throw widgetError("character_not_found", "character was not found");
                var online = Boolean(charView.online || charView.server);
                var lastOnlineDays = online
                    ? null
                    : await session.call("CharService", "getLastOnlineDay", [charView.userId]);
                return normalizeLegacyCard(charView, lastOnlineDays);
            } finally {
                session.close("widget_complete");
            }
        }

        var controller = {
            request: request,
            failure: null,
            get payload() { return payload; },
            get delivered() { return delivered; },
            get isRendered() { return hasRendered; },
            start: function () {
                if (lookupStarted) return lookupPromise;
                lookupStarted = true;
                if (request.bridgeOnly) {
                    lookupPromise = Promise.resolve();
                    return lookupPromise;
                }
                lookupPromise = Promise.resolve().then(async function () {
                    if (request.kind === "invalid" || !request.wsUrl) {
                        throw widgetError("character_lookup_failed", "character source is invalid");
                    }
                    var card = request.kind === "native" ? await lookupNative() : await lookupHosted();
                    payload = Object.assign({}, card, { text: localizedText(request.locale, card) });
                    deliver();
                }).catch(function (error) {
                    fail({
                        code: error && error.code === "character_not_found"
                            ? "character_not_found"
                            : "character_lookup_failed",
                        message: error && error.message ? error.message : String(error)
                    });
                });
                return lookupPromise;
            },
            setPlayer: function (value) {
                player = value;
                deliver();
            },
            flashReady: function () {
                flashIsReady = true;
                deliver();
            },
            rendered: function () {
                if (hasRendered) return;
                hasRendered = true;
                dispatch("chobots-char-widget-rendered", payload);
            },
            fail: fail
        };
        return controller;
    }

    return {
        createController: createController,
        nativeEndpoint: nativeEndpoint,
        normalizePublicCard: normalizePublicCard,
        normalizeLegacyCard: normalizeLegacyCard,
        localizedText: localizedText
    };
});
