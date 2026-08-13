(function () {
  "use strict";

  function showFallback(host) {
    host.textContent = "Chobots time unavailable";
  }

  function utcTimeData() {
    var now = new Date();
    var values = new URLSearchParams({
      Millisecond: String(now.getUTCMilliseconds()),
      Second: String(now.getUTCSeconds()),
      Minute: String(now.getUTCMinutes()),
      Hour: String(now.getUTCHours()),
      Day: String(now.getUTCDate()),
      Month: String(now.getUTCMonth() + 1),
      Year: String(now.getUTCFullYear()),
      LinkURL: "",
    });
    return "data:text/plain," + encodeURIComponent(values.toString());
  }

  function mount() {
    document.querySelectorAll(".chobots-time-player").forEach(function (host) {
      if (host.dataset.mounted === "true") return;
      host.dataset.mounted = "true";

      try {
        var ruffle = window.RufflePlayer.newest();
        var player = ruffle.createPlayer();
        player.dataset.chobotsTime = "";
        player.style.width = host.dataset.width + "px";
        player.style.height = host.dataset.height + "px";
        host.replaceChildren(player);
        Promise.resolve(
          player.load({
            url: host.dataset.swf,
            parameters: { TimeZone: host.dataset.timeZone },
            autoplay: "on",
            unmuteOverlay: "hidden",
            splashScreen: false,
            preloader: false,
            backgroundColor: null,
            wmode: "transparent",
            urlRewriteRules: [
              [
                /^https?:\/\/www\.clocklink\.com\/scripts\/PSP\/ClockLink\/TimeGen\.dll\?/i,
                utcTimeData(),
              ],
            ],
          }),
        ).catch(function () {
          showFallback(host);
        });
      } catch (_error) {
        showFallback(host);
      }
    });
  }

  window.ChobotsTime = { mount: mount };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
