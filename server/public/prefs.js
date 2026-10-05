// Applies display preferences (theme, accent, text size, contrast, motion) before the app loads.
(function () {
  var ACCENTS = { orange: ['#ff5a36', '#120805'], blue: ['#3d8bff', '#ffffff'], green: ['#2fb36b', '#06140c'],
    purple: ['#9b6bff', '#ffffff'], teal: ['#14b8a6', '#04120f'], red: ['#e5484d', '#ffffff'] };
  window.applyPrefs = function (p) {
    p = p || {};
    var root = document.documentElement;
    var theme = p.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : (p.theme || 'dark');
    root.dataset.theme = theme;
    root.dataset.contrast = p.highContrast ? 'high' : 'normal';
    root.dataset.motion = p.reduceMotion ? 'reduce' : 'normal';
    root.style.setProperty('--scale', String((p.textSize || 100) / 100));
    var a = ACCENTS[p.accent] || ACCENTS.orange;
    root.style.setProperty('--accent', a[0]);
    root.style.setProperty('--accent-ink', a[1]);
    try { localStorage.setItem('odc.prefs', JSON.stringify(p)); } catch (e) { /* private mode */ }
  };
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('odc.prefs') || 'null'); } catch (e) { /* ignore */ }
  window.applyPrefs(saved);
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
    try { window.applyPrefs(JSON.parse(localStorage.getItem('odc.prefs') || 'null')); } catch (e) { /* ignore */ }
  });
})();
