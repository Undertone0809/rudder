(function () {
  var measurementId = "__RUDDER_GA_MEASUREMENT_ID__";
  var umamiWebsiteId = "5e86d3bf-9ddc-46a0-93e0-5441be8a5df4";
  var productionHosts = ["docs.rudderhq.dev", "doc.rudder.zeeland.studio"];

  if (!productionHosts.includes(window.location.hostname)) {
    return;
  }

  function normalizedPath(value) {
    try {
      var url = new URL(value || window.location.href, window.location.origin);
      return url.pathname || "/";
    } catch (_error) {
      return window.location.pathname || "/";
    }
  }

  function normalizedReferrer(value) {
    if (!value) {
      return "";
    }

    try {
      return new URL(value, window.location.origin).origin;
    } catch (_error) {
      return "";
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
    var tracker = window.umami;
    var path = normalizedPath(window.location.href);
    if (!tracker || typeof tracker.track !== "function" || path === lastUmamiTrackedPath) {
      return;
    }

    lastUmamiTrackedPath = path;
    tracker.track(function (payload) {
      return Object.assign({}, payload, {
        title: "Rudder Docs",
        url: path,
        referrer: normalizedReferrer(payload.referrer),
      });
    });
  }

  function trackUmamiEvent(name, data) {
    var tracker = window.umami;
    if (!tracker || typeof tracker.track !== "function") {
      return;
    }

    tracker.track(function (payload) {
      return Object.assign({}, payload, {
        data: data || undefined,
        name: name,
        referrer: normalizedReferrer(payload.referrer),
        title: "Rudder Docs",
        url: normalizedPath(window.location.href),
      });
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
    if (!(target instanceof Element)) {
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

  if (!window.__rudderDocsUmamiLoaded) {
    window.__rudderDocsUmamiLoaded = true;
    var umamiScript = document.createElement("script");
    umamiScript.defer = true;
    umamiScript.src = "https://umami.foundria.dev/script.js";
    umamiScript.dataset.websiteId = umamiWebsiteId;
    umamiScript.dataset.autoTrack = "false";
    umamiScript.dataset.excludeSearch = "true";
    umamiScript.dataset.domains = productionHosts.join(",");
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
