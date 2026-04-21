// Fetches /api/config once, caches the result. Returns { repo, siteUrl, storeName }.
// Every admin page calls this at load before issuing GitHub API requests, so the
// repo identifier is sourced from the platform (env var) rather than hardcoded.
(function () {
  var cached = null;
  var promise = null;
  window.adminConfig = function () {
    if (cached) return Promise.resolve(cached);
    if (promise) return promise;
    promise = fetch('/api/config')
      .then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            throw new Error(d.error || 'Failed to load /api/config (' + r.status + ')');
          });
        }
        return r.json();
      })
      .then(function (data) {
        if (!data.repo || !data.siteUrl) {
          throw new Error('/api/config response missing repo or siteUrl');
        }
        cached = data;
        return data;
      });
    return promise;
  };
})();
