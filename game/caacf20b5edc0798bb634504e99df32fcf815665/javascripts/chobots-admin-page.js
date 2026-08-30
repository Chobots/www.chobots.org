(function (window) {
    "use strict";
    var params = new URLSearchParams(window.location.search);
    var playMode = window.chobotsPlayMode;
    var bridgeOnly = params.get("bridgeOnly") === "1";
    var playerLoaded = false;
    window.chobotsAdminMovie = String.fromCharCode(75, 97, 118, 97, 108, 111, 107, 65, 100, 109, 105, 110, 46, 115, 119, 102);
    window.chobotsIsBrowserHostPlayer = function () { return false; };
    window.chobotsRelayGuestUrl = playMode.kind === "guest" ? playMode.relayUrl : undefined;
    window.chobotsAdminFlashvars = {
        transport: "websocket",
        wsUrl: playMode.kind === "native" ? playMode.wsUrl : (playMode.kind === "guest" ? playMode.relayUrl : null)
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
    document.addEventListener("DOMContentLoaded", function () {
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
        if (playMode.kind === "guest" || playMode.kind === "native") {
            if (!bridgeOnly) loadAdmin();
            return;
        }
        element("chobotsPlayChooser").hidden = false;
        if (playMode.kind === "invalid-guest") {
            element("chobotsJoinError").hidden = false;
            element("chobotsJoinError").textContent = "Enter a valid sharing code or link.";
        }
    });
})(window);
