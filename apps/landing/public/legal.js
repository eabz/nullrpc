// Language switch of the legal pages (/terms, /privacy). Each page holds the
// English and the Spanish article; without JavaScript both are shown, one after the other.
// The language comes from the hash (#en, #es, or a section id such as #refunds or #es-reembolsos),
// else from the browser's languages (Spanish for es-*), else English.
"use strict";
(() => {
  const articles = { en: document.getElementById("en"), es: document.getElementById("es") };
  const links = [...document.querySelectorAll(".lang-switch [data-lang]")];
  if (!articles.en || !articles.es) return;

  function langOf(hash) {
    const id = decodeURIComponent(hash.replace(/^#/, ""));
    if (id === "en" || id === "es") return id;
    const target = id && document.getElementById(id);
    if (target && articles.es.contains(target)) return "es";
    if (target && articles.en.contains(target)) return "en";
    return null;
  }

  const card = document.querySelector(".legal-card");
  const crumb = document.querySelector(".legal-crumb span:last-child");
  if (card) card.classList.add("is-switched");

  function show(lang) {
    for (const [l, article] of Object.entries(articles)) article.hidden = l !== lang;
    if (crumb) crumb.textContent = (articles[lang].dataset.title || "").replace(/ · nullrpc$/, "");
    for (const a of links) a.setAttribute("aria-current", String(a.dataset.lang === lang));
    document.documentElement.lang = lang;
    document.title = articles[lang].dataset.title || document.title;
  }

  const browser = (navigator.languages || [navigator.language || ""]).some((l) => /^es\b/i.test(l)) ? "es" : "en";
  show(langOf(location.hash) || browser);
  // A section hash scrolls to its heading once its article is visible.
  // Done after load, once fonts and layout have settled (the browser's own jump may come too early).
  const section = location.hash.length > 3 && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (section) {
    const jump = () => section.scrollIntoView({ block: "start", behavior: "instant" });
    if (document.readyState === "complete") jump();
    else window.addEventListener("load", jump, { once: true });
  }

  for (const a of links) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      show(a.dataset.lang);
      history.replaceState(null, "", "#" + a.dataset.lang);
      document.querySelector(".legal-shell").scrollIntoView({ block: "start" });
    });
  }
  window.addEventListener("hashchange", () => {
    const lang = langOf(location.hash);
    if (lang && articles[lang].hidden) show(lang);
  });
})();
