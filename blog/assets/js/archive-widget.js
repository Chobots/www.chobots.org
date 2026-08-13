let archiveSequence = 0;

function setExpanded(button, panel, expanded) {
  button.setAttribute("aria-expanded", String(expanded));
  panel.hidden = !expanded;
  button.querySelector(".zippy").textContent = expanded ? "▼" : "►";
}

function disclosure(document, label, count, id, expanded) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "archive-toggle";
  button.setAttribute("aria-controls", id);
  const zippy = document.createElement("span");
  zippy.className = "zippy";
  zippy.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = `${label} (${count})`;
  button.append(zippy, text);
  button.addEventListener("click", () => {
    const panel = document.getElementById(id);
    setExpanded(button, panel, button.getAttribute("aria-expanded") !== "true");
  });
  button.setAttribute("aria-expanded", String(expanded));
  zippy.textContent = expanded ? "▼" : "►";
  return button;
}

export function enhanceArchive(root) {
  const source = root?.querySelector(":scope > .blog-archive-source");
  const items = source ? [...source.querySelectorAll(":scope > .blog-archive-source-item")] : [];
  if (!items.length) return false;
  const records = items.map((item) => ({
    year: item.dataset.year,
    month: item.dataset.month,
    monthName: item.dataset.monthName,
    link: item.querySelector("a[href]"),
  }));
  if (records.some((record) => !record.year || !record.month || !record.monthName || !record.link))
    return false;

  const years = new Map();
  for (const record of records) {
    if (!years.has(record.year)) years.set(record.year, new Map());
    const months = years.get(record.year);
    if (!months.has(record.month))
      months.set(record.month, { name: record.monthName, links: [] });
    months.get(record.month).links.push(record.link.cloneNode(true));
  }

  const document = root.ownerDocument;
  const current = document.querySelector("[data-blog-archive-current]");
  const currentYear = current?.dataset.currentYear || years.keys().next().value;
  const currentMonths = years.get(currentYear) || years.values().next().value;
  const currentMonth = current?.dataset.currentMonth || currentMonths.keys().next().value;
  const yearList = document.createElement("ul");
  yearList.className = "hierarchy archive-years";
  const sequence = ++archiveSequence;

  for (const [year, months] of years) {
    const yearItem = document.createElement("li");
    yearItem.dataset.archiveYear = year;
    const yearPanel = document.createElement("ul");
    const yearId = `archive-${sequence}-year-${year}`;
    yearPanel.id = yearId;
    yearPanel.className = "hierarchy archive-months";
    const yearOpen = year === currentYear;
    yearItem.append(disclosure(document, year, [...months.values()].reduce((sum, month) => sum + month.links.length, 0), yearId, yearOpen));
    for (const [month, group] of months) {
      const monthItem = document.createElement("li");
      monthItem.dataset.archiveMonth = month;
      const monthPanel = document.createElement("ul");
      const monthId = `archive-${sequence}-year-${year}-month-${month}`;
      monthPanel.id = monthId;
      monthPanel.className = "posts archive-posts";
      const monthOpen = yearOpen && month === currentMonth;
      monthItem.append(disclosure(document, group.name, group.links.length, monthId, monthOpen));
      for (const link of group.links) {
        const postItem = document.createElement("li");
        postItem.append(link);
        monthPanel.append(postItem);
      }
      monthPanel.hidden = !monthOpen;
      monthItem.append(monthPanel);
      yearPanel.append(monthItem);
    }
    yearPanel.hidden = !yearOpen;
    yearItem.append(yearPanel);
    yearList.append(yearItem);
  }
  source.replaceWith(yearList);
  return true;
}

export async function hydrateArchive(root, fetchArchive = globalThis.fetch) {
  const source = root?.querySelector(":scope > .blog-archive-source[data-archive-source]");
  if (!source || typeof fetchArchive !== "function") return false;
  try {
    const response = await fetchArchive(source.dataset.archiveSource);
    if (!response.ok) return false;
    const records = await response.json();
    if (!Array.isArray(records)) return false;
    for (const record of records) {
      if (!record || !record.year || !record.month || !record.monthName || !record.href || !record.title)
        return false;
    }
    for (const record of records) {
      const item = root.ownerDocument.createElement("li");
      item.className = "blog-archive-source-item";
      item.dataset.year = record.year;
      item.dataset.month = record.month;
      item.dataset.monthName = record.monthName;
      const link = root.ownerDocument.createElement("a");
      link.href = record.href;
      link.textContent = record.title;
      item.append(link);
      source.append(item);
    }
    return enhanceArchive(root);
  } catch {
    return false;
  }
}

if (typeof document !== "undefined") {
  const enhanceAll = () =>
    document.querySelectorAll("[data-blog-archive]").forEach((root) => {
      if (!enhanceArchive(root)) void hydrateArchive(root);
    });
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", enhanceAll, { once: true });
  else enhanceAll();
}
import "./reactions.js";
