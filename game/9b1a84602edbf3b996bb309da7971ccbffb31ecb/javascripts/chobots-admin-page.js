(function (window) {
    "use strict";
    var params = new URLSearchParams(window.location.search);
    var playMode = window.chobotsPlayMode;
    var bridgeOnly = params.get("bridgeOnly") === "1";
    var playerLoaded = false;
    var activeHostMode = null;
    var runtimeStarted = false;
    window.chobotsAdminMovie = String.fromCharCode(75, 97, 118, 97, 108, 111, 107, 65, 100, 109, 105, 110, 46, 115, 119, 102);
    window.chobotsIsBrowserHostPlayer = function () { return playMode.kind === "host"; };
    window.chobotsRelayGuestUrl = playMode.kind === "guest" ? playMode.relayUrl : undefined;
    window.chobotsAdminFlashvars = {
        transport: "websocket",
        wsUrl: playMode.kind === "host"
            ? "chobots-browser://local"
            : (playMode.wsUrl || playMode.relayUrl || params.get("wsUrl") || "wss://default-server.chobots.org/ws/game")
    };
    function element(id) { return document.getElementById(id); }
    function loadAdmin() {
        if (playerLoaded) return;
        playerLoaded = true;
        var ruffle = window.RufflePlayer.newest();
        var player = ruffle.createPlayer();
        player.id = "chobotsAdminRufflePlayer";
        player.style.width = "100%";
        player.style.height = "100%";
        element("flashContent").appendChild(player);
        window.ch_game_window = player;
        player.load({ url: window.chobotsGameAssetRoot + "/KavalokAdmin.swf", allowScriptAccess: true, parameters: window.chobotsAdminFlashvars });
    }
    function renderHostMode(mode) {
        activeHostMode = mode;
        element("chobotsPlayChooser").hidden = true;
        element("chobotsHostWorld").hidden = false;
        element("chobotsHostModeStatus").textContent = mode === "public" ? "Public" : "Private";
        element("chobotsOpenPublic").hidden = mode === "public";
        element("chobotsMakePrivate").hidden = mode !== "public";
        element("chobotsRelayControls").hidden = mode !== "public";
        element("chobotsDatabaseControls").hidden = false;
        element("chobotsModeControls").hidden = false;
    }
    async function activateHostMode(mode) {
        if (activeHostMode === mode && runtimeStarted) return;
        if (!runtimeStarted) {
            await window.chobotsBrowserHost.start();
            runtimeStarted = true;
            if (!bridgeOnly) loadAdmin();
        }
        if (mode === "public") await window.chobotsRelayHost.start();
        renderHostMode(mode);
    }
    document.addEventListener("DOMContentLoaded", function () {
        element("chobotsPlayPrivate").addEventListener("click", function () { activateHostMode("private").catch(function () {}); });
        element("chobotsPlayPublic").addEventListener("click", function () { activateHostMode("public").catch(function () {}); });
        element("chobotsJoinForm").addEventListener("submit", function (event) {
            event.preventDefault();
            var token = window.chobotsPlayChoice.inviteToken(element("chobotsJoinCode").value, window.location.href);
            var error = element("chobotsJoinError");
            if (!token) {
                error.hidden = false;
                error.textContent = "Enter a valid sharing code or link.";
                return;
            }
            var target = "/admin.html?join=" + encodeURIComponent(token);
            if (bridgeOnly) target += "&bridgeOnly=1";
            window.location.href = target;
        });
        element("chobotsOpenPublic").addEventListener("click", function () { activateHostMode("public").catch(function () {}); });
        element("chobotsMakePrivate").addEventListener("click", function () {
            if (!window.confirm("Make this world private and disconnect remote players?")) return;
            window.chobotsRelayHost.disconnect().then(function () { renderHostMode("private"); }).catch(function () {});
        });
        if (playMode.kind === "host") {
            element("chobotsPlayChooser").hidden = false;
        } else if (playMode.kind !== "invalid-guest" && !bridgeOnly) {
            loadAdmin();
        }
    });
})(window);
