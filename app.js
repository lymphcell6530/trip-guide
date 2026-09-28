/* 旅途即時導覽 — 到定點自動找歷史景點與在地美食，並用 Google Maps 規劃路線 */
'use strict';

// ---------- 狀態 ----------
const S = {
  key: load('gmKey', ''),
  moveThreshold: +load('moveThreshold', 500),
  dwellSeconds: +load('dwellSeconds', 90),
  notify: load('notify', '0') === '1',
  auto: load('auto', '1') === '1',
  gps: null,            // 最新 GPS 位置 {lat,lng}
  origin: null,         // 目前用來搜尋與導航的位置
  manual: false,        // origin 是否為手動在地圖上點選
  lastSearch: null,     // 上次自動搜尋的位置
  anchor: null, anchorAt: 0, // 停留偵測
  sights: [], food: [], wikiNearby: [],
  selected: null,
  routeMode: 'WALK',
  map: null, gm: null, markers: [], userMarker: null, routeLine: null,
  searching: false,
};

function load(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, v); } catch {} }
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setStatus(msg) { $('#status').textContent = msg; }

function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m)} 公尺` : `${(m / 1000).toFixed(1)} 公里`; }
function fmtDur(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min} 分鐘`;
  return `${Math.floor(min / 60)} 小時${min % 60 ? ` ${min % 60} 分` : ''}`;
}
// 步行約 4.5 km/h，再乘 1.3 修正（路不會是直線）
const walkGuess = (m) => fmtDur((m * 1.3) / 1.25);

// ---------- Google Maps 載入 ----------
function loadGoogleMaps() {
  if (!S.key) return Promise.resolve(false);
  if (window.google?.maps?.importLibrary) return Promise.resolve(true);
  return new Promise((resolve) => {
    window.__gmReady = () => resolve(true);
    window.gm_authFailure = () => {
      setStatus('⚠️ Google Maps 金鑰無效或未啟用對應 API，請到設定檢查。');
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(S.key)}&v=weekly&language=zh-TW&loading=async&callback=__gmReady`;
    s.async = true;
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function initMap(center) {
  const ok = await loadGoogleMaps();
  if (!ok) {
    $('#map').innerHTML = '<div class="empty">尚未設定 Google Maps 金鑰<br>右上角 ⚙️ 設定後即可顯示地圖、美食與路線。<br>（歷史景點故事仍可先用維基百科查看）</div>';
    return;
  }
  const { Map } = await google.maps.importLibrary('maps');
  const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
  await google.maps.importLibrary('geometry');
  S.gm = { AdvancedMarkerElement };
  S.map = new Map($('#map'), {
    center, zoom: 15, mapId: 'DEMO_MAP_ID',
    disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy',
  });
  S.map.addListener('click', (e) => {
    setOrigin({ lat: e.latLng.lat(), lng: e.latLng.lng() }, true);
    search('你在地圖上選的位置');
  });
}

function pin(emoji, bg) {
  const d = document.createElement('div');
  d.style.cssText = `font-size:18px;background:${bg};border:2px solid #fff;border-radius:50%;width:32px;height:32px;display:grid;place-items:center;box-shadow:0 2px 6px rgba(0,0,0,.35)`;
  d.textContent = emoji;
  return d;
}

function drawUser() {
  if (!S.map || !S.origin) return;
  if (!S.userMarker) {
    const d = document.createElement('div');
    d.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 6px rgba(37,99,235,.25)';
    S.userMarker = new S.gm.AdvancedMarkerElement({ map: S.map, content: d, zIndex: 999, title: '你在這裡' });
  }
  S.userMarker.position = S.origin;
}

function drawMarkers() {
  if (!S.map) return;
  S.markers.forEach((m) => (m.map = null));
  S.markers = [];
  const add = (item, emoji, bg) => {
    const m = new S.gm.AdvancedMarkerElement({ map: S.map, position: item.loc, content: pin(emoji, bg), title: item.name });
    m.addListener('click', () => focusCard(item.uid));
    S.markers.push(m);
  };
  S.sights.forEach((p) => add(p, '🏯', '#b91c1c'));
  S.food.forEach((p) => add(p, '🍜', '#d97706'));
}

// ---------- 位置與「到定點」偵測 ----------
function setOrigin(pos, manual) {
  S.origin = pos;
  S.manual = manual;
  drawUser();
  if (S.map) S.map.panTo(pos);
}

function startGeolocation() {
  if (!navigator.geolocation) { setStatus('此裝置不支援定位，請在地圖上點選位置。'); return; }
  navigator.geolocation.watchPosition(
    (p) => {
      S.gps = { lat: p.coords.latitude, lng: p.coords.longitude };
      if (!S.manual) { S.origin = S.gps; drawUser(); }
      checkArrival();
    },
    (err) => setStatus(`無法取得定位（${err.message}）。可在地圖上點一個位置來搜尋。`),
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 },
  );
  // watchPosition 在靜止時可能不再回報，所以定時檢查一次停留時間
  setInterval(checkArrival, 10000);
}

function checkArrival() {
  if (!S.auto || S.manual || !S.gps || S.searching) return;
  const now = Date.now();
  if (!S.lastSearch) { search('你目前的位置'); return; }
  if (distM(S.gps, S.lastSearch) < S.moveThreshold) { S.anchor = null; return; }
  // 離開上個定點夠遠了：確認在同一處停留一段時間才算「到了新定點」
  if (!S.anchor || distM(S.gps, S.anchor) > 80) { S.anchor = S.gps; S.anchorAt = now; return; }
  const waited = (now - S.anchorAt) / 1000;
  if (waited >= S.dwellSeconds) {
    S.anchor = null;
    search('你抵達的新地點', true);
  } else {
    setStatus(`移動中… 停留 ${Math.ceil(S.dwellSeconds - waited)} 秒後會自動搜尋這裡`);
  }
}

// ---------- 搜尋 ----------
async function search(label, arrived = false) {
  if (!S.origin) return;
  S.searching = true;
  if (!S.manual) S.lastSearch = { ...S.origin };
  const radius = +$('#radius').value;
  setStatus(`🔎 正在搜尋${label}附近…`);
  $('#list-sights').innerHTML = $('#list-food').innerHTML = '<div class="empty">搜尋中…</div>';

  const searchId = (S.searchId = (S.searchId || 0) + 1);
  // 先判斷人在哪個國家：決定 Places 的地區、要不要查當地語言的維基百科
  const ctx = await placeContext(S.origin);
  S.country = ctx.country;
  S.localLang = LOCAL_WIKI[ctx.country] || null;

  const [sights, food, wikiZh, wikiLocal] = await Promise.all([
    searchPlaces('sights', radius).catch((e) => (console.warn(e), [])),
    searchPlaces('food', radius).catch((e) => (console.warn(e), [])),
    wikiGeo(S.origin, radius, 'zh').catch((e) => (console.warn(e), [])),
    S.localLang ? wikiGeo(S.origin, radius, S.localLang).catch((e) => (console.warn(e), [])) : [],
  ]);
  if (searchId !== S.searchId) return;
  // 當地語言條目若有中文版，就改用中文版（轉成繁體）；已在中文結果裡的不重複
  const tw = await zhTwTitles(wikiLocal.map((w) => w.zhTitle).filter(Boolean)).catch(() => new Map());
  wikiLocal.forEach((w) => { if (w.zhTitle) w.zhTitle = tw.get(w.zhTitle) || w.zhTitle; });
  const wiki = [...wikiZh];
  for (const w of wikiLocal) {
    if (wiki.some((z) => nameMatch(z.title, w.zhTitle || w.title))) continue;
    wiki.push(w.zhTitle ? { ...w, title: w.zhTitle, lang: 'zh', extract: null } : w);
  }
  S.wikiNearby = wiki;
  // Google 景點優先；維基百科上有、但 Google 沒列到的歷史條目也補進來
  const extra = wiki.filter((w) => !sights.some((s) => nameMatch(s.name, w.title)));
  S.sights = [...sights, ...extra.map(wikiToItem)].sort((a, b) => a.dist - b.dist);
  S.food = food;
  S.searching = false;

  renderSights();
  renderFood();
  drawMarkers();
  const place = ctx.name;
  setStatus(`📍 ${place || label}：找到 ${S.sights.length} 個景點、${S.food.length} 家美食${S.manual ? '（手動選點，按 📍 回到 GPS）' : ''}`);
  if (arrived && S.notify) notify(`你到了${place || '新地點'}`, `附近有 ${S.sights.length} 個景點、${S.food.length} 家美食`);
  enrichTravel(searchId);
}

// 用 Google Maps 算每個地點「真正」的步行與大眾運輸時間、距離
async function routeMatrix(items, mode) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    const r = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': S.key,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition',
      },
      body: JSON.stringify({
        origins: [{ waypoint: { location: { latLng: { latitude: S.origin.lat, longitude: S.origin.lng } } } }],
        destinations: chunk.map((p) => ({ waypoint: p.placeId ? { placeId: p.placeId } : { location: { latLng: { latitude: p.loc.lat, longitude: p.loc.lng } } } })),
        travelMode: mode,
        languageCode: 'zh-TW',
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || data[0]?.error?.message || `RouteMatrix ${r.status}`);
    for (const e of data) {
      if (e.condition === 'ROUTE_EXISTS' && e.duration) out.set(chunk[e.destinationIndex].uid, { sec: parseInt(e.duration, 10), meters: e.distanceMeters });
    }
  }
  return out;
}

async function enrichTravel(searchId) {
  if (!S.map) return;
  const all = [...S.sights, ...S.food];
  if (!all.length) return;
  const [walk, transit] = await Promise.all([
    routeMatrix(all, 'WALK').catch((e) => (console.warn('WALK matrix', e), new Map())),
    routeMatrix(all, 'TRANSIT').catch((e) => (console.warn('TRANSIT matrix', e), new Map())),
  ]);
  if (searchId !== S.searchId) return;
  all.forEach((p) => {
    p.walk = walk.get(p.uid);
    p.transit = transit.get(p.uid);
    const meta = document.querySelector(`#card-${cssId(p.uid)} .meta`);
    if (meta) meta.innerHTML = metaLine(p);
  });
}

const SIGHT_TYPES = ['historical_landmark', 'tourist_attraction', 'museum', 'monument', 'cultural_landmark', 'historical_place', 'hindu_temple', 'buddhist_temple' ];
const SIGHT_TYPES_SAFE = ['historical_landmark', 'tourist_attraction', 'museum'];
const FOOD_TYPES = ['restaurant', 'cafe', 'bakery'];
const BASE_FIELDS = ['id', 'displayName', 'location', 'rating', 'userRatingCount', 'photos', 'editorialSummary',
  'primaryTypeDisplayName', 'formattedAddress', 'googleMapsURI', 'regularOpeningHours', 'reviews'];

async function searchPlaces(kind, radius) {
  if (!S.map) return [];
  const { Place, SearchNearbyRankPreference } = await google.maps.importLibrary('places');
  const run = (types, fields) => Place.searchNearby({
    fields,
    locationRestriction: { center: S.origin, radius: Math.min(radius, 50000) },
    includedTypes: types,
    maxResultCount: 20,
    rankPreference: SearchNearbyRankPreference.POPULARITY,
    language: 'zh-TW',
    region: (S.country || 'TW').toLowerCase(),
  });
  const types = kind === 'food' ? FOOD_TYPES : SIGHT_TYPES;
  const fields = kind === 'food' ? [...BASE_FIELDS, 'priceLevel', 'priceRange', 'servesVegetarianFood', 'servesBreakfast', 'servesLunch', 'servesDinner', 'servesDessert', 'servesCoffee', 'servesBeer'] : BASE_FIELDS;
  let res;
  try {
    res = await run(types, fields);
  } catch (e) {
    // 某些類型或欄位在舊版本不支援時，退回保守設定
    console.warn('searchNearby fallback', e);
    res = await run(kind === 'food' ? ['restaurant'] : SIGHT_TYPES_SAFE, kind === 'food' ? [...BASE_FIELDS, 'priceLevel'] : BASE_FIELDS);
  }
  return (res.places || []).map((p) => {
    const loc = { lat: p.location.lat(), lng: p.location.lng() };
    return {
      uid: `${kind}:${p.id}`, kind, source: 'google', placeId: p.id,
      name: p.displayName, loc, dist: distM(S.origin, loc),
      rating: p.rating, ratingCount: p.userRatingCount,
      type: p.primaryTypeDisplayName, address: p.formattedAddress, url: p.googleMapsURI,
      summary: p.editorialSummary,
      photo: p.photos?.[0]?.getURI({ maxWidth: 240, maxHeight: 240 }),
      openNow: openNowText(p),
      reviews: (p.reviews || []).filter((r) => r.text).slice(0, 3).map((r) => ({ text: r.text, rating: r.rating, when: r.relativePublishTimeDescription })),
      price: kind === 'food' ? priceText(p) : null,
      serves: kind === 'food' ? servesText(p) : [],
    };
  });
}

function openNowText(p) {
  const h = p.regularOpeningHours;
  if (!h?.weekdayDescriptions) return null;
  const idx = (new Date().getDay() + 6) % 7; // Google 從星期一開始
  return h.weekdayDescriptions[idx];
}

function moneyNum(m) {
  if (!m) return null;
  const n = Number(m.units ?? m.amount ?? 0) + Number(m.nanos ?? 0) / 1e9;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function priceText(p) {
  const r = p.priceRange;
  const cur = r?.startPrice?.currencyCode || r?.endPrice?.currencyCode;
  const sym = cur === 'TWD' ? 'NT$' : cur === 'JPY' ? '¥' : cur === 'USD' ? 'US$' : cur ? `${cur} ` : '';
  const a = moneyNum(r?.startPrice), b = moneyNum(r?.endPrice);
  if (a && b) return `每人約 ${sym}${a}–${b}`;
  if (a) return `每人約 ${sym}${a} 以上`;
  const lv = String(p.priceLevel ?? '').toUpperCase();
  return {
    FREE: '免費', INEXPENSIVE: '$ 平價', MODERATE: '$$ 中等', EXPENSIVE: '$$$ 偏高', VERY_EXPENSIVE: '$$$$ 高價',
  }[lv] || null;
}
function servesText(p) {
  const map = [['servesBreakfast', '早餐'], ['servesLunch', '午餐'], ['servesDinner', '晚餐'], ['servesDessert', '甜點'],
    ['servesCoffee', '咖啡'], ['servesBeer', '啤酒'], ['servesVegetarianFood', '素食可']];
  return map.filter(([k]) => p[k] === true).map(([, t]) => t);
}

// 判斷目前位置的國家與地名（有金鑰用 Google 反查，沒有就用經緯度大致判斷）
const LOCAL_WIKI = { JP: 'ja', KR: 'ko', TH: 'th', VN: 'vi', FR: 'fr', DE: 'de', IT: 'it', ES: 'es', US: 'en', GB: 'en' };
function guessCountry({ lat, lng }) {
  if (lat > 21.8 && lat < 25.4 && lng > 119.3 && lng < 122.1) return 'TW';
  if (lat > 33 && lat < 38.7 && lng > 124.5 && lng < 129.6) return 'KR';
  if (lat > 24 && lat < 45.6 && lng > 122.9 && lng < 146) return 'JP';
  return null;
}
async function placeContext(pos) {
  let name = null, country = null;
  if (S.map) {
    try {
      const { Geocoder } = await google.maps.importLibrary('geocoding');
      const { results } = await new Geocoder().geocode({ location: pos, language: 'zh-TW' });
      const comps = results.flatMap((r) => r.address_components);
      const pick = (t) => comps.find((c) => c.types.includes(t))?.long_name;
      country = comps.find((c) => c.types.includes('country'))?.short_name || null;
      name = [pick('administrative_area_level_1'), pick('administrative_area_level_2') || pick('locality'), pick('sublocality_level_1') || pick('administrative_area_level_3')]
        .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' ');
    } catch (e) { console.warn('geocode', e); }
  }
  return { name, country: country || guessCountry(pos) };
}

// ---------- 維基百科：歷史故事（中文優先，當地語言補充，必要時翻譯） ----------
const NOT_SIGHT = new RegExp([
  '車站|站$|捷運|線$|國民小學|國民中學|國小$|國中$|高級中學|高中$|大學$|學院$|醫院|公司|大樓|大廈|銀行|路$|街$|大道$|里$|村$|區$|鄉$|鎮$|市$|縣$|交流道|橋$|隧道|公車|郵局|派出所|議會|公所|選區',
  '警察|大学|大學|短期|附属|通$|署$|宗$|会館$|駅$|小学校|中学校|高等学校|病院|区$|町$|丁目|通り$|郵便局|交番|ビル$|県$|府$|バス|インターチェンジ|出張所|役所|会社|ホテル',
].join('|'));
const wikiBase = (lang) => `https://${lang}.wikipedia.org/w/api.php`;
const wikiPageUrl = (lang, title) => (lang === 'zh' ? `https://zh.wikipedia.org/zh-tw/${encodeURIComponent(title)}` : `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`);
const LANG_NAME = { ja: '日文', ko: '韓文', th: '泰文', vi: '越南文', fr: '法文', de: '德文', it: '義大利文', es: '西班牙文', en: '英文' };

async function wikiApi(params, lang = 'zh') {
  const q = new URLSearchParams({ format: 'json', origin: '*', ...(lang === 'zh' ? { variant: 'zh-tw', uselang: 'zh-tw' } : {}), ...params });
  const r = await fetch(`${wikiBase(lang)}?${q}`);
  if (!r.ok) throw new Error(`Wikipedia ${r.status}`);
  return r.json();
}

async function wikiGeo(pos, radius, lang = 'zh') {
  const params = {
    action: 'query', generator: 'geosearch', ggscoord: `${pos.lat}|${pos.lng}`,
    ggsradius: String(Math.min(radius, 10000)), ggslimit: '40',
    prop: 'coordinates|pageimages|extracts|description', exintro: '1', explaintext: '1', exsentences: '2', exlimit: 'max',
    piprop: 'thumbnail', pithumbsize: '240', pilimit: 'max', colimit: 'max', redirects: '1',
  };
  if (lang === 'zh') Object.assign(params, { prop: `${params.prop}|info`, inprop: 'varianttitles' });
  if (lang !== 'zh') Object.assign(params, { prop: `${params.prop}|langlinks`, lllang: 'zh', lllimit: 'max' });
  const data = await wikiApi(params, lang);
  return Object.values(data.query?.pages || {})
    .filter((p) => p.coordinates && !NOT_SIGHT.test(p.title.replace(/\s*[（(].*?[)）]\s*$/, '')))
    .map((p) => {
      const loc = { lat: p.coordinates[0].lat, lng: p.coordinates[0].lon };
      return {
        title: p.varianttitles?.['zh-tw'] || p.title, lang, zhTitle: p.langlinks?.[0]?.['*'] || null,
        loc, dist: distM(pos, loc), extract: p.extract, thumb: p.thumbnail?.source, desc: p.description,
      };
    });
}

// 把中文維基的標題轉成台灣繁體（例：产宁坂 → 產寧坂）
async function zhTwTitles(titles) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const d = await wikiApi({ action: 'query', prop: 'info', inprop: 'varianttitles', titles: titles.slice(i, i + 50).join('|') });
    const back = new Map((d.query?.normalized || []).map((n) => [n.to, n.from]));
    Object.values(d.query?.pages || {}).forEach((p) => {
      const tw = p.varianttitles?.['zh-tw'];
      if (tw) out.set(back.get(p.title) || p.title, tw);
    });
  }
  return out;
}

function wikiToItem(w) {
  return {
    uid: `wiki:${w.lang}:${w.title}`, kind: 'sights', source: 'wiki', name: w.title, wikiTitle: w.title, wikiLang: w.lang,
    loc: w.loc, dist: w.dist, summary: w.lang === 'zh' ? w.extract : null, photo: w.thumb,
    type: (w.lang === 'zh' && w.desc) || '維基百科條目',
  };
}

const norm = (s) => String(s || '').replace(/[\s（）()·．・\-]/g, '').replace(/臺/g, '台');
function nameMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (x.length < 2 || y.length < 2) return false;
  return x.includes(y) || y.includes(x);
}

async function wikiFind(name, lang) {
  const s = await wikiApi({ action: 'query', list: 'search', srsearch: name, srlimit: '5', srnamespace: '0' }, lang);
  return s.query?.search?.map((r) => r.title).find((t) => nameMatch(name, t)) || null;
}

// 用同一把 Google 金鑰翻譯（需啟用 Cloud Translation API；沒啟用就回傳 null）
async function translate(text, from) {
  if (!S.key || !text) return null;
  try {
    const r = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(S.key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: from, target: 'zh-TW', format: 'text' }),
    });
    if (!r.ok) return null;
    return (await r.json()).data?.translations?.[0]?.translatedText || null;
  } catch { return null; }
}

// 讀整篇條目，取出開頭＋「歷史／沿革／傳說」等段落當作故事
async function wikiStory(item) {
  let title = item.wikiTitle, lang = item.wikiLang || 'zh';
  if (!title) {
    const near = S.wikiNearby.find((w) => nameMatch(item.name, w.title) && distM(item.loc, w.loc) < 1500);
    if (near) { title = near.title; lang = near.lang; }
  }
  if (!title) { title = await wikiFind(item.name, 'zh'); lang = 'zh'; }
  if (!title && S.localLang) { title = await wikiFind(item.name, S.localLang); lang = S.localLang; }
  if (!title) return null;
  const d = await wikiApi({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', titles: title, redirects: '1', ...(lang === 'zh' ? { converttitles: '1' } : {}) }, lang);
  const page = Object.values(d.query?.pages || {})[0];
  const text = page?.extract;
  if (!text) return null;
  const parts = text.split(/\n(?===+[^=])/);
  const intro = parts[0].trim();
  const hist = parts.slice(1)
    .filter((p) => /^==+\s*[^=]*(歷史|历史|歴史|沿革|由來|由来|由緒|傳說|传说|伝説|伝承|典故|故事|緣起|縁起|起源|建築|背景|History|Legend)/i.test(p))
    .slice(0, 2)
    .map((p) => p.replace(/^==+\s*([^=]+?)\s*==+/gm, '【$1】').trim())
    .join('\n\n');
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const story = clip(intro, 500) + (hist ? `\n\n${clip(hist, 1400)}` : '');
  const out = { title: lang === 'zh' ? title : page.title, lang, text: story, url: wikiPageUrl(lang, page.title) };
  if (lang !== 'zh') out.translated = await translate(story, lang);
  return out;
}

// ---------- 畫面 ----------
function metaLine(p) {
  const bits = [];
  if (p.walk) bits.push(`🚶 ${fmtDur(p.walk.sec)}・${fmtDist(p.walk.meters)}`);
  else bits.push(`📏 直線 ${fmtDist(p.dist)}`, `🚶 約 ${walkGuess(p.dist)}`);
  if (p.transit && (!p.walk || p.transit.sec < p.walk.sec - 120)) bits.push(`🚇 ${fmtDur(p.transit.sec)}`);
  if (p.rating) bits.push(`⭐ ${p.rating.toFixed(1)}${p.ratingCount ? ` (${p.ratingCount})` : ''}`);
  return bits.map((b) => `<span>${esc(b)}</span>`).join('');
}

function cardHead(p) {
  const img = p.photo ? `<img class="thumb" src="${esc(p.photo)}" alt="" loading="lazy">` : `<div class="thumb"></div>`;
  const tags = [p.type && `<span class="tag">${esc(p.type)}</span>`, p.price && `<span class="tag price">💰 ${esc(p.price)}</span>`].filter(Boolean).join(' ');
  return `<div class="card-head" data-toggle="${esc(p.uid)}">${img}<div class="card-body">
    <h3>${esc(p.name)}</h3><div class="meta">${metaLine(p)}</div>
    <div style="margin-top:4px">${tags}</div>
    ${p.summary ? `<p class="desc">${esc(p.summary)}</p>` : ''}
  </div></div>`;
}

function renderList(el, items, emptyMsg) {
  el.innerHTML = items.length
    ? items.map((p) => `<article class="card" id="card-${cssId(p.uid)}">${cardHead(p)}<div class="detail hidden"></div></article>`).join('')
    : `<div class="empty">${emptyMsg}</div>`;
}
const cssId = (s) => s.replace(/[^\w-]/g, (c) => c.charCodeAt(0).toString(36));

function renderSights() {
  renderList($('#list-sights'), S.sights, S.map ? '這附近沒找到景點，試著把範圍調大。' : '附近沒有維基百科條目。設定 Google Maps 金鑰後可以找到更多景點。');
}
function renderFood() {
  renderList($('#list-food'), S.food, S.map ? '這附近沒找到餐廳，試著把範圍調大。' : '設定 Google Maps 金鑰後就能搜尋附近美食。');
}

const findItem = (uid) => [...S.sights, ...S.food].find((p) => p.uid === uid);

async function toggleCard(uid) {
  const item = findItem(uid);
  const card = document.getElementById(`card-${cssId(uid)}`);
  if (!item || !card) return;
  const detail = card.querySelector('.detail');
  const open = detail.classList.toggle('hidden') === false;
  if (!open) return;
  if (S.map) S.map.panTo(item.loc);
  if (detail.dataset.filled) return;
  detail.dataset.filled = '1';
  detail.innerHTML = '<div class="small">載入中…</div>';

  let html = '';
  if (item.kind === 'sights') {
    const story = await wikiStory(item).catch(() => null);
    html += '<h4>📜 歷史與故事</h4>';
    if (!story) {
      html += `<div class="story">${esc(item.summary || '維基百科上還沒有這個地點的條目，可以看看下面的遊客評論。')}</div>`;
    } else {
      const src = `資料來源：<a href="${esc(story.url)}" target="_blank" rel="noopener">${story.lang === 'zh' ? '' : esc(LANG_NAME[story.lang] || story.lang)}維基百科「${esc(story.title)}」</a>`;
      if (story.lang === 'zh') {
        html += `<div class="story">${esc(story.text)}</div><div class="small">${src}</div>`;
      } else if (story.translated) {
        html += `<div class="story">${esc(story.translated)}</div><div class="small">${src}（Google 自動翻譯）</div>`;
      } else {
        const gt = `https://translate.google.com/?sl=${story.lang}&tl=zh-TW&op=translate&text=${encodeURIComponent(story.text.slice(0, 1800))}`;
        html += `<div class="story">${esc(story.text)}</div><div class="small">${src}<br>中文版維基百科沒有這篇 → <a href="${esc(gt)}" target="_blank" rel="noopener">用 Google 翻譯成中文</a>（在 Google Cloud 啟用 Cloud Translation API 後，會自動翻譯）</div>`;
      }
    }
  } else {
    html += '<h4>🍽️ 特色</h4>';
    const feats = [item.type, ...item.serves].filter(Boolean);
    html += `<div>${feats.map((f) => `<span class="tag">${esc(f)}</span>`).join(' ') || '—'}</div>`;
    if (item.summary) html += `<p class="desc">${esc(item.summary)}</p>`;
    html += `<h4>💰 價錢</h4><div>${esc(item.price || 'Google 上沒有這家店的價位資料，可以看下面評論裡提到的價錢')}</div>`;
    const priceMentions = (item.reviews || []).map((r) => r.text.match(/[^。！!？?\n]*(\d[\d,]*\s*(?:元|円|日圓|日幣|塊)|(?:NT\$?|[¥￥$])\s*\d[\d,]*)[^。！!？?\n]*/)).filter(Boolean).map((m) => m[0].trim());
    if (priceMentions.length) html += `<div class="small">評論提到：${priceMentions.slice(0, 3).map(esc).join('；')}</div>`;
  }
  if (item.openNow) html += `<h4>🕒 今日營業</h4><div>${esc(item.openNow)}</div>`;
  if (item.address) html += `<h4>📫 地址</h4><div>${esc(item.address)}</div>`;
  if (item.reviews?.length) {
    html += `<h4>💬 ${item.kind === 'food' ? '食客' : '遊客'}怎麼說</h4>`;
    html += item.reviews.map((r) => `<div class="review">${r.rating ? `⭐${r.rating} ` : ''}${esc(r.text.length > 160 ? `${r.text.slice(0, 160)}…` : r.text)}<div class="small">${esc(r.when || '')}</div></div>`).join('');
  }
  html += `<h4>🧭 怎麼去</h4><div>${item.walk ? `Google 地圖步行路線 ${fmtDist(item.walk.meters)}，約 ${fmtDur(item.walk.sec)}` : `直線 ${fmtDist(item.dist)}，步行大約 ${walkGuess(item.dist)}`}${item.transit ? `；搭大眾運輸約 ${fmtDur(item.transit.sec)}` : ''}。按下面按鈕看完整路線與各種交通方式要多久。</div>`;
  html += `<div class="actions"><button class="go-btn" data-go="${esc(uid)}">帶我去這裡 ➜</button>
    ${item.url ? `<a class="ghost-btn" href="${esc(item.url)}" target="_blank" rel="noopener">在 Google 地圖看</a>` : ''}</div>`;
  detail.innerHTML = html;
}

function focusCard(uid) {
  const item = findItem(uid);
  if (!item) return;
  switchTab(item.kind);
  const card = document.getElementById(`card-${cssId(uid)}`);
  card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (card?.querySelector('.detail').classList.contains('hidden')) toggleCard(uid);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#list-sights').classList.toggle('hidden', name !== 'sights');
  $('#list-food').classList.toggle('hidden', name !== 'food');
  $('#route-view').classList.toggle('hidden', name !== 'route');
  $('#filters').classList.toggle('hidden', name === 'route');
}

// ---------- 路線：要花多少時間、怎麼走 ----------
const MODES = [
  { id: 'WALK', label: '🚶 步行', gm: 'walking' },
  { id: 'TRANSIT', label: '🚇 大眾運輸', gm: 'transit' },
  { id: 'DRIVE', label: '🚗 開車', gm: 'driving' },
];

async function computeRoute(dest, mode) {
  const body = {
    origin: { location: { latLng: { latitude: S.origin.lat, longitude: S.origin.lng } } },
    destination: dest.placeId ? { placeId: dest.placeId } : { location: { latLng: { latitude: dest.loc.lat, longitude: dest.loc.lng } } },
    travelMode: mode,
    languageCode: 'zh-TW',
    units: 'METRIC',
  };
  if (mode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE';
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': S.key,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.legs.steps.localizedValues,routes.legs.steps.travelMode,routes.legs.steps.transitDetails,routes.localizedValues',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Routes ${r.status}`);
  const route = data.routes?.[0];
  if (!route) return null;
  return {
    sec: parseInt(route.duration, 10),
    meters: route.distanceMeters,
    fare: route.localizedValues?.transitFare?.text,
    path: google.maps.geometry.encoding.decodePath(route.polyline.encodedPolyline),
    steps: (route.legs?.[0]?.steps || []).map((s) => ({
      text: s.navigationInstruction?.instructions || (s.transitDetails ? '' : '繼續前進'),
      dist: s.localizedValues?.distance?.text, dur: s.localizedValues?.staticDuration?.text,
      transit: s.transitDetails && {
        line: s.transitDetails.transitLine?.nameShort || s.transitDetails.transitLine?.name,
        color: s.transitDetails.transitLine?.color || '#0f766e',
        vehicle: s.transitDetails.transitLine?.vehicle?.name?.text,
        from: s.transitDetails.stopDetails?.departureStop?.name,
        to: s.transitDetails.stopDetails?.arrivalStop?.name,
        stops: s.transitDetails.stopCount,
        dep: s.transitDetails.localizedValues?.departureTime?.time?.text,
        headsign: s.transitDetails.headsign,
      },
    })),
  };
}

async function openRoute(uid) {
  const item = findItem(uid);
  if (!item || !S.origin) return;
  S.selected = item;
  document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
  document.getElementById(`card-${cssId(uid)}`)?.classList.add('selected');
  $('#tabRoute').disabled = false;
  switchTab('route');
  const view = $('#route-view');
  view.innerHTML = `<div class="card"><div class="detail"><h4>前往</h4><h3 style="margin:0">${esc(item.name)}</h3>
    <div class="small">從${S.manual ? '你選的位置' : '目前位置'}出發</div>
    <div class="modes">${MODES.map((m) => `<button class="mode" data-mode="${m.id}"><span class="t">…</span><span class="d">${m.label}</span></button>`).join('')}</div>
    <div id="route-steps"></div>
    <div class="actions" id="nav-actions"></div></div></div>`;

  if (!S.map) {
    view.querySelectorAll('.mode .t').forEach((t) => (t.textContent = '—'));
    view.querySelector('#route-steps').innerHTML = '<div class="small">設定 Google Maps 金鑰後，才能計算各種交通方式需要多少時間。</div>';
    renderNavButtons(item);
    return;
  }
  const results = {};
  await Promise.all(MODES.map(async (m) => {
    const btn = view.querySelector(`[data-mode="${m.id}"] .t`);
    try {
      results[m.id] = await computeRoute(item, m.id);
      btn.textContent = results[m.id] ? fmtDur(results[m.id].sec) : '無路線';
    } catch (e) {
      console.warn(m.id, e);
      btn.textContent = '—';
      if (/not been used|disabled|PERMISSION/i.test(e.message)) {
        view.querySelector('#route-steps').innerHTML = `<div class="small">⚠️ 請在 Google Cloud 啟用 <b>Routes API</b>：${esc(e.message)}</div>`;
      }
    }
  }));
  S.routeResults = results;
  const best = results[S.routeMode] ? S.routeMode : MODES.find((m) => results[m.id])?.id;
  if (best) showMode(best);
  renderNavButtons(item);
}

function showMode(id) {
  S.routeMode = id;
  const r = S.routeResults?.[id];
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === id));
  const box = $('#route-steps');
  if (!r) { box.innerHTML = '<div class="small">這種交通方式找不到路線。</div>'; return; }
  box.innerHTML = `<div><b>${fmtDur(r.sec)}</b> · ${fmtDist(r.meters)}${r.fare ? ` · 車資 ${esc(r.fare)}` : ''}
    · 預計 ${new Date(Date.now() + r.sec * 1000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} 抵達</div>
    <ol class="steps">${r.steps.map((s) => s.transit
      ? `<li><span class="transit-line" style="background:${esc(s.transit.color)}">${esc(s.transit.vehicle || '')} ${esc(s.transit.line || '')}</span>
          ${esc(s.transit.from)} → ${esc(s.transit.to)}${s.transit.headsign ? `（往 ${esc(s.transit.headsign)}）` : ''}
          <div class="sd">${s.transit.dep ? `${esc(s.transit.dep)} 發車 · ` : ''}${s.transit.stops ? `${s.transit.stops} 站 · ` : ''}${esc(s.dur || '')}</div></li>`
      : `<li>${esc(s.text)}<div class="sd">${esc([s.dist, s.dur].filter(Boolean).join(' · '))}</div></li>`).join('')}</ol>`;
  if (S.routeLine) S.routeLine.setMap(null);
  S.routeLine = new google.maps.Polyline({ map: S.map, path: r.path, strokeColor: '#2563eb', strokeWeight: 5, strokeOpacity: 0.85 });
  const b = new google.maps.LatLngBounds();
  r.path.forEach((p) => b.extend(p));
  S.map.fitBounds(b, 40);
}

function renderNavButtons(item) {
  const gm = MODES.find((m) => m.id === S.routeMode)?.gm || 'walking';
  const q = new URLSearchParams({ api: '1', origin: `${S.origin.lat},${S.origin.lng}`, destination: item.placeId ? item.name : `${item.loc.lat},${item.loc.lng}`, travelmode: gm, dir_action: 'navigate' });
  if (item.placeId) q.set('destination_place_id', item.placeId);
  $('#nav-actions').innerHTML = `<a class="go-btn" style="text-decoration:none" href="https://www.google.com/maps/dir/?${q}" target="_blank" rel="noopener">開啟 Google 地圖導航 ➜</a>
    <button class="ghost-btn" data-back="${esc(item.kind)}">← 回列表</button>`;
}

// ---------- 通知 ----------
function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.serviceWorker?.getRegistration().then((reg) => (reg ? reg.showNotification(title, { body, icon: 'icon.svg' }) : new Notification(title, { body })));
}

// ---------- 事件 ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle],[data-go],[data-mode],[data-back],.tab');
  if (!t) return;
  if (t.dataset.toggle) toggleCard(t.dataset.toggle);
  else if (t.dataset.go) openRoute(t.dataset.go);
  else if (t.dataset.mode) { showMode(t.dataset.mode); if (S.selected) renderNavButtons(S.selected); }
  else if (t.dataset.back) switchTab(t.dataset.back);
  else if (t.classList.contains('tab') && !t.disabled) switchTab(t.dataset.tab);
});

$('#btnRefresh').onclick = () => search(S.manual ? '你選的位置' : '你目前的位置');
$('#radius').onchange = () => search(S.manual ? '你選的位置' : '你目前的位置');
$('#btnLocate').onclick = () => {
  if (!S.gps) { setStatus('還沒取得 GPS 定位…'); return; }
  setOrigin(S.gps, false);
  search('你目前的位置');
};
const paintAuto = () => { $('#btnAuto').textContent = `自動：${S.auto ? '開' : '關'}`; };
$('#btnAuto').onclick = () => { S.auto = !S.auto; save('auto', S.auto ? '1' : '0'); paintAuto(); };
paintAuto();

$('#btnSettings').onclick = () => {
  $('#apiKey').value = S.key;
  $('#moveThreshold').value = String(S.moveThreshold);
  $('#dwellSeconds').value = String(S.dwellSeconds);
  $('#notify').checked = S.notify;
  $('#settings').showModal();
};
$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'save') return;
  const newKey = $('#apiKey').value.trim();
  S.moveThreshold = +$('#moveThreshold').value; save('moveThreshold', S.moveThreshold);
  S.dwellSeconds = +$('#dwellSeconds').value; save('dwellSeconds', S.dwellSeconds);
  S.notify = $('#notify').checked; save('notify', S.notify ? '1' : '0');
  if (S.notify && 'Notification' in window) Notification.requestPermission();
  if (newKey !== S.key) { save('gmKey', newKey); location.reload(); }
});

// 產生 QR code：手機掃了就會打開這個 App 並自動存好金鑰（金鑰放在 # 後面，不會傳到伺服器）
$('#btnPhone').onclick = async () => {
  const key = $('#apiKey').value.trim();
  const box = $('#qrBox');
  box.classList.remove('hidden');
  if (/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)) {
    box.textContent = '目前是電腦上的測試網址，手機打不開。請先把 App 部署到網路上（見 README），再從那個網址開啟這個畫面。';
    return;
  }
  if (!window.qrcode) {
    await new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
      s.onload = ok; s.onerror = fail;
      document.head.appendChild(s);
    }).catch(() => {});
  }
  const url = `${location.origin}${location.pathname}${key ? `#key=${encodeURIComponent(key)}` : ''}`;
  if (!window.qrcode) { box.textContent = url; return; }
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  box.innerHTML = `${qr.createImgTag(4, 0)}<div>用手機相機掃描 → 打開網頁 → 瀏覽器選單「加入主畫面」</div>`;
};

// ---------- 啟動 ----------
(async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('key')) {
    S.key = hash.get('key');
    save('gmKey', S.key);
    history.replaceState(null, '', location.pathname + location.search);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // 先用 URL ?lat=&lng= 或台北車站當地圖中心，拿到定位後會自動換
  const qs = new URLSearchParams(location.search);
  const start = qs.has('lat') ? { lat: +qs.get('lat'), lng: +qs.get('lng') } : null;
  await initMap(start || { lat: 25.0478, lng: 121.5170 });
  if (!S.key) setStatus('請先按右上角 ⚙️ 設定 Google Maps 金鑰。現在先用維基百科找附近歷史景點。');
  if (start) { setOrigin(start, true); search('指定位置'); }
  startGeolocation();
})();
