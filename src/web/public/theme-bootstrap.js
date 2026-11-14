/* 同步 head 入口：先于应用和样式求值。Vue 只订阅此控制器，不另存主题偏好。 */
(function (host) {
  "use strict";
  if (host.__boardroomTheme) return;
  var key = "boardroom:appearance";
  var root = host.document.documentElement;
  var preference = "system";
  var persistent = true;
  var media = null;
  var listeners = new Set();
  function valid(value) { return value === "light" || value === "dark" || value === "system"; }
  try { var saved = host.localStorage.getItem(key); if (valid(saved)) preference = saved; }
  catch (_) { persistent = false; }
  try { if (typeof host.matchMedia === "function") media = host.matchMedia("(prefers-color-scheme: dark)"); }
  catch (_) { /* 系统能力不可读时使用浅色。 */ }
  var snapshot;
  function apply() {
    var appearance = preference === "system" ? (media && media.matches ? "dark" : "light") : preference;
    if (snapshot && snapshot.preference === preference && snapshot.appearance === appearance && snapshot.persistent === persistent) return;
    root.dataset.theme = appearance;
    root.style.colorScheme = appearance;
    snapshot = Object.freeze({ preference: preference, appearance: appearance, persistent: persistent });
    listeners.forEach(function (listener) { listener(snapshot); });
  }
  host.__boardroomTheme = Object.freeze({
    getSnapshot: function () { return snapshot; },
    setPreference: function (value) {
      if (!valid(value)) return;
      preference = value;
      try {
        host.localStorage.setItem(key, value);
        persistent = host.localStorage.getItem(key) === value;
      } catch (_) { persistent = false; }
      apply();
    },
    subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; }
  });
  function systemChanged() { if (preference === "system") apply(); }
  if (media) {
    if (typeof media.addEventListener === "function") media.addEventListener("change", systemChanged);
    else if (typeof media.addListener === "function") media.addListener(systemChanged);
  }
  host.addEventListener("storage", function (event) {
    if (event.key !== key && event.key !== null) return;
    try {
      if (event.storageArea !== host.localStorage) return;
      var current = host.localStorage.getItem(key);
      preference = valid(current) ? current : "system";
      persistent = true;
    } catch (_) { persistent = false; }
    apply();
  });
  apply();
})(window);
