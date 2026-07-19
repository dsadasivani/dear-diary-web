(function () {
  try {
    var storedTheme = window.localStorage.getItem('deardiary_theme');
    document.documentElement.classList.toggle('dark', storedTheme === 'dark');
  } catch (_) {
    document.documentElement.classList.remove('dark');
  }
})();
