/* 旅途即時導覽 — 到定點自動找歷史景點與在地美食，並用 Google Maps 規劃路線 */
'use strict';

// ---------- 狀態 ----------
const S = {
  key: load('gmKey', ''),
  moveThreshold: +load('moveThreshold', 500),
  dwellSeconds: +load('dwellSeconds', 90),
  notify: load('notify', '0') === '1',
  tdxId: load('tdxId', ''),
  tdxSecret: load('tdxSecret', ''),
  rapidKey: load('rapidKey', ''),
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
      if (!S.manual) {
        const first = !S.origin;
        S.origin = S.gps;
        drawUser();
        // 第一次拿到定位時，把地圖移到你所在的位置
        if (first && S.map) { S.map.setCenter(S.gps); S.map.setZoom(15); }
      }
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
  if (S.map) S.map.panTo(S.origin);
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
    wiki.push(w.zhTitle ? { ...w, title: w.zhTitle, lang: 'zh', extract: null, desc: null } : w);
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
  // 用搜尋框查的地點，就顯示你輸入的名稱
  const place = label.startsWith('「') ? `${label.slice(1, -1)}附近` : ctx.name;
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
  'primaryTypeDisplayName', 'types', 'formattedAddress', 'googleMapsURI', 'regularOpeningHours', 'reviews'];

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
  const LODGING = /(lodging|hotel|resort_hotel|motel|hostel|guest_house|bed_and_breakfast)/;
  return (res.places || []).filter((p) => kind !== 'food' || !(p.types || []).some((t) => LODGING.test(t))).map((p) => {
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
  if (a && b && a <= 1) return `每人約 ${sym}${b} 以下`;
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
  $('#go-view')?.classList.toggle('hidden', name !== 'go');
  $('#filters').classList.toggle('hidden', name === 'route' || name === 'go');
  if (name === 'go') paintGoFrom();
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

// ---------- 我要去：查大眾運輸（搭什麼、幾點來、多少錢） ----------
const secs = (d) => parseInt(d || '0', 10) || 0;
const hhmm = (d) => d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
const VEHICLE_ICON = { BUS: '🚌', INTERCITY_BUS: '🚌', TROLLEYBUS: '🚎', SUBWAY: '🚇', METRO_RAIL: '🚇', LIGHT_RAIL: '🚈', TRAM: '🚋', MONORAIL: '🚝', RAIL: '🚆', HEAVY_RAIL: '🚆', COMMUTER_TRAIN: '🚆', HIGH_SPEED_TRAIN: '🚄', LONG_DISTANCE_TRAIN: '🚆', FERRY: '⛴️', CABLE_CAR: '🚡', GONDOLA_LIFT: '🚡', FUNICULAR: '🚞' };

function loadRecent() { try { return JSON.parse(localStorage.getItem('goRecent') || '[]'); } catch { return []; } }
function saveRecent(p) {
  const list = [p, ...loadRecent().filter((r) => r.name !== p.name)].slice(0, 6);
  try { localStorage.setItem('goRecent', JSON.stringify(list)); } catch {}
  paintRecent();
}
function paintRecent() {
  const box = $('#goRecent');
  if (!box) return;
  const list = loadRecent();
  box.innerHTML = list.length ? `<span class="small">最近：</span>${list.map((r, i) => `<button type="button" class="chip" data-recent="${i}">${esc(r.name)}</button>`).join('')}` : '';
}
function paintGoFrom() {
  const el = $('#goFrom');
  if (!el) return;
  el.textContent = S.manual ? ($('#placeQuery')?.value || '你選的位置') : '你目前的位置';
  paintRecent();
}

async function transitOptions(dest, from = { loc: S.origin }) {
  const body = {
    origin: { location: { latLng: { latitude: from.loc.lat, longitude: from.loc.lng } } },
    destination: dest.placeId ? { placeId: dest.placeId } : { location: { latLng: { latitude: dest.loc.lat, longitude: dest.loc.lng } } },
    travelMode: 'TRANSIT',
    computeAlternativeRoutes: true,
    languageCode: 'zh-TW',
    units: 'METRIC',
  };
  const pref = $('#goPref').value, mode = $('#goModes').value;
  if (pref || mode) {
    body.transitPreferences = {};
    if (pref) body.transitPreferences.routingPreference = pref;
    if (mode === 'BUS') body.transitPreferences.allowedTravelModes = ['BUS'];
    if (mode === 'RAIL') body.transitPreferences.allowedTravelModes = ['SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'RAIL'];
  }
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': S.key,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.localizedValues,routes.travelAdvisory.transitFare,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction,routes.legs.steps.localizedValues,routes.legs.steps.transitDetails',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Routes ${r.status}`);
  const now = Date.now();
  return (data.routes || []).map((rt) => {
    const steps = rt.legs?.[0]?.steps || [];
    // 連續的走路步驟合併成一段，公車／捷運每段保留
    const segs = [];
    for (const s of steps) {
      if (s.transitDetails) {
        const td = s.transitDetails, line = td.transitLine || {};
        segs.push({
          type: 'transit',
          vtype: line.vehicle?.type || '',
          icon: VEHICLE_ICON[line.vehicle?.type] || '🚌',
          vehicle: line.vehicle?.name?.text || '',
          line: zhLine(line.nameShort || line.name || ''),
          lineName: line.name || '',
          color: line.color || '#0f766e', textColor: line.textColor || '#ffffff',
          agency: line.agencies?.[0]?.name || '',
          from: td.stopDetails?.departureStop?.name, to: td.stopDetails?.arrivalStop?.name,
          fromLoc: td.stopDetails?.departureStop?.location?.latLng ? { lat: td.stopDetails.departureStop.location.latLng.latitude, lng: td.stopDetails.departureStop.location.latLng.longitude } : null,
          toLoc: td.stopDetails?.arrivalStop?.location?.latLng ? { lat: td.stopDetails.arrivalStop.location.latLng.latitude, lng: td.stopDetails.arrivalStop.location.latLng.longitude } : null,
          dep: td.stopDetails?.departureTime ? new Date(td.stopDetails.departureTime) : null,
          arr: td.stopDetails?.arrivalTime ? new Date(td.stopDetails.arrivalTime) : null,
          headsign: String(td.headsign || '').replace(/^往\s*/, ''), stops: td.stopCount,
          sec: secs(s.staticDuration),
        });
      } else {
        const last = segs[segs.length - 1];
        if (last?.type === 'walk') { last.sec += secs(s.staticDuration); last.m += s.distanceMeters || 0; }
        else segs.push({ type: 'walk', sec: secs(s.staticDuration), m: s.distanceMeters || 0 });
      }
    }
    const transits = segs.filter((g) => g.type === 'transit');
    const first = transits[0];
    const walkBefore = segs[0]?.type === 'walk' ? segs[0].sec : 0;
    const f = rt.travelAdvisory?.transitFare;
    const fareNum = f ? Number(f.units || 0) + Number(f.nanos || 0) / 1e9 : null;
    const cur = f?.currencyCode;
    const sym = cur === 'TWD' ? 'NT$' : cur === 'JPY' ? '¥' : cur ? `${cur} ` : '';
    const lastT = transits[transits.length - 1];
    const walkAfter = segs[segs.length - 1]?.type === 'walk' && segs.length > 1 ? segs[segs.length - 1].sec : 0;
    const leaveBy = first?.dep ? new Date(first.dep.getTime() - walkBefore * 1000) : null;
    const arrive = lastT?.arr ? new Date(lastT.arr.getTime() + walkAfter * 1000) : new Date(now + secs(rt.duration) * 1000);
    return {
      sec: leaveBy ? Math.round((arrive - leaveBy) / 1000) : secs(rt.duration),
      meters: rt.distanceMeters,
      arrive,
      leaveBy,
      key: transits.map((g) => `${g.line}@${g.from}>${g.to}`).join('|') || 'walk',
      fare: fareNum ? `${sym}${Math.round(fareNum * 100) / 100}` : (rt.localizedValues?.transitFare?.text || null),
      transfers: Math.max(0, transits.length - 1),
      walkSec: segs.filter((g) => g.type === 'walk').reduce((a, g) => a + g.sec, 0),
      segs, first,
      path: rt.polyline?.encodedPolyline ? google.maps.geometry.encoding.decodePath(rt.polyline.encodedPolyline) : [],
    };
  });
}

function countdown(dep) {
  const min = Math.round((dep.getTime() - Date.now()) / 60000);
  if (min <= 0) return { text: '即將發車', soon: true };
  if (min >= 60) return { text: `還有 ${Math.floor(min / 60)} 小時${min % 60 ? ` ${min % 60} 分` : ''}`, soon: false };
  return { text: `還有 ${min} 分鐘`, soon: min <= 5 };
}

const LINE_ZH = [
  [/Tze-?Chiang|Tzu-?Chiang/i, '自強號'], [/Chu-?Kuang|Chu-?Guang/i, '莒光號'], [/Puyuma/i, '普悠瑪'], [/Taroko/i, '太魯閣'],
  [/Local Express/i, '區間快車'], [/Local Train|^Local$/i, '區間車'], [/Fu-?Hsing/i, '復興號'], [/High[- ]Speed Rail|THSR/i, '高鐵'],
];
function zhLine(n) {
  const hit = LINE_ZH.find(([re]) => re.test(n));
  return hit ? hit[1] : n;
}

function lineChip(g) {
  return `<span class="transit-line" style="background:${esc(g.color)};color:${esc(g.textColor)}">${g.icon} ${esc(g.line || g.vehicle)}</span>`;
}

function optionCard(o, i, dest, from = { loc: S.origin }, country = S.country) {
  const legs = o.segs.map((g) => (g.type === 'walk'
    ? `<span class="walk">🚶${Math.max(1, Math.round(g.sec / 60))}分</span>`
    : lineChip(g))).join('<span class="arrow">›</span>');
  const f = o.first;
  const cd = f?.dep ? countdown(f.dep) : null;
  const next = f
    ? `<div class="next-bus">${f.icon} <b>${esc(f.line || f.lineName)}</b> ${esc(f.vehicle)}${f.headsign ? `（往 ${esc(f.headsign)}）` : ''}<br>
        在「${esc(f.from)}」上車${f.dep ? `，<b>${hhmm(f.dep)}</b> 發車 <span class="count${cd.soon ? ' soon' : ''}" data-dep="${f.dep.getTime()}">${cd.text}</span>` : ''}
        ${o.leaveBy ? `<br>👉 最晚 <b>${hhmm(o.leaveBy)}</b> 要出發走去車站` : ''}
        ${o.later?.length ? `<br>⏭ 下一班：${o.later.slice(0, 4).map(hhmm).join('、')}` : ''}
        ${country === 'TW' ? `<div class="tdx" data-tdx="${i}-${o.segs.indexOf(f)}"></div>` : ''}</div>`
    : '<div class="next-bus">這段路走路就到了，不用搭車。</div>';
  const steps = o.segs.map((g, j) => (g.type === 'walk'
    ? `<li>🚶 走路 ${fmtDur(g.sec)}（${fmtDist(g.m)}）</li>`
    : `<li>${lineChip(g)} ${esc(g.from)} → ${esc(g.to)}${g.headsign ? `（往 ${esc(g.headsign)}）` : ''}
        <div class="sd">${g.dep ? `${hhmm(g.dep)} 發車 · ` : ''}${g.arr ? `${hhmm(g.arr)} 到站 · ` : ''}${g.stops ? `坐 ${g.stops} 站 · ` : ''}${fmtDur(g.sec)}${g.agency ? ` · ${esc(g.agency)}` : ''}${g.fare ? ` · 💰 ${esc(g.fare)}` : ''}</div>${country === 'TW' ? `<div class="tdx sd" data-tdx="${i}-${j}"></div>` : ''}</li>`)).join('');
  const q = new URLSearchParams({ api: '1', origin: `${from.loc.lat},${from.loc.lng}`, destination: `${dest.loc.lat},${dest.loc.lng}`, travelmode: 'transit' });
  return `<article class="card"><div class="opt-head" data-opt="${i}">
      <div class="opt-top"><span class="dur">${fmtDur(o.sec)}${i === 0 ? '<span class="best">推薦</span>' : ''}</span>
        <span class="fare">${o.fare ? `💰 ${esc(o.fare)}` : '<span class="small">車資：Google 沒有資料</span>'}</span></div>
      <div class="small">${o.leaveBy ? `${hhmm(o.leaveBy)} 出門` : '現在出發'} → 約 <b>${hhmm(o.arrive)}</b> 抵達 · ${o.transfers ? `轉乘 ${o.transfers} 次` : '不用轉乘'} · 走路共 ${fmtDur(o.walkSec)}</div>
      <div class="legs">${legs}</div>
      ${next}
      <div class="small" style="margin-top:6px">點這裡看完整搭乘步驟 ▾</div>
    </div>
    <div class="detail hidden"><h4>完整搭乘步驟</h4><ol class="steps">${steps}</ol>
      <div class="actions"><button class="go-btn" data-optmap="${i}">在地圖上看</button>
      <a class="ghost-btn" href="https://www.google.com/maps/dir/?${q}" target="_blank" rel="noopener">開啟 Google 地圖</a></div></div>
  </article>`;
}

// 同一路線不同班次合併、依抵達時間排序（Google 與 NAVITIME 共用）
function groupOptions(raw) {
  const mode = $('#goModes').value;
  const isBus = (t) => /BUS/.test(t);
  const groups = new Map();
  for (const o of raw) {
    const types = o.segs.filter((g) => g.type === 'transit').map((g) => g.vtype);
    if (mode === 'BUS' && types.some((t) => !isBus(t))) continue;
    if (mode === 'RAIL' && types.some(isBus)) continue;
    if (o.leaveBy && o.leaveBy.getTime() < Date.now() - 60000) continue; // 已經來不及的班次
    if (!groups.has(o.key)) groups.set(o.key, []);
    groups.get(o.key).push(o);
  }
  return [...groups.values()].map((list) => {
    list.sort((a, b) => (a.first?.dep || 0) - (b.first?.dep || 0));
    return { ...list[0], later: list.slice(1).map((o) => o.first?.dep).filter(Boolean) };
  }).sort((a, b) => a.arrive - b.arrive);
}

// ---------- 日本交通：NAVITIME（搭哪條線、幾點發車、票價） ----------
const NT_HOST = 'navitime-route-totalnavi.p.rapidapi.com';
const NT_MOVE = {
  local_train: ['🚃', '普通車'], rapid_train: ['🚃', '快速'], semiexpress_train: ['🚃', '準急'], express_train: ['🚆', '急行'],
  limited_express_train: ['🚆', '特急'], liner: ['🚆', '特急'], superexpress_train: ['🚄', '新幹線'], sleeper_ultraexpress: ['🚆', '寢台特急'],
  bus: ['🚌', '公車'], highway_bus: ['🚌', '高速巴士'], midnight_bus: ['🚌', '深夜巴士'], domestic_flight: ['✈️', '國內線班機'],
  ferry: ['⛴️', '渡輪'], car: ['🚗', '汽車'], cycle: ['🚲', '自行車'],
};
const yen = (f) => (f?.unit_0 ? `¥${f.unit_0}${f.unit_48 && f.unit_48 !== f.unit_0 ? `（IC 卡 ¥${f.unit_48}）` : ''}` : null);

async function japanOptions(from, dest) {
  const q = new URLSearchParams({ start: `${from.loc.lat},${from.loc.lng}`, goal: `${dest.loc.lat},${dest.loc.lng}`, limit: '5' });
  const r = await fetch(`https://${NT_HOST}/route_transit?${q}`, { headers: { 'x-rapidapi-key': S.rapidKey, 'x-rapidapi-host': NT_HOST } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || `NAVITIME ${r.status}`);
  return (d.items || []).map((it) => {
    const secs = it.sections || [];
    const segs = [], path = [];
    const pname = (p) => (p?.name === 'start' ? from.name : p?.name === 'goal' ? dest.name : p?.name) || '';
    secs.forEach((s, k) => {
      if (s.type === 'point') { if (s.coord) path.push({ lat: s.coord.lat, lng: s.coord.lon }); return; }
      if (s.move === 'walk') {
        const last = segs[segs.length - 1];
        if (last?.type === 'walk') { last.sec += (s.time || 0) * 60; last.m += s.distance || 0; }
        else segs.push({ type: 'walk', sec: (s.time || 0) * 60, m: s.distance || 0 });
        return;
      }
      const [icon, label] = NT_MOVE[s.move] || ['🚆', '電車'];
      const t = s.transport || {};
      const color = t.color ? (String(t.color).startsWith('#') ? t.color : `#${t.color}`) : '#0f766e';
      segs.push({
        type: 'transit', vtype: /bus/.test(s.move) ? 'BUS' : 'RAIL', icon,
        vehicle: t.type || label, line: s.line_name || t.name || label, lineName: t.name || s.line_name || '',
        color, textColor: '#ffffff', agency: t.company?.name || '',
        from: pname(secs[k - 1]), to: pname(secs[k + 1]),
        dep: s.from_time ? new Date(s.from_time) : null, arr: s.to_time ? new Date(s.to_time) : null,
        headsign: t.links?.[0]?.destination?.name || '', stops: null, sec: (s.time || 0) * 60, fare: yen(t.fare),
      });
    });
    const m = it.summary?.move || {};
    const transits = segs.filter((g) => g.type === 'transit');
    const leaveBy = m.from_time ? new Date(m.from_time) : null;
    const arrive = m.to_time ? new Date(m.to_time) : new Date(Date.now() + (m.time || 0) * 60000);
    return {
      sec: (m.time || 0) * 60, arrive, leaveBy, fare: yen(m.fare),
      transfers: m.transit_count ?? Math.max(0, transits.length - 1),
      walkSec: segs.filter((g) => g.type === 'walk').reduce((a, g) => a + g.sec, 0),
      segs, first: transits[0], path,
      key: transits.map((g) => `${g.line}@${g.from}>${g.to}`).join('|') || 'walk',
    };
  });
}

function mapsLink(from, dest) {
  const q = new URLSearchParams({ api: '1', origin: `${from.loc.lat},${from.loc.lng}`, destination: `${dest.loc.lat},${dest.loc.lng}`, travelmode: 'transit' });
  return `https://www.google.com/maps/dir/?${q}`;
}

// 查交通：dest 目的地；opt.from 出發地（預設目前位置）、opt.box 要顯示在哪裡（跨國行程的每一段）
async function planTrip(dest, opt = {}) {
  const box = opt.box || $('#goResults');
  const top = !opt.box;
  const from = opt.from || { name: S.manual ? ($('#placeQuery')?.value || '你選的位置') : '你目前的位置', loc: S.origin };
  if (top) $('#goQuery').value = dest.name;
  if (!from.loc) { box.innerHTML = '<div class="empty">還沒拿到你的位置，請稍等一下或按 📍。</div>'; return; }
  if (!S.map) { box.innerHTML = '<div class="empty">要先在 ⚙️ 設定 Google Maps 金鑰，才能查交通。</div>'; return; }
  const cFrom = guessCountry(from.loc) || S.country;
  const cTo = guessCountry(dest.loc) || cFrom;
  if (top) {
    saveRecent({ name: dest.name, loc: dest.loc });
    S.goDest = dest;
    // 台灣 ⇄ 日本：要搭飛機，分三段查
    if (cFrom && cTo && cFrom !== cTo && AIRPORTS[cFrom] && AIRPORTS[cTo]) { planAbroad(from, dest, cFrom, cTo); return; }
  }
  box.innerHTML = '<div class="empty">正在查詢班次…</div>';
  try {
    let opts, source;
    if (cFrom === 'JP') {
      if (!S.rapidKey) {
        box.innerHTML = `<div class="card"><div class="detail"><h4>前往「${esc(dest.name)}」</h4>
          <div>日本的電車／公車要用 <b>NAVITIME</b> 查。到 ⚙️ 設定填入 NAVITIME 金鑰後，這裡就會直接顯示搭哪條線、幾點發車、票價多少。</div>
          <div class="actions"><a class="go-btn" style="text-decoration:none" href="${esc(mapsLink(from, dest))}" target="_blank" rel="noopener">先用 Google 地圖查 ➜</a></div></div></div>`;
        return;
      }
      opts = groupOptions(await japanOptions(from, dest));
      source = '班次與票價來自 NAVITIME（日本），實際以車站公告為準。';
    } else {
      opts = groupOptions(await transitOptions(dest, from));
      source = '班次時間來自 Google 時刻表，實際以站牌／車站公告為準。';
    }
    if (!opts.length) {
      const mode = $('#goModes').value;
      box.innerHTML = mode
        ? `<div class="empty">找不到符合「${esc($('#goModes').selectedOptions[0].text)}」的路線，改成「公車、捷運、火車都可以」試試看。</div>`
        : `<div class="card"><div class="detail"><h4>前往「${esc(dest.name)}」</h4><div>這裡查不到大眾運輸路線（可能太近、這個時間沒車，或這個地區沒有資料）。</div>
          <div class="actions"><a class="go-btn" style="text-decoration:none" href="${esc(mapsLink(from, dest))}" target="_blank" rel="noopener">用 Google 地圖再查一次 ➜</a></div></div></div>`;
      return;
    }
    if (opt.max) opts = opts.slice(0, opt.max);
    box.innerHTML = `<div class="small" style="padding:8px 4px">從「${esc(from.name)}」前往「${esc(dest.name)}」，${opt.max ? `最好的 ${opts.length} 種搭法` : `找到 ${opts.length} 種搭法（依抵達時間排序）`}。${source}</div>`
      + opts.map((o, i) => optionCard(o, i, dest, from, cFrom)).join('');
    box.dataset.optholder = '1';
    box.goOpts = opts;
    if (top) S.goOpts = opts;
    showOptionOnMap(0, box);
    if (cFrom === 'TW') tdxEnrich(opts, box);
  } catch (e) {
    console.warn(e);
    box.innerHTML = `<div class="empty">查詢失敗：${esc(e.message)}</div>`;
  }
}

function showOptionOnMap(i, holder) {
  const o = (holder?.goOpts || S.goOpts)?.[i];
  if (!o || !S.map || !o.path.length) return;
  if (S.routeLine) S.routeLine.setMap(null);
  S.routeLine = new google.maps.Polyline({ map: S.map, path: o.path, strokeColor: '#2563eb', strokeWeight: 5, strokeOpacity: 0.85 });
  const b = new google.maps.LatLngBounds();
  o.path.forEach((p) => b.extend(p));
  S.map.fitBounds(b, 40);
}

// ---------- 台灣 ⇄ 日本：到機場 → 航班 → 機場到目的地 ----------
const AIRPORTS = {
  TW: [
    ['TPE', '桃園國際機場', 25.0777, 121.2328], ['TSA', '台北松山機場', 25.0694, 121.5525],
    ['KHH', '高雄國際機場', 22.5771, 120.3500], ['RMQ', '台中國際機場', 24.2647, 120.6208],
  ],
  JP: [
    ['NRT', '成田機場（東京）', 35.7720, 140.3929], ['HND', '羽田機場（東京）', 35.5494, 139.7798],
    ['KIX', '關西機場（大阪）', 34.4320, 135.2304], ['UKB', '神戶機場', 34.6328, 135.2239],
    ['NGO', '中部機場（名古屋）', 34.8584, 136.8054], ['FUK', '福岡機場', 33.5859, 130.4507],
    ['CTS', '新千歲機場（札幌）', 42.7752, 141.6923], ['OKA', '那霸機場（沖繩）', 26.1958, 127.6459],
    ['ISG', '石垣機場', 24.3964, 124.2450], ['SDJ', '仙台機場', 38.1397, 140.9170],
    ['HIJ', '廣島機場', 34.4361, 132.9194], ['OKJ', '岡山機場', 34.7569, 133.8553],
    ['TAK', '高松機場', 34.2142, 134.0156], ['MYJ', '松山機場（愛媛）', 33.8272, 132.6997],
    ['KMJ', '熊本機場', 32.8373, 130.8551], ['KOJ', '鹿兒島機場', 31.8034, 130.7194],
    ['KMQ', '小松機場（金澤）', 36.3946, 136.4065], ['FSZ', '靜岡機場', 34.7960, 138.1894],
    ['IBR', '茨城機場', 36.1812, 140.4150], ['KIJ', '新潟機場', 37.9559, 139.1208],
    ['HKD', '函館機場', 41.7700, 140.8219], ['AOJ', '青森機場', 40.7347, 140.6908],
  ],
};
// 大機場（國際航班多）優先：小機場的距離乘上 1.8 再排序
const HUB = new Set(['TPE', 'KHH', 'NRT', 'HND', 'KIX', 'NGO', 'FUK', 'CTS', 'OKA']);
const airportList = (cc, loc, n) => AIRPORTS[cc]
  .map(([code, name, lat, lng]) => ({ code, name, loc: { lat, lng }, km: distM(loc, { lat, lng }) / 1000 }))
  .sort((a, b) => a.km * (HUB.has(a.code) ? 1 : 1.8) - b.km * (HUB.has(b.code) ? 1 : 1.8)).slice(0, n);

function flightLinks() {
  const a = S.ab;
  const from = $('#abFromAp').value, to = $('#abToAp').value, date = $('#abDate').value;
  const [y, m, d] = date.split('-');
  const gf = `https://www.google.com/travel/flights?hl=zh-TW&curr=TWD&q=${encodeURIComponent(`Flights from ${from} to ${to} on ${date} one way`)}`;
  const sk = `https://www.skyscanner.com.tw/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${y.slice(2)}${m}${d}/?adultsv2=1`;
  $('#abFlights').innerHTML = `<a class="go-btn" style="text-decoration:none" href="${esc(gf)}" target="_blank" rel="noopener">看航班時間與票價（Google 航班）➜</a>
    <a class="ghost-btn" href="${esc(sk)}" target="_blank" rel="noopener">Skyscanner 比價</a>`;
  a.fromAp = a.fromList.find((x) => x.code === from);
  a.toAp = a.toList.find((x) => x.code === to);
}

function planAbroad(from, dest, cFrom, cTo) {
  const box = $('#goResults');
  const fromList = airportList(cFrom, from.loc, 3);
  const toList = airportList(cTo, dest.loc, 4);
  S.ab = { from, dest, cFrom, cTo, fromList, toList };
  const tomorrow = new Date(Date.now() + 864e5);
  const opt = (list) => list.map((x, k) => `<option value="${x.code}"${k === 0 ? ' selected' : ''}>${esc(x.name)}（${x.code}，距離約 ${Math.round(x.km)} 公里）</option>`).join('');
  const land = { TW: '台灣', JP: '日本' };
  box.innerHTML = `<div class="card abroad"><div class="detail">
    <h3 style="margin:0 0 4px">✈️ ${esc(from.name)} → ${esc(dest.name)}</h3>
    <div class="small">從${land[cFrom]}到${land[cTo]}要搭飛機，分成三段幫你查：</div>

    <h4>① 到${land[cFrom]}的機場</h4>
    <select id="abFromAp">${opt(fromList)}</select>
    <div id="abLeg1"><div class="small">查詢中…</div></div>

    <h4>② 搭飛機</h4>
    <div class="row"><label class="small" style="flex:none;align-self:center">出發日</label>
      <input id="abDate" type="date" value="${ymd(tomorrow)}" min="${ymd(new Date())}"></div>
    <div class="row" style="margin-top:6px"><select id="abToAp">${opt(toList)}</select></div>
    <div class="actions" id="abFlights"></div>
    <div class="small">直飛航線、航班時間和票價每天會變，按上面按鈕會直接幫你搜好這一天、這兩個機場的航班。</div>

    <h4>③ 抵達後：機場 → ${esc(dest.name)}</h4>
    <button type="button" class="chip primary" data-ab="leg3">查機場到目的地怎麼搭</button>
    <div id="abLeg3"></div>
  </div></div>`;
  flightLinks();
  runLeg1();
}

function runLeg1() {
  const a = S.ab;
  planTrip({ name: a.fromAp.name, loc: a.fromAp.loc }, { box: $('#abLeg1'), from: a.from, max: 3 });
}
function runLeg3() {
  const a = S.ab;
  planTrip(a.dest, { box: $('#abLeg3'), from: { name: a.toAp.name, loc: a.toAp.loc }, max: 3 });
}

// 每 20 秒更新「還有幾分鐘」
setInterval(() => {
  document.querySelectorAll('[data-dep]').forEach((el) => {
    const cd = countdown(new Date(+el.dataset.dep));
    el.textContent = cd.text;
    el.classList.toggle('soon', cd.soon);
  });
}, 20000);

$('#goForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#goQuery').value.trim();
  if (!q) return;
  $('#goQuery').blur();
  const box = $('#goResults');
  box.innerHTML = '<div class="empty">搜尋目的地…</div>';
  try {
    const list = await findPlaces(q);
    if (!list.length) { box.innerHTML = '<div class="empty">找不到這個地方，換個說法試試看。</div>'; return; }
    if (list.length === 1) { planTrip(list[0]); return; }
    S.goHits = list;
    box.innerHTML = '<div class="small" style="padding:8px 4px">你要去的是哪一個？</div><div class="card place-pick">'
      + list.map((p, i) => `<button type="button" data-gohit="${i}">${esc(p.name)}<span class="addr">${esc(p.addr)}</span></button>`).join('')
      + '</div>';
  } catch (err) {
    console.warn(err);
    box.innerHTML = '<div class="empty">搜尋失敗，請稍後再試。</div>';
  }
});
$('#go-view')?.addEventListener('click', (e) => {
  const hit = e.target.closest('[data-gohit]');
  if (hit) { planTrip(S.goHits[+hit.dataset.gohit]); return; }
  const rec = e.target.closest('[data-recent]');
  if (rec) { planTrip(loadRecent()[+rec.dataset.recent]); return; }
  const m = e.target.closest('[data-optmap]');
  if (m) { showOptionOnMap(+m.dataset.optmap, m.closest('[data-optholder]')); $('#map').scrollIntoView({ behavior: 'smooth' }); return; }
  const ab = e.target.closest('[data-ab]');
  if (ab) { runLeg3(); return; }
  const head = e.target.closest('[data-opt]');
  if (head) {
    head.parentElement.querySelector('.detail').classList.toggle('hidden');
    showOptionOnMap(+head.dataset.opt, head.closest('[data-optholder]'));
  }
});
$('#go-view')?.addEventListener('change', (e) => {
  if (e.target.id === 'abFromAp') { flightLinks(); $('#abLeg1').innerHTML = '<div class="small">查詢中…</div>'; runLeg1(); }
  if (e.target.id === 'abToAp') { flightLinks(); $('#abLeg3').innerHTML = ''; }
  if (e.target.id === 'abDate') flightLinks();
});
$('#goPref')?.addEventListener('change', () => S.goDest && planTrip(S.goDest));
$('#goModes')?.addEventListener('change', () => S.goDest && planTrip(S.goDest));

// ---------- TDX（交通部運輸資料流通服務）：公車即時到站、台鐵／高鐵時刻與票價 ----------
const TDX = 'https://tdx.transportdata.tw/api/basic';
const TDX_CITY = {
  臺北市: 'Taipei', 新北市: 'NewTaipei', 桃園市: 'Taoyuan', 臺中市: 'Taichung', 臺南市: 'Tainan', 高雄市: 'Kaohsiung',
  基隆市: 'Keelung', 新竹市: 'Hsinchu', 新竹縣: 'HsinchuCounty', 苗栗縣: 'MiaoliCounty', 彰化縣: 'ChanghuaCounty',
  南投縣: 'NantouCounty', 雲林縣: 'YunlinCounty', 嘉義縣: 'ChiayiCounty', 嘉義市: 'Chiayi', 屏東縣: 'PingtungCounty',
  宜蘭縣: 'YilanCounty', 花蓮縣: 'HualienCounty', 臺東縣: 'TaitungCounty', 金門縣: 'KinmenCounty', 澎湖縣: 'PenghuCounty', 連江縣: 'LienchiangCounty',
};
const tdxReady = () => !!(S.tdxId && S.tdxSecret);

async function tdxToken() {
  const now = Date.now();
  if (S.tdxTok && S.tdxTokExp > now + 60000) return S.tdxTok;
  const r = await fetch('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: S.tdxId, client_secret: S.tdxSecret }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error_description || 'TDX 金鑰錯誤');
  S.tdxTok = d.access_token;
  S.tdxTokExp = now + (d.expires_in || 3600) * 1000;
  return S.tdxTok;
}

const tdxCache = new Map();
// 一次只送一個請求、間隔 300 毫秒，避免超過 TDX 的頻率限制
let tdxChain = Promise.resolve();
function tdxQueue(job) {
  const run = tdxChain.then(job);
  tdxChain = run.catch(() => {}).then(() => new Promise((ok) => setTimeout(ok, 300)));
  return run;
}
async function tdxGet(path, params = {}, ttl = 0) {
  const q = new URLSearchParams({ $format: 'JSON', ...params });
  const url = `${TDX}${path}?${q}`;
  const hit = tdxCache.get(url);
  if (ttl && hit && hit.exp > Date.now()) return hit.data;
  const data = await tdxQueue(async () => {
    for (let tries = 0; ; tries++) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${await tdxToken()}` } });
      // 免費方案每秒只能查幾次：被擋（429）就等一下再試
      if (r.status === 429 && tries < 4) { await new Promise((ok) => setTimeout(ok, 1200 * (tries + 1))); continue; }
      if (!r.ok) throw new Error(`TDX ${r.status}`);
      return r.json();
    }
  });
  if (ttl) tdxCache.set(url, { data, exp: Date.now() + ttl });
  return data;
}
const odataStr = (s) => String(s).replace(/'/g, "''");
const normStop = (s) => String(s || '').replace(/[\s（）()]/g, '').replace(/台/g, '臺').replace(/(火車站|車站|站)$/, '');

const cityCache = new Map();
async function cityCodeAt(loc) {
  const k = `${loc.lat.toFixed(3)},${loc.lng.toFixed(3)}`;
  if (cityCache.has(k)) return cityCache.get(k);
  let code = null;
  try {
    const { Geocoder } = await google.maps.importLibrary('geocoding');
    const { results } = await new Geocoder().geocode({ location: loc, language: 'zh-TW' });
    const name = results.flatMap((r) => r.address_components).find((c) => c.types.includes('administrative_area_level_1'))?.long_name;
    code = TDX_CITY[String(name || '').replace(/台/g, '臺')] || null;
  } catch (e) { console.warn('city', e); }
  cityCache.set(k, code);
  return code;
}

// Google 叫「69A」、TDX 叫「69A小港幹線」：取路線號碼開頭（69A、紅3、橘12…）當搜尋條件，再用站牌座標確認
function routeCandidates(g) {
  const c = [];
  for (const n of [g.line, g.lineName]) {
    const t = String(n || '').trim();
    if (!t) continue;
    const code = t.match(/^[一-鿿]?[A-Za-z]*\d+[A-Za-z]?/)?.[0];
    if (code) c.push(code);
    c.push(t);
  }
  return [...new Set(c)];
}

// 找出這班公車在 TDX 的路線、方向和上車站（用站牌座標比對最準）
async function findBusStop(g) {
  const city = await cityCodeAt(g.fromLoc);
  const scopes = [];
  if (city) scopes.push(`City/${city}`);
  if (city === 'Taipei') scopes.push('City/NewTaipei');
  if (city === 'NewTaipei') scopes.push('City/Taipei');
  scopes.push('InterCity');
  for (const scope of scopes) {
    for (const name of routeCandidates(g)) {
      let routes;
      try { routes = await tdxGet(`/v2/Bus/StopOfRoute/${scope}`, { $filter: `startswith(RouteName/Zh_tw,'${odataStr(name)}')` }, 3600e3); } catch (e) { if (/401|403/.test(e.message)) throw e; continue; }
      let best = null;
      for (const rt of routes || []) {
        const stops = rt.Stops || [];
        const near = (loc) => {
          let bi = -1, bd = Infinity;
          stops.forEach((s, i) => {
            const d = distM(loc, { lat: s.StopPosition?.PositionLat, lng: s.StopPosition?.PositionLon });
            if (d < bd) { bd = d; bi = i; }
          });
          return { i: bi, d: bd };
        };
        const a = near(g.fromLoc), b = g.toLoc ? near(g.toLoc) : { i: stops.length, d: 0 };
        if (a.i < 0 || a.d > 300 || b.d > 300 || a.i >= b.i) continue;
        const score = a.d + b.d;
        if (!best || score < best.score) best = { score, scope, route: rt, stop: stops[a.i] };
      }
      if (best) return best;
    }
  }
  return null;
}

async function busRealtime(g) {
  const m = await findBusStop(g);
  if (!m) return null;
  const f = `RouteUID eq '${m.route.RouteUID}' and StopUID eq '${m.stop.StopUID}' and Direction eq ${m.route.Direction}`;
  const eta = await tdxGet(`/v2/Bus/EstimatedTimeOfArrival/${m.scope}`, { $filter: f });
  const e = (eta || []).sort((x, y) => (x.EstimateTime ?? 1e9) - (y.EstimateTime ?? 1e9))[0];
  return { stopName: m.stop.StopName?.Zh_tw, eta: e };
}

function busEtaHtml(res) {
  if (!res) return '<span class="small">官方資料找不到這班公車（可能是跨縣市或名稱不同）</span>';
  const e = res.eta;
  const st = e?.StopStatus;
  let msg;
  if (e && e.EstimateTime != null && st === 0) {
    const min = Math.floor(e.EstimateTime / 60);
    msg = min <= 1 ? '<b class="live soon">即將進站</b>' : `<b class="live${min <= 5 ? ' soon' : ''}">還有 ${min} 分鐘進站</b>`;
  } else if (st === 1) {
    msg = `尚未發車${e.NextBusTime ? `，預計 ${hhmm(new Date(e.NextBusTime))} 發車` : ''}`;
  } else if (st === 2) msg = '交管不停靠';
  else if (st === 3) msg = '<b class="live soon">末班車已過</b>';
  else if (st === 4) msg = '今日未營運';
  else msg = '目前沒有到站資訊';
  return `🛰️ 官方即時（${esc(res.stopName || '')}）：${msg}`;
}

// 台鐵／高鐵：用站名找站代碼
async function railStations(kind) {
  if (kind === 'THSR') return (await tdxGet('/v2/Rail/THSR/Station', {}, 864e5)).map((s) => ({ id: s.StationID, name: s.StationName?.Zh_tw }));
  const d = await tdxGet('/v3/Rail/TRA/Station', {}, 864e5);
  return (d.Stations || d).map((s) => ({ id: s.StationID, name: s.StationName?.Zh_tw }));
}
async function railStationId(kind, name) {
  const n = normStop(String(name).replace(/^(高鐵|臺鐵|台鐵)/, ''));
  const list = await railStations(kind);
  return (list.find((s) => normStop(s.name) === n) || list.find((s) => n.includes(normStop(s.name)) || normStop(s.name).includes(n)))?.id || null;
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm2date = (t, base) => { const [h, m] = String(t).split(':').map(Number); const d = new Date(base); d.setHours(h, m, 0, 0); return d; };

function collectPrices(x, out = []) {
  if (Array.isArray(x)) x.forEach((v) => collectPrices(v, out));
  else if (x && typeof x === 'object') {
    if (typeof x.Price === 'number' && x.Price > 0) out.push(x.Price);
    Object.values(x).forEach((v) => collectPrices(v, out));
  }
  return out;
}

async function railInfo(kind, g) {
  const [o, d] = await Promise.all([railStationId(kind, g.from), railStationId(kind, g.to)]);
  if (!o || !d) return null;
  const when = g.dep || new Date();
  const date = ymd(when);
  let trains = [];
  if (kind === 'THSR') {
    const tt = await tdxGet(`/v2/Rail/THSR/DailyTimetable/OD/${o}/to/${d}/${date}`, {}, 600e3);
    trains = (tt || []).map((t) => ({ no: t.DailyTrainInfo?.TrainNo, type: '高鐵', dep: hm2date(t.OriginStopTime?.DepartureTime, when), arr: hm2date(t.DestinationStopTime?.ArrivalTime, when) }));
  } else {
    const tt = await tdxGet(`/v3/Rail/TRA/DailyTrainTimetable/OD/${o}/to/${d}/${date}`, {}, 600e3);
    trains = (tt.TrainTimetables || []).map((t) => {
      const st = t.StopTimes || [];
      const a = st.find((s) => s.StationID === o), b = st.find((s) => s.StationID === d);
      return { no: t.TrainInfo?.TrainNo, type: t.TrainInfo?.TrainTypeName?.Zh_tw || '', dep: hm2date(a?.DepartureTime, when), arr: hm2date(b?.ArrivalTime, when) };
    });
  }
  const now = Date.now();
  trains = trains.filter((t) => t.dep.getTime() >= now - 60000).sort((a, b) => a.dep - b.dep).slice(0, 4);
  let fare = null;
  try {
    const f = await tdxGet(kind === 'THSR' ? `/v2/Rail/THSR/ODFare/${o}/to/${d}` : `/v3/Rail/TRA/ODFare/${o}/to/${d}`, {}, 864e5);
    // 只取成人單程全票（TicketType 1、FareClass 1）
    const rows = (kind === 'THSR' ? (f || []) : (f.ODFares || [])).flatMap((x) => x.Fares || [])
      .filter((x) => x.TicketType === 1 && x.FareClass === 1 && x.Price > 0);
    if (kind === 'THSR') {
      const cab = (c) => rows.find((x) => x.CabinClass === c)?.Price;
      fare = { thsr: [['標準車廂', cab(1)], ['自由座', cab(3)], ['商務車廂', cab(2)]].filter(([, v]) => v) };
    } else {
      // 每個車種取最便宜的單程全票（資料裡還混有定期票等較貴的票價）
      const byType = new Map();
      for (const od of f.ODFares || []) {
        const pr = (od.Fares || []).find((x) => x.TicketType === 1 && x.FareClass === 1 && x.CabinClass === 1)?.Price;
        if (pr && (!byType.has(od.TrainType) || pr < byType.get(od.TrainType))) byType.set(od.TrainType, pr);
      }
      const TRA_TYPE = [[3, '自強號'], [4, '莒光號'], [6, '區間車']];
      const list = TRA_TYPE.filter(([t]) => byType.has(t)).map(([t, n]) => [n, byType.get(t)]);
      if (list.length) fare = { tra: list };
    }
  } catch (e) { console.warn('fare', e); }
  // 台鐵誤點（只查第一班）
  if (kind === 'TRA' && trains[0]) {
    try {
      const lb = await tdxGet(`/v3/Rail/TRA/TrainLiveBoard/TrainNo/${trains[0].no}`);
      const delay = (lb.TrainLiveBoards || [])[0]?.DelayTime;
      if (delay != null) trains[0].delay = delay;
    } catch {}
  }
  return { trains, fare };
}

function railHtml(kind, info) {
  if (!info) return '<span class="small">官方資料找不到這兩個車站</span>';
  let fare = '';
  if (info.fare?.thsr?.length) fare = `💰 官方全票：${info.fare.thsr.map(([n, v]) => `${n} NT$${v}`).join('・')}`;
  else if (info.fare?.tra?.length) fare = `💰 官方全票：${info.fare.tra.map(([n, v]) => `${n} NT$${v}`).join('・')}`;
  const list = info.trains.map((t, k) => `${hhmm(t.dep)} ${esc(t.type)}${t.no ? ` ${esc(t.no)}次` : ''}${k === 0 && t.delay != null ? (t.delay > 0 ? ` <b class="live soon">誤點 ${t.delay} 分</b>` : ' <b class="live">準點</b>') : ''}`).join('、');
  return `🛰️ 官方${kind === 'THSR' ? '高鐵' : '台鐵'}時刻：${list || '今天已無班次'}${fare ? `<br>${fare}` : ''}`;
}

function segKind(g) {
  const a = `${g.agency} ${g.lineName} ${g.vehicle}`;
  if (/高鐵|High Speed/i.test(a) || g.vtype === 'HIGH_SPEED_TRAIN') return 'THSR';
  if (/臺鐵|台鐵|臺灣鐵路|台灣鐵路|Taiwan Railway/i.test(a)) return 'TRA';
  // 台灣的一般鐵路（不是捷運、輕軌）就當作台鐵
  if (S.country === 'TW' && /RAIL|TRAIN/.test(g.vtype) && !/SUBWAY|METRO|LIGHT_RAIL|MONORAIL/.test(g.vtype) && !/捷運|Metro|MRT/i.test(a)) return 'TRA';
  if (/BUS/.test(g.vtype)) return 'BUS';
  return null;
}

// 把官方資料填進每種搭法（只處理台灣、有 TDX 金鑰時）
async function tdxEnrich(opts, root = document) {
  const cells = root.querySelectorAll('[data-tdx]');
  if (!cells.length) return;
  if (!tdxReady()) {
    cells.forEach((c) => { c.innerHTML = '<span class="small">想看官方即時到站？到 ⚙️ 設定填入 TDX 金鑰</span>'; });
    return;
  }
  const jobs = new Map();
  opts.forEach((o, i) => o.segs.forEach((g, j) => {
    if (g.type !== 'transit') return;
    const kind = segKind(g);
    if (!kind) return;
    jobs.set(`${i}-${j}`, { kind, g });
  }));
  root.querySelectorAll('[data-tdx]').forEach((c) => { if (!jobs.has(c.dataset.tdx)) c.remove(); else c.innerHTML = '<span class="small">🛰️ 查詢官方資料…</span>'; });
  const fill = (key, html) => root.querySelectorAll(`[data-tdx="${key}"]`).forEach((c) => { c.innerHTML = html; });
  await Promise.all([...jobs].map(async ([key, { kind, g }]) => {
    try {
      if (kind === 'BUS') fill(key, busEtaHtml(await busRealtime(g)));
      else fill(key, railHtml(kind, await railInfo(kind, g)));
    } catch (e) {
      console.warn('TDX', e);
      fill(key, `<span class="small">官方資料暫時查不到（${esc(e.message)}）</span>`);
    }
  }));
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

// ---------- 搜尋地點：用輸入的地名當作查詢位置 ----------
async function findPlaces(q) {
  if (S.map) {
    const { Place } = await google.maps.importLibrary('places');
    const { places } = await Place.searchByText({
      textQuery: q, fields: ['displayName', 'location', 'formattedAddress'], maxResultCount: 5, language: 'zh-TW',
    });
    return (places || []).map((p) => ({ name: p.displayName, addr: p.formattedAddress, loc: { lat: p.location.lat(), lng: p.location.lng() } }));
  }
  // 沒有金鑰時，改用維基百科條目的座標
  const d = await wikiApi({ action: 'query', generator: 'search', gsrsearch: q, gsrlimit: '8', prop: 'coordinates|description', colimit: 'max' });
  return Object.values(d.query?.pages || {}).filter((p) => p.coordinates)
    .sort((a, b) => a.index - b.index).slice(0, 5)
    .map((p) => ({ name: p.title, addr: p.description || '', loc: { lat: p.coordinates[0].lat, lng: p.coordinates[0].lon } }));
}

function goToPlace(p) {
  $('#placeResults').classList.add('hidden');
  $('#placeQuery').value = p.name;
  $('#placeQuery').blur();
  setOrigin(p.loc, true);
  if (S.map) S.map.setZoom(15);
  switchTab('sights');
  search(`「${p.name}」`);
}

$('#placeSearch')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#placeQuery').value.trim();
  const box = $('#placeResults');
  if (!q) return;
  box.classList.remove('hidden');
  box.innerHTML = '<div class="small" style="padding:10px 14px">搜尋中…</div>';
  try {
    const list = await findPlaces(q);
    if (!list.length) { box.innerHTML = '<div class="small" style="padding:10px 14px">找不到這個地點，換個說法試試看。</div>'; return; }
    if (list.length === 1) { goToPlace(list[0]); return; }
    S.placeHits = list;
    box.innerHTML = list.map((p, i) => `<button type="button" data-hit="${i}">${esc(p.name)}<span class="addr">${esc(p.addr)}</span></button>`).join('');
  } catch (err) {
    console.warn(err);
    box.innerHTML = '<div class="small" style="padding:10px 14px">搜尋失敗，請稍後再試。</div>';
  }
});
$('#placeResults')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-hit]');
  if (b) goToPlace(S.placeHits[+b.dataset.hit]);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#placeSearch')) $('#placeResults')?.classList.add('hidden');
});

$('#btnRefresh').onclick =() => search(S.manual ? '你選的位置' : '你目前的位置');
$('#radius').onchange = () => search(S.manual ? '你選的位置' : '你目前的位置');
$('#btnLocate').onclick = () => {
  if (!S.gps) { setStatus('還沒取得 GPS 定位…'); return; }
  $('#placeQuery').value = '';
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
  if ($('#tdxId')) { $('#tdxId').value = S.tdxId; $('#tdxSecret').value = S.tdxSecret; }
  if ($('#rapidKey')) $('#rapidKey').value = S.rapidKey;
  $('#settings').showModal();
};
$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'save') return;
  const newKey = $('#apiKey').value.trim();
  S.moveThreshold = +$('#moveThreshold').value; save('moveThreshold', S.moveThreshold);
  S.dwellSeconds = +$('#dwellSeconds').value; save('dwellSeconds', S.dwellSeconds);
  S.notify = $('#notify').checked; save('notify', S.notify ? '1' : '0');
  if ($('#rapidKey')) { S.rapidKey = $('#rapidKey').value.trim(); save('rapidKey', S.rapidKey); }
  if ($('#tdxId')) {
    const id = $('#tdxId').value.trim(), sec = $('#tdxSecret').value.trim();
    if (id !== S.tdxId || sec !== S.tdxSecret) { S.tdxId = id; S.tdxSecret = sec; S.tdxTok = null; save('tdxId', id); save('tdxSecret', sec); }
  }
  if (S.notify && 'Notification' in window) Notification.requestPermission();
  if (newKey !== S.key) { save('gmKey', newKey); location.reload(); }
});

// 產生 QR code：手機掃了就會打開這個 App 並自動存好金鑰（金鑰放在 # 後面，不會傳到伺服器）
if ($('#btnPhone')) $('#btnPhone').onclick = async () => {
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
  const h = new URLSearchParams();
  if (key) h.set('key', key);
  if ($('#tdxId')?.value.trim()) { h.set('tid', $('#tdxId').value.trim()); h.set('tsec', $('#tdxSecret').value.trim()); }
  if ($('#rapidKey')?.value.trim()) h.set('rk', $('#rapidKey').value.trim());
  const url = `${location.origin}${location.pathname}${h.toString() ? `#${h}` : ''}`;
  if (!window.qrcode) { box.textContent = url; return; }
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  box.innerHTML = `${qr.createImgTag(4, 0)}<div>用手機相機掃描 → 打開網頁 → 瀏覽器選單「加入主畫面」</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

// ---------- 啟動 ----------
// 畫面（index.html）和程式（app.js）版本不一致時：清掉快取重新載入一次
if (!$('#placeSearch') && !sessionStorage.getItem('healed')) {
  sessionStorage.setItem('healed', '1');
  Promise.all([
    navigator.serviceWorker?.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))),
    window.caches?.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))),
  ]).finally(() => location.reload());
}

(async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('tid')) { S.tdxId = hash.get('tid'); S.tdxSecret = hash.get('tsec') || ''; save('tdxId', S.tdxId); save('tdxSecret', S.tdxSecret); }
  if (hash.get('rk')) { S.rapidKey = hash.get('rk'); save('rapidKey', S.rapidKey); }
  if (hash.get('key') || hash.get('tid') || hash.get('rk')) {
    if (hash.get('key')) { S.key = hash.get('key'); save('gmKey', S.key); }
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
