const DEFAULT_LANG = "nl";

// Plak hier de Google Apps Script "Web app" URL zodra die is aangemaakt.
// Zolang dit leeg is, wordt kijkgedrag alleen lokaal bijgehouden (niet naar de spreadsheet gestuurd).
const SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycby2J8-DPVyNYRpq8-D3ry2muPehPgp_1XcPLzBMeLFhVWkfApDLUcb_Gjkhpw6X8Dzn/exec";

const VIDEO_TITLES = {
  "player-video1": "Welcome & Safety Overview",
  "player-video2": "Equipment Basics",
  "player-video3": "Daily Procedures"
};

let currentLang = DEFAULT_LANG;
let employeeName = "";
const watchedVideos = new Set();

function applyLanguage(lang) {
  const dict = translations[lang] || translations[DEFAULT_LANG];
  currentLang = translations[lang] ? lang : DEFAULT_LANG;

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (dict[key]) el.textContent = dict[key];
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (dict[key]) el.placeholder = dict[key];
  });

  document.documentElement.lang = currentLang;
  localStorage.setItem("siteLang", currentLang);

  const select = document.getElementById("lang-select");
  if (select && select.value !== currentLang) {
    select.value = currentLang;
  }
}

function watchedStorageKey(name) {
  return "watchedVideos:" + name;
}

function loadWatchedForName(name) {
  watchedVideos.clear();
  const raw = localStorage.getItem(watchedStorageKey(name));
  if (raw) {
    JSON.parse(raw).forEach((id) => watchedVideos.add(id));
  }
  Object.keys(VIDEO_TITLES).forEach((id) => {
    const badge = document.getElementById("badge-" + id);
    if (badge) badge.hidden = !watchedVideos.has(id);
  });
  updateProgressUI();
}

function saveWatched(name) {
  localStorage.setItem(watchedStorageKey(name), JSON.stringify([...watchedVideos]));
}

function updateProgressUI() {
  const el = document.getElementById("progress-count");
  if (el) el.textContent = watchedVideos.size;
}

function showApp(name) {
  employeeName = name;
  document.getElementById("name-gate").hidden = true;
  document.getElementById("user-bar").hidden = false;
  document.getElementById("video-grid").hidden = false;
  document.getElementById("user-name-display").textContent = name;
  loadWatchedForName(name);
}

function hideApp() {
  document.getElementById("user-bar").hidden = true;
  document.getElementById("video-grid").hidden = true;
  document.getElementById("name-gate").hidden = false;
  document.getElementById("name-input").value = "";
}

function reportWatched(videoId) {
  const title = VIDEO_TITLES[videoId];

  if (!SHEET_WEBHOOK_URL) {
    console.warn("SHEET_WEBHOOK_URL is niet ingesteld — kijkgedrag wordt niet naar de spreadsheet gestuurd.");
    return;
  }

  fetch(SHEET_WEBHOOK_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      name: employeeName,
      video: title,
      language: currentLang,
      timestamp: new Date().toISOString()
    })
  }).catch((err) => console.error("Kon kijkgedrag niet versturen naar de spreadsheet:", err));
}

function markWatched(videoId) {
  if (watchedVideos.has(videoId)) return;

  watchedVideos.add(videoId);
  saveWatched(employeeName);
  updateProgressUI();

  const badge = document.getElementById("badge-" + videoId);
  if (badge) badge.hidden = false;

  reportWatched(videoId);
}

function onPlayerStateChange(videoId) {
  return function (event) {
    if (event.data === YT.PlayerState.ENDED) {
      markWatched(videoId);
    }
  };
}

function initYouTubePlayers() {
  Object.keys(VIDEO_TITLES).forEach((id) => {
    const iframe = document.getElementById(id);
    if (!iframe) return;

    const src = new URL(iframe.src);
    src.searchParams.set("enablejsapi", "1");
    src.searchParams.set("origin", window.location.origin);
    iframe.src = src.toString();

    new YT.Player(id, {
      events: {
        onStateChange: onPlayerStateChange(id)
      }
    });
  });
}

window.onYouTubeIframeAPIReady = initYouTubePlayers;

document.addEventListener("DOMContentLoaded", () => {
  const savedLang = localStorage.getItem("siteLang");
  applyLanguage(savedLang && translations[savedLang] ? savedLang : DEFAULT_LANG);

  document.getElementById("lang-select").addEventListener("change", (e) => {
    applyLanguage(e.target.value);
  });

  const savedName = localStorage.getItem("employeeName");
  if (savedName) {
    showApp(savedName);
  }

  document.getElementById("name-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("name-input").value.trim();
    if (!name) return;
    localStorage.setItem("employeeName", name);
    showApp(name);
  });

  document.getElementById("change-name-btn").addEventListener("click", () => {
    hideApp();
  });
});
