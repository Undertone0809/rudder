(function () {
  var measurementId = "G-7LFL6GL5QZ";
  var productionHosts = ["doc.rudder.zeeland.studio"];

  if (!productionHosts.includes(window.location.hostname)) {
    return;
  }

  if (window.__rudderDocsGaLoaded) {
    return;
  }
  window.__rudderDocsGaLoaded = true;

  var script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(measurementId);
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };

  window.gtag("js", new Date());
  window.gtag("config", measurementId, { send_page_view: false });

  var lastTrackedPath = "";

  function trackPageView() {
    var path = window.location.pathname + window.location.search;
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

  var originalPushState = history.pushState;
  var originalReplaceState = history.replaceState;

  history.pushState = function () {
    var result = originalPushState.apply(this, arguments);
    window.setTimeout(trackPageView, 0);
    return result;
  };

  history.replaceState = function () {
    var result = originalReplaceState.apply(this, arguments);
    window.setTimeout(trackPageView, 0);
    return result;
  };

  window.addEventListener("popstate", function () {
    window.setTimeout(trackPageView, 0);
  });

  trackPageView();
})();
