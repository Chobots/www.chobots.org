export function initialReactionCount(post, reaction) {
  let hash = 2166136261;
  for (const character of `${post}:${reaction}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return 20 + ((hash >>> 0) % 31);
}

export function initializeReactions(root = document) {
  root.querySelectorAll(".historical-reactions").forEach((group) => {
    const post = group.closest("article")?.querySelector(".post-title a")?.getAttribute("href")
      || globalThis.location?.pathname
      || "post";
    group.querySelectorAll(".rx-option").forEach((option) => {
      const reaction = option.querySelector(".rx-label")?.textContent?.trim();
      const count = option.querySelector(".rx-count");
      if (!reaction || !count) return;
      const input = root.createElement("input");
      input.type = "checkbox";
      input.className = "rx-checkbox";
      input.dataset.reaction = reaction;
      input.setAttribute("aria-label", reaction);
      option.prepend(input);
      if (!count) return;
      const initial = initialReactionCount(post, reaction);
      const update = () => { count.textContent = String(initial + Number(input.checked)); };
      update();
      input.addEventListener("change", update);
    });
  });
}

if (typeof document !== "undefined") initializeReactions();
