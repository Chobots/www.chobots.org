(function () {
  "use strict";

  if (window.__chobotsArchiveNoticeV1) return;

  var KEY = "chobots.archiveNotice.v1";
  var VALID = { accepted: true, rejected: true };
  var state = "pending";
  var storageWorks = true;
  var requiresReload = false;
  var gate = null;
  var observer = null;
  var locked = new Map();

  function readDecision() {
    try {
      var value = window.localStorage.getItem(KEY);
      return VALID[value] ? value : null;
    } catch (_error) {
      storageWorks = false;
      return null;
    }
  }

  function persistDecision(value) {
    try {
      window.localStorage.setItem(KEY, value);
    } catch (_error) {
      storageWorks = false;
    }
  }

  function lockNode(node) {
    if (!(node instanceof HTMLElement) || node === gate || locked.has(node)) return;
    locked.set(node, {
      inert: node.hasAttribute("inert"),
      ariaHidden: node.getAttribute("aria-hidden"),
    });
    node.inert = true;
    node.setAttribute("aria-hidden", "true");
  }

  function lockPage() {
    Array.from(document.body.children).forEach(lockNode);
    if (!observer) {
      observer = new MutationObserver(function (records) {
        records.forEach(function (record) {
          Array.from(record.addedNodes).forEach(lockNode);
        });
      });
      observer.observe(document.body, { childList: true });
    }
  }

  function unlockPage() {
    if (observer) observer.disconnect();
    observer = null;
    locked.forEach(function (previous, node) {
      node.inert = previous.inert;
      if (previous.ariaHidden === null) node.removeAttribute("aria-hidden");
      else node.setAttribute("aria-hidden", previous.ariaHidden);
    });
    locked.clear();
  }

  function gateBody() {
    if (document.body && document.body.tagName === "FRAMESET") {
      var body = document.createElement("body");
      document.documentElement.replaceChild(body, document.body);
      requiresReload = true;
      return body;
    }
    return document.body;
  }

  function ensureGate() {
    if (gate) return;
    gate = document.createElement("div");
    gate.id = "chobotsArchiveNoticeGate";
    gate.addEventListener("keydown", trapFocus);
    gateBody().appendChild(gate);
    document.documentElement.setAttribute("data-chobots-archive-notice-mounted", "true");
  }

  function actions() {
    return Array.from(gate.querySelectorAll("button:not([disabled])"));
  }

  function trapFocus(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== "Tab") return;
    var available = actions();
    if (!available.length) return;
    var first = available[0];
    var last = available[available.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function dialogMarkup() {
    return '<div class="archive-notice-backdrop">' +
      '<section id="chobotsArchiveNoticeDialog" class="archive-notice-card" role="dialog" aria-modal="true" aria-labelledby="chobotsArchiveNoticeTitle" aria-describedby="chobotsArchiveNoticeDescription">' +
      '<h1 id="chobotsArchiveNoticeTitle">About the Chobots Archive Organisation</h1>' +
      '<div id="chobotsArchiveNoticeDescription">' +
      '<p>Chobots.org is maintained by the Chobots Archive Organisation. Our aim is to preserve and archive the original 2011 Vayersoft version of Chobots.com and associated historical media, including the original Chobots Blog.</p>' +
      '<p>This is an archival preservation project. Historical names, artwork, software, and other materials are presented for preservation and access, and remain the property of their respective rights holders.</p>' +
      '<p>This website, its game, downloads, links, and archived content are provided “as is” and “as available”, without warranties of any kind. To the fullest extent permitted by law, the Chobots Archive Organisation and its contributors accept no responsibility or liability for any loss, damage, data loss, service interruption, security issue, or other consequence arising from access to, use of, inability to use, or reliance on any part of the archive. Use is entirely at your own risk. Nothing in this notice excludes liability that cannot lawfully be excluded.</p>' +
      '<p>By continuing, you confirm that you have read and understood this notice.</p>' +
      '</div><div class="archive-notice-actions">' +
      '<button type="button" data-archive-notice-action="accept">I confirm and understand</button>' +
      '<button type="button" data-archive-notice-action="reject">I do not accept</button>' +
      '</div></section></div>';
  }

  function renderDialog() {
    document.documentElement.setAttribute("data-chobots-archive-notice", "pending");
    gate.innerHTML = dialogMarkup();
    gate.querySelector('[data-archive-notice-action="accept"]').addEventListener("click", function () {
      applyDecision("accepted", true);
    });
    gate.querySelector('[data-archive-notice-action="reject"]').addEventListener("click", function () {
      applyDecision("rejected", true);
    });
    gate.querySelector('[data-archive-notice-action="accept"]').focus();
  }

  function renderRejected() {
    document.documentElement.setAttribute("data-chobots-archive-notice", "rejected");
    gate.innerHTML = '<div class="archive-notice-refusal"><button type="button" data-archive-notice-action="review">Review this notice</button></div>';
    gate.querySelector('[data-archive-notice-action="review"]').addEventListener("click", renderDialog);
    gate.querySelector('[data-archive-notice-action="review"]').focus();
  }

  function applyDecision(next, persist) {
    state = VALID[next] ? next : "pending";
    if (persist && VALID[next]) persistDecision(next);
    if (state === "accepted") {
      if (requiresReload) {
        window.location.reload();
        return;
      }
      unlockPage();
      document.documentElement.removeAttribute("data-chobots-archive-notice");
      document.documentElement.removeAttribute("data-chobots-archive-notice-mounted");
      if (gate) gate.remove();
      gate = null;
      return;
    }
    ensureGate();
    lockPage();
    if (state === "rejected") renderRejected();
    else renderDialog();
  }

  function mount() {
    if (state === "accepted") {
      applyDecision("accepted", false);
      return;
    }
    ensureGate();
    applyDecision(state, false);
  }

  state = readDecision() || "pending";
  document.documentElement.setAttribute("data-chobots-archive-notice", state);
  window.__chobotsArchiveNoticeV1 = Object.freeze({
    decision: function () { return state; },
    storageAvailable: function () { return storageWorks; },
  });
  window.addEventListener("storage", function (event) {
    if (event.key !== KEY || !VALID[event.newValue]) return;
    applyDecision(event.newValue, false);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}());
