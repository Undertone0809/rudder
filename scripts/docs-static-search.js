(() => {
  "use strict";

  const INDEX_URL = "/rudder-search-index.json";
  const INPUT_SELECTOR = '[data-component-part="search-input"]';
  const LIST_SELECTOR = '[data-component-part="search-list"]';
  const RESULT_SELECTOR = "[data-rudder-search-result]";
  const MAX_RESULTS = 10;

  let indexPromise;
  let activeIndex = -1;
  let currentResults = [];
  let renderQueued = false;

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch(INDEX_URL, { credentials: "same-origin" }).then((response) => {
        if (!response.ok) throw new Error(`Search index request failed: ${response.status}`);
        return response.json();
      });
    }
    return indexPromise;
  }

  function countOccurrences(haystack, needle) {
    let count = 0;
    let from = 0;
    while (count < 8) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) return count;
      count += 1;
      from = index + Math.max(needle.length, 1);
    }
    return count;
  }

  function scorePage(page, query, expectedLanguage) {
    if (page.language !== expectedLanguage) return 0;

    const title = normalize(page.title);
    const description = normalize(page.description);
    const headings = normalize((page.headings ?? []).join(" "));
    const content = normalize(page.content);
    const path = normalize(page.path);
    const searchable = `${title} ${description} ${headings} ${content} ${path}`;
    const terms = query.split(" ").filter(Boolean);
    if (!terms.every((term) => searchable.includes(term))) return 0;

    let score = 1;
    if (title === query) score += 240;
    else if (title.startsWith(query)) score += 160;
    else if (title.includes(query)) score += 110;
    if (headings.includes(query)) score += 70;
    if (description.includes(query)) score += 45;
    if (path.includes(query)) score += 25;
    score += Math.min(countOccurrences(content, query), 8) * 8;
    for (const term of terms) {
      if (title.includes(term)) score += 24;
      if (headings.includes(term)) score += 12;
      score += Math.min(countOccurrences(content, term), 5) * 2;
    }
    return score;
  }

  function truncateText(value, maxLength) {
    const characters = Array.from(String(value ?? "").replace(/\s+/g, " ").trim());
    if (characters.length <= maxLength) return characters.join("");
    return `${characters.slice(0, maxLength).join("").trim()}…`;
  }

  function makeSnippet(page) {
    const description = String(page.description ?? "").trim();
    return truncateText(description || page.content, 180);
  }

  function search(index, rawQuery) {
    const query = normalize(rawQuery);
    if (!query) return [];
    const expectedLanguage = location.pathname === "/zh" || location.pathname.startsWith("/zh/")
      ? "zh-CN"
      : "en";

    return index
      .map((page) => ({ page, score: scorePage(page, query, expectedLanguage) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.page.title.localeCompare(right.page.title))
      .slice(0, MAX_RESULTS)
      .map(({ page }) => ({ ...page, snippet: makeSnippet(page) }));
  }

  function resetSearch(input, list) {
    currentResults = [];
    activeIndex = -1;
    input?.removeAttribute("aria-activedescendant");
    if (!list) return;

    list.querySelector('[data-rudder-search-group]')?.remove();
    delete list.dataset.rudderSearchFingerprint;
  }

  function setStatus(input, count) {
    const dialog = input.closest('[role="dialog"]');
    const status = dialog?.querySelector('[role="status"]');
    const text = `Results: ${count}`;
    if (status && status.textContent !== text) status.textContent = text;
  }

  function setActive(input, nextIndex) {
    const options = [...document.querySelectorAll(`${LIST_SELECTOR} ${RESULT_SELECTOR}`)];
    if (options.length === 0) {
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
      return;
    }

    activeIndex = (nextIndex + options.length) % options.length;
    options.forEach((option, index) => {
      if (index === activeIndex) {
        option.setAttribute("data-highlighted", "");
        input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      } else {
        option.removeAttribute("data-highlighted");
      }
    });
  }

  function resultNode(result, index, input) {
    const link = document.createElement("a");
    link.id = `rudder-search-result-${index}`;
    link.href = result.path;
    link.role = "option";
    link.dataset.rudderSearchResult = "";
    link.className = "block p-2 rounded-[calc(var(--rounded-search,1.25rem)-0.375rem)] cursor-pointer focus:outline-hidden! focus-visible:outline-hidden! data-highlighted:bg-black/[0.03] dark:data-highlighted:bg-white/5";
    link.addEventListener("mouseenter", () => setActive(input, index));

    const title = document.createElement("div");
    title.className = "px-1 text-sm font-medium leading-5 tracking-[-0.1px] text-gray-950 dark:text-white";
    title.textContent = result.title;
    link.append(title);

    const snippet = document.createElement("div");
    snippet.className = "px-1 mt-0.5 text-xs leading-5 text-gray-500 dark:text-gray-400 line-clamp-2";
    snippet.textContent = result.snippet;
    link.append(snippet);

    const path = document.createElement("div");
    path.className = "px-1 mt-0.5 text-xs leading-4 text-primary dark:text-primary-light truncate";
    path.textContent = result.path;
    link.append(path);
    return link;
  }

  function renderResults(input, list, query, results) {
    const fingerprint = `${query}:${results.map((result) => result.path).join("|")}`;
    if (
      list.dataset.rudderSearchFingerprint === fingerprint &&
      list.querySelectorAll(RESULT_SELECTOR).length === results.length
    ) {
      setStatus(input, results.length);
      return;
    }

    currentResults = results;
    activeIndex = -1;
    list.dataset.rudderSearchFingerprint = fingerprint;
    list.removeAttribute("data-empty");
    input.removeAttribute("data-list-empty");
    input.removeAttribute("aria-activedescendant");
    list.replaceChildren();

    const group = document.createElement("div");
    group.role = "group";
    group.dataset.rudderSearchGroup = "";
    const label = document.createElement("div");
    label.className = "px-3 py-1.5 text-xs font-normal leading-4 text-gray-500 dark:text-gray-400";
    label.textContent = results.length > 0 ? "Documentation" : "No results found";
    group.append(label);
    results.forEach((result, index) => group.append(resultNode(result, index, input)));
    list.append(group);
    setStatus(input, results.length);
  }

  async function updateSearch() {
    const input = document.querySelector(INPUT_SELECTOR);
    const list = document.querySelector(LIST_SELECTOR);
    const query = normalize(input?.value);
    if (!input || !list || !query) {
      resetSearch(input, list);
      return;
    }

    try {
      const index = await loadIndex();
      if (normalize(input.value) !== query || !document.contains(input)) return;
      renderResults(input, list, query, search(index, query));
    } catch (error) {
      console.error("Rudder docs search failed", error);
      renderResults(input, list, query, []);
    }
  }

  function scheduleUpdate() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      void updateSearch();
    });
  }

  document.addEventListener("input", (event) => {
    if (event.target instanceof Element && event.target.matches(INPUT_SELECTOR)) scheduleUpdate();
  }, true);

  document.addEventListener("keydown", (event) => {
    const input = document.querySelector(INPUT_SELECTOR);
    if (!(input instanceof HTMLInputElement) || document.activeElement !== input || currentResults.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setActive(input, activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActive(input, activeIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const result = currentResults[activeIndex === -1 ? 0 : activeIndex];
      if (result) location.assign(result.path);
    }
  }, true);

  new MutationObserver(scheduleUpdate).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  scheduleUpdate();
})();
