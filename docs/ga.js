(function () {
  var measurementId = "__RUDDER_GA_MEASUREMENT_ID__";
  var umamiWebsiteId = "5e86d3bf-9ddc-46a0-93e0-5441be8a5df4";
  var umamiHostUrl = "/u";
  var umamiScriptUrl = "/u/s.js";
  var umamiSendUrl = "/u/api/send";
  var umamiBeforeSendName = "__rudderDocsUmamiBeforeSend";
  var umamiDisabledKey = "umami.disabled";
  var productionHosts = ["docs.rudderhq.dev", "doc.rudder.zeeland.studio"];
  var allowedQueryKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"];
  var allowedQuerySet = new Set(allowedQueryKeys);
  var allowedEvents = new Set([
    "docs_search_result_click",
    "docs_internal_link_click",
    "docs_external_link_click",
    "docs_copy",
  ]);
  var closedErrorNames = new Set([
    "RuntimeError",
    "UnhandledRejection",
    "ChunkLoadError",
    "NetworkError",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
  ]);
  var perfLimits = {
    lcp: [0, 60000],
    inp: [0, 60000],
    fcp: [0, 60000],
    ttfb: [0, 60000],
    cls: [0, 100],
  };

  var safeParamValueRe = /^[A-Za-z0-9._-]{1,64}$/;
  var uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var ulidRe = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  var longHexRe = /^(?:0x)?[0-9a-f]{12,}$/i;
  var pureDigitsRe = /^\d{5,}$/;
  var prefixedIdRe = /^(?:id|uid|usr|user|acct|account|org|team|proj|project|ws|workspace|board|note|doc|session|sess|cust|customer|order|inv|invoice|sub|txn|tx|req|trace|span)[._-]?[a-z0-9]{4,}$/i;
  var ipv4Re = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  var phoneRe = /^\+?\d[\d._-]{7,}\d$/;
  var jwtRe = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
  var secretPrefixRe = /^(?:sk|pk|rk|ak|tok|token|pat|key|api|apikey|aws|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xoxb|xoxp|xoxa|xoxr|xoxs|akia|asia|aiza|ya29|bearer|sess|session|auth|secret|pwd|pass|passwd|password|jwt|oauth|refresh|access|client_secret|private)[._-]?[A-Za-z0-9._-]*$/i;
  var sensitiveWordRe = /(?:secret|token|apikey|api_key|api-key|password|passwd|bearer|private|credential|cookie|session|auth|email|phone|ssn|credit|card)/i;
  var allowedDocsRootRe = /^\/(?:$|zh(?:\/|$)|(?:zh\/)?(?:get-started|concepts|how-to|reference|benchmarks|contact|releases)(?:\/[a-z0-9-]+)*\/?$)/;

  if (!productionHosts.includes(window.location.hostname)) {
    return;
  }

  function isHighEntropySegment(value) {
    var segments = value.split(/[._-]+/).filter(Boolean);
    for (var i = 0; i < segments.length; i += 1) {
      var seg = segments[i];
      if (seg.length < 16) continue;
      var hasUpper = /[A-Z]/.test(seg);
      var hasLower = /[a-z]/.test(seg);
      var hasDigit = /\d/.test(seg);
      var classes = Number(hasUpper) + Number(hasLower) + Number(hasDigit);
      var uniqueRatio = new Set(seg).size / seg.length;
      if ((classes >= 3 && uniqueRatio >= 0.45) || (classes >= 2 && seg.length >= 22 && uniqueRatio >= 0.5)) {
        return true;
      }
    }
    return false;
  }

  function isSafeAttributionValue(value) {
    if (typeof value !== "string") return false;
    if (!safeParamValueRe.test(value)) return false;
    if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) return false;
    if (uuidRe.test(value) || ulidRe.test(value) || longHexRe.test(value)) return false;
    if (pureDigitsRe.test(value)) return false;
    if ((value.match(/\d/g) || []).length >= 6) return false;
    if (prefixedIdRe.test(value) || ipv4Re.test(value) || phoneRe.test(value) || jwtRe.test(value)) return false;
    if (secretPrefixRe.test(value) || sensitiveWordRe.test(value)) return false;
    if (isHighEntropySegment(value)) return false;
    return true;
  }

  function isPrivateOrLocalHostname(hostname) {
    var host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home") || host.endsWith(".arpa")) {
      return true;
    }
    if (!host.includes(".") || host.includes(":")) return true;
    if (/^\d+(?:\.\d+){3}$/.test(host)) return true;
    return false;
  }

  function normalizedPath(value) {
    try {
      var url = new URL(value || window.location.href, window.location.origin);
      var pathname = url.pathname || "/";
      if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
      return pathname || "/";
    } catch (_error) {
      return window.location.pathname || "/";
    }
  }

  function sanitizeDocsPath(pathname) {
    var clean = pathname || "/";
    if (clean.length > 1) clean = clean.replace(/\/+$/, "");
    if (!clean) clean = "/";
    if (clean.length > 160) return null;
    if (!allowedDocsRootRe.test(clean)) return null;
    return clean;
  }

  function sanitizeDocsUrl(rawUrl) {
    var parsed;
    try {
      parsed = new URL(rawUrl || window.location.href, window.location.origin);
    } catch (_error) {
      return null;
    }
    var path = sanitizeDocsPath(parsed.pathname);
    if (!path) return null;

    var rawSearch = parsed.search ? parsed.search.slice(1) : "";
    if (!rawSearch) return { path: path, url: path };

    var counts = new Map();
    var kept = new Map();
    var rawParts = rawSearch.split("&");
    for (var i = 0; i < rawParts.length; i += 1) {
      var part = rawParts[i];
      if (!part) continue;
      var eqIdx = part.indexOf("=");
      var rawKey = eqIdx === -1 ? part : part.slice(0, eqIdx);
      var rawVal = eqIdx === -1 ? "" : part.slice(eqIdx + 1);
      var key;
      var val;
      try {
        key = decodeURIComponent(rawKey).toLowerCase();
        val = decodeURIComponent(rawVal.replace(/\+/g, "%20"));
      } catch (_err) {
        continue;
      }
      if (!allowedQuerySet.has(key)) continue;
      var nextCount = (counts.get(key) || 0) + 1;
      counts.set(key, nextCount);
      if (nextCount > 1) {
        kept.delete(key);
        continue;
      }
      if (isSafeAttributionValue(val)) {
        kept.set(key, val);
      }
    }

    var outParts = [];
    for (var j = 0; j < allowedQueryKeys.length; j += 1) {
      var k = allowedQueryKeys[j];
      if (kept.has(k)) {
        outParts.push(encodeURIComponent(k) + "=" + encodeURIComponent(kept.get(k)));
      }
    }
    return { path: path, url: outParts.length ? path + "?" + outParts.join("&") : path };
  }

  function normalizedReferrer(value) {
    if (!value || typeof value !== "string") {
      return "";
    }
    try {
      var parsed = new URL(value);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
      if (parsed.username || parsed.password || parsed.port) return "";
      if (productionHosts.includes(parsed.hostname.toLowerCase())) return "";
      if (isPrivateOrLocalHostname(parsed.hostname)) return "";
      return parsed.origin;
    } catch (_error) {
      return "";
    }
  }

  function isUmamiOptedOut() {
    var dnt = (navigator && (navigator.doNotTrack || navigator.msDoNotTrack)) || window.doNotTrack;
    if (dnt === "1" || dnt === "yes" || (navigator && navigator.globalPrivacyControl === true)) {
      return true;
    }
    try {
      var val = window.localStorage && window.localStorage.getItem(umamiDisabledKey);
      return val === "1" || val === "true";
    } catch (_error) {
      return false;
    }
  }

  function createOptOutResponse() {
    if (typeof Response === "function") {
      return new Response(null, { status: 204 });
    }
    return { ok: true, status: 204, text: function () { return Promise.resolve(""); } };
  }

  if (typeof window.fetch === "function" && !window.__rudderDocsFetchGuarded) {
    var origFetch = window.fetch.bind(window);
    window.__rudderDocsFetchGuarded = true;
    window.fetch = function (input, init) {
      var reqUrl = typeof input === "string" ? input : (input && input.url) || "";
      var isUmamiSend = reqUrl === umamiSendUrl || reqUrl.endsWith("/u/api/send");
      if (isUmamiSend && isUmamiOptedOut()) {
        return Promise.resolve(createOptOutResponse());
      }
      if (isUmamiSend) {
        return origFetch(input, Object.assign({}, init, { credentials: "omit" }));
      }
      return origFetch(input, init);
    };
  }

  function staticDocsTitle(path) {
    return path === "/zh" || path.indexOf("/zh/") === 0 ? "Rudder 文档" : "Rudder Docs";
  }

  function sanitizeEventData(name, rawData) {
    if (!allowedEvents.has(name)) return null;
    if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) return {};
    var out = {};
    if (name === "docs_search_result_click") {
      if (typeof rawData.area === "string" && ["navigation", "footer", "sidebar", "content"].includes(rawData.area)) {
        out.area = rawData.area;
      }
      return out;
    }
    if (name === "docs_internal_link_click") {
      if (typeof rawData.area === "string" && ["navigation", "footer", "sidebar", "content"].includes(rawData.area)) {
        out.area = rawData.area;
      }
      var cleanPath = typeof rawData.path === "string" ? sanitizeDocsPath(rawData.path) : null;
      if (cleanPath) out.path = cleanPath;
      return out;
    }
    if (name === "docs_external_link_click") {
      if (typeof rawData.area === "string" && ["navigation", "footer", "sidebar", "content"].includes(rawData.area)) {
        out.area = rawData.area;
      }
      if (typeof rawData.host === "string" && !isPrivateOrLocalHostname(rawData.host) && rawData.host.length <= 80) {
        out.host = rawData.host.toLowerCase();
      }
      return out;
    }
    if (name === "docs_copy") {
      out.kind = "code_or_prompt";
      return out;
    }
    return null;
  }

  function sanitizeBeforeSend(type, payload) {
    if (isUmamiOptedOut()) return false;
    if (!payload || typeof payload !== "object") return false;

    var urlInfo = sanitizeDocsUrl(typeof payload.url === "string" ? payload.url : window.location.href);
    if (!urlInfo) return false;
    var title = staticDocsTitle(urlInfo.path);

    if (type === "performance") {
      var perfOut = {
        website: umamiWebsiteId,
        hostname: window.location.hostname,
        url: urlInfo.path,
        title: title,
        screen: typeof payload.screen === "string" ? payload.screen.slice(0, 24) : "",
        language: typeof payload.language === "string" ? payload.language.slice(0, 24) : "",
      };
      var hasMetric = false;
      var metricKeys = Object.keys(perfLimits);
      for (var i = 0; i < metricKeys.length; i += 1) {
        var metric = metricKeys[i];
        var bounds = perfLimits[metric];
        var raw = payload[metric];
        if (typeof raw === "number" && Number.isFinite(raw) && raw >= bounds[0] && raw <= bounds[1]) {
          perfOut[metric] = metric === "cls" ? Math.round(raw * 10000) / 10000 : Math.round(raw);
          hasMetric = true;
        }
      }
      return hasMetric ? perfOut : false;
    }

    if (type === "error") {
      var errName = typeof payload.name === "string" && closedErrorNames.has(payload.name) ? payload.name : null;
      var eventId = typeof payload.eventId === "string" && uuidRe.test(payload.eventId) ? payload.eventId : null;
      var timestamp = typeof payload.timestamp === "number" && Number.isInteger(payload.timestamp) && payload.timestamp > 0
        ? payload.timestamp
        : null;
      if (!errName || !eventId || !timestamp) return false;
      return {
        version: 1,
        website: umamiWebsiteId,
        eventId: eventId,
        timestamp: timestamp,
        name: errName,
        message: "",
        stack: "",
        handled: Boolean(payload.handled),
        url: urlInfo.path,
        release: "",
        environment: "production",
        tags: {},
      };
    }

    if (type !== "event") return false;

    var out = {
      website: umamiWebsiteId,
      hostname: window.location.hostname,
      url: urlInfo.url,
      title: title,
      referrer: normalizedReferrer(typeof payload.referrer === "string" ? payload.referrer : document.referrer),
    };
    if (typeof payload.screen === "string") out.screen = payload.screen.slice(0, 24);
    if (typeof payload.language === "string") out.language = payload.language.slice(0, 24);

    if (typeof payload.name === "string" && payload.name.length > 0) {
      var cleanData = sanitizeEventData(payload.name, payload.data);
      if (!cleanData) return false;
      out.name = payload.name;
      out.data = cleanData;
    }
    return out;
  }

  window[umamiBeforeSendName] = sanitizeBeforeSend;

  function makeUuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    var hex = "0123456789abcdef";
    var lens = [8, 4, 4, 4, 12];
    var parts = [];
    for (var i = 0; i < lens.length; i += 1) {
      var s = "";
      for (var j = 0; j < lens[i]; j += 1) {
        if (i === 2 && j === 0) s += "4";
        else if (i === 3 && j === 0) s += "8";
        else s += hex[Math.floor(Math.random() * 16)];
      }
      parts.push(s);
    }
    return parts.join("-");
  }

  function postDirect(type, rawPayload) {
    if (isUmamiOptedOut() || typeof window.fetch !== "function") return;
    var sanitized = sanitizeBeforeSend(type, rawPayload);
    if (!sanitized) return;
    try {
      Promise.resolve(window.fetch(umamiSendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: type, payload: sanitized }),
        credentials: "omit",
        keepalive: true,
        referrerPolicy: "strict-origin",
      })).catch(function () {});
    } catch (_error) {
      // Never interrupt docs navigation.
    }
  }

  if (measurementId && measurementId.indexOf("__") !== 0 && !window.__rudderDocsGaLoaded) {
    window.__rudderDocsGaLoaded = true;

    var gaScript = document.createElement("script");
    gaScript.async = true;
    gaScript.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(measurementId);
    document.head.appendChild(gaScript);

    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };

    window.gtag("js", new Date());
    window.gtag("config", measurementId, { send_page_view: false });
  }

  var lastTrackedPath = "";

  function trackPageView() {
    if (!window.gtag) {
      return;
    }

    var path = normalizedPath(window.location.href);
    if (path === lastTrackedPath) {
      return;
    }
    lastTrackedPath = path;

    window.gtag("event", "page_view", {
      page_location: window.location.origin + path,
      page_path: path,
      page_title: document.title,
    });
  }

  var umamiReady = false;
  var lastUmamiTrackedPath = "";

  function trackUmamiPageView() {
    if (isUmamiOptedOut()) return;
    var tracker = window.umami;
    var urlInfo = sanitizeDocsUrl(window.location.href);
    if (!tracker || typeof tracker.track !== "function" || !urlInfo || urlInfo.path === lastUmamiTrackedPath) {
      return;
    }

    lastUmamiTrackedPath = urlInfo.path;
    tracker.track(function (payload) {
      var clean = sanitizeBeforeSend("event", Object.assign({}, payload, {
        title: staticDocsTitle(urlInfo.path),
        url: urlInfo.url,
        referrer: normalizedReferrer(payload && payload.referrer ? payload.referrer : document.referrer),
      }));
      return clean || payload;
    });
  }

  function trackUmamiEvent(name, data) {
    if (isUmamiOptedOut()) return;
    var tracker = window.umami;
    var urlInfo = sanitizeDocsUrl(window.location.href);
    if (!tracker || typeof tracker.track !== "function" || !urlInfo) {
      return;
    }

    tracker.track(function (payload) {
      var clean = sanitizeBeforeSend("event", Object.assign({}, payload, {
        data: data || undefined,
        name: name,
        referrer: normalizedReferrer(payload && payload.referrer ? payload.referrer : document.referrer),
        title: staticDocsTitle(urlInfo.path),
        url: urlInfo.url,
      }));
      return clean || payload;
    });
  }

  function linkArea(link) {
    if (link.closest("nav, [role=\"navigation\"]")) {
      return "navigation";
    }
    if (link.closest("footer")) {
      return "footer";
    }
    if (link.closest("[data-component-part*=sidebar], aside")) {
      return "sidebar";
    }
    return "content";
  }

  function trackClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") {
      return;
    }

    var searchResult = target.closest("[data-rudder-search-result]");
    if (searchResult) {
      trackUmamiEvent("docs_search_result_click", { area: linkArea(searchResult) });
      return;
    }

    var link = target.closest("a[href]");
    if (link) {
      var href;
      try {
        href = new URL(link.href, window.location.origin);
      } catch (_error) {
        href = null;
      }

      if (href) {
        if (href.origin === window.location.origin) {
          trackUmamiEvent("docs_internal_link_click", {
            area: linkArea(link),
            path: normalizedPath(href.href),
          });
        } else {
          trackUmamiEvent("docs_external_link_click", {
            area: linkArea(link),
            host: href.hostname,
          });
        }
      }
      return;
    }

    var button = target.closest("button");
    if (!button) {
      return;
    }

    var copyMarker = [
      button.getAttribute("aria-label") || "",
      button.getAttribute("data-component-part") || "",
      button.className || "",
    ].join(" ");
    if (/copy|复制/i.test(copyMarker)) {
      trackUmamiEvent("docs_copy", { kind: "code_or_prompt" });
    }
  }

  function installWebVitalsAndErrors() {
    if (window.__rudderDocsVitalsInstalled) return;
    window.__rudderDocsVitalsInstalled = true;
    var perfMetrics = {};
    var perfSent = false;
    var errorCount = 0;

    if (typeof window.PerformanceObserver === "function") {
      var observe = function (type, cb) {
        try {
          var obs = new window.PerformanceObserver(function (list) {
            if (isUmamiOptedOut()) {
              obs.disconnect();
              return;
            }
            cb(list.getEntries());
          });
          obs.observe({ type: type, buffered: true });
        } catch (_err) {
          // Unsupported entry type.
        }
      };
      observe("largest-contentful-paint", function (entries) {
        var last = entries[entries.length - 1];
        if (last && typeof last.startTime === "number") perfMetrics.lcp = last.startTime;
      });
      observe("paint", function (entries) {
        for (var i = 0; i < entries.length; i += 1) {
          if (entries[i].name === "first-contentful-paint") perfMetrics.fcp = entries[i].startTime;
        }
      });
      observe("layout-shift", function (entries) {
        var cls = perfMetrics.cls || 0;
        for (var i = 0; i < entries.length; i += 1) {
          if (!entries[i].hadRecentInput && typeof entries[i].value === "number") cls += entries[i].value;
        }
        perfMetrics.cls = cls;
      });
      observe("event", function (entries) {
        var inp = perfMetrics.inp || 0;
        for (var i = 0; i < entries.length; i += 1) {
          if (typeof entries[i].duration === "number" && entries[i].duration > inp) inp = entries[i].duration;
        }
        if (inp > 0) perfMetrics.inp = inp;
      });
    }

    var flushPerf = function () {
      if (perfSent || isUmamiOptedOut()) return;
      try {
        var navEntries = window.performance && window.performance.getEntriesByType && window.performance.getEntriesByType("navigation");
        var nav = navEntries && navEntries[0];
        if (nav && typeof nav.responseStart === "number" && nav.responseStart >= 0) {
          perfMetrics.ttfb = nav.responseStart;
        }
      } catch (_err) {
        // Ignore timing read errors.
      }
      if (Object.keys(perfMetrics).length === 0) return;
      perfSent = true;
      postDirect("performance", Object.assign({
        url: window.location.href,
        screen: window.screen ? window.screen.width + "x" + window.screen.height : "",
        language: (navigator && navigator.language) || "",
      }, perfMetrics));
    };

    var classifyErrorName = function (err, fallback) {
      var raw = err && typeof err === "object" && typeof err.name === "string" ? err.name : "";
      return closedErrorNames.has(raw) ? raw : fallback;
    };

    if (document.addEventListener) {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") flushPerf();
      });
    }
    window.addEventListener("pagehide", flushPerf);
    window.addEventListener("error", function (event) {
      if (errorCount >= 5 || isUmamiOptedOut()) return;
      errorCount += 1;
      postDirect("error", {
        eventId: makeUuid(),
        timestamp: Date.now(),
        name: classifyErrorName(event && event.error, "RuntimeError"),
        handled: false,
        url: window.location.href,
      });
    });
    window.addEventListener("unhandledrejection", function (event) {
      if (errorCount >= 5 || isUmamiOptedOut()) return;
      errorCount += 1;
      postDirect("error", {
        eventId: makeUuid(),
        timestamp: Date.now(),
        name: classifyErrorName(event && event.reason, "UnhandledRejection"),
        handled: false,
        url: window.location.href,
      });
    });
  }

  if (!isUmamiOptedOut() && !window.__rudderDocsUmamiLoaded) {
    window.__rudderDocsUmamiLoaded = true;
    installWebVitalsAndErrors();
    var umamiScript = document.createElement("script");
    umamiScript.defer = true;
    umamiScript.src = umamiScriptUrl;
    umamiScript.dataset.hostUrl = umamiHostUrl;
    umamiScript.dataset.websiteId = umamiWebsiteId;
    umamiScript.dataset.autoTrack = "false";
    umamiScript.dataset.doNotTrack = "true";
    umamiScript.dataset.excludeHash = "true";
    umamiScript.dataset.fetchCredentials = "omit";
    umamiScript.dataset.beforeSend = umamiBeforeSendName;
    umamiScript.dataset.domains = productionHosts.join(",");
    umamiScript.referrerPolicy = "strict-origin";
    umamiScript.addEventListener(
      "load",
      function () {
        umamiReady = true;
        trackUmamiPageView();
      },
      { once: true },
    );
    document.head.appendChild(umamiScript);
  }

  var originalPushState = history.pushState;
  var originalReplaceState = history.replaceState;

  history.pushState = function () {
    var result = originalPushState.apply(this, arguments);
    window.setTimeout(function () {
      trackPageView();
      if (umamiReady) trackUmamiPageView();
    }, 0);
    return result;
  };

  history.replaceState = function () {
    var result = originalReplaceState.apply(this, arguments);
    window.setTimeout(function () {
      trackPageView();
      if (umamiReady) trackUmamiPageView();
    }, 0);
    return result;
  };

  window.addEventListener("popstate", function () {
    window.setTimeout(function () {
      trackPageView();
      if (umamiReady) trackUmamiPageView();
    }, 0);
  });
  document.addEventListener("click", trackClick, true);

  trackPageView();
})();
