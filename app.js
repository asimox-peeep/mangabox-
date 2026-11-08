const API = 'https://mangabox-api.lahrechriad9.workers.dev';
const PAGE_SIZE = 24;
const FAVORITES_KEY = 'mangabox-favorites-v1';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const homeStatus = $('homeStatus');
const homeView = $('homeView');
const detailView = $('detailView');
const readerView = $('readerView');
const views = [homeView, detailView, readerView];

const state = {
  mode: 'popular', query: '', offset: 0, page: 1, chapters: [], chapterOffset: 0,
  currentChapterIndex: -1, currentManga: null, favorites: readFavorites(), ratings: new Map(),
  homeController: null, detailController: null, readerController: null,
  listingToken: 0, detailToken: 0, readerToken: 0
};

function readFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    return new Map(Array.isArray(parsed) ? parsed.filter((item) => item && item.id).map((item) => [item.id, item]) : []);
  } catch { return new Map(); }
}

function persistFavorites() {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites.values()]));
    $('favoriteCount').textContent = String(state.favorites.size);
  } catch {
    setStatus(homeStatus, 'تعذر حفظ المفضلة في هذا المتصفح. تحقق من مساحة التخزين المتاحة.', 'error');
  }
}

function setStatus(element, message, kind = '') {
  element.textContent = message;
  element.className = `status${kind ? ` ${kind}` : ''}`;
  element.hidden = !message;
}

function show(view) {
  views.forEach((item) => item.classList.toggle('hidden', item !== view));
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function titleOf(manga) {
  const titles = manga?.attributes?.title || {};
  return titles.ar || titles.en || titles['ja-ro'] || Object.values(titles)[0] || 'بدون عنوان';
}

function coverOf(manga, size = 256) {
  const cover = (manga?.relationships || []).find((item) => item.type === 'cover_art');
  const filename = cover?.attributes?.fileName;
  if (!manga?.id || !filename) return '';
  return `https://uploads.mangadex.org/covers/${encodeURIComponent(manga.id)}/${encodeURIComponent(filename)}.${size}.jpg`;
}

function coverFromSaved(item) { return item.cover || ''; }

// The Worker proxies MangaDex API paths; preserve repeated query parameters such as includes[] and mangaId[].
function makeApiUrl(path, params = {}) {
  const url = new URL(`${API}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, entry));
    else if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

async function requestJson(url, signal) {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        mode: 'cors',
        headers: { Accept: 'application/json' }
      });
      if (response.status === 429 && attempt === 0) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10000) : 1800;
        attempt += 1;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        await wait(delay, signal);
        continue;
      }
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.text()).trim().slice(0, 240); } catch { /* Optional diagnostic response body. */ }
        const error = new Error(`طلب ${new URL(url).pathname} عبر Cloudflare Worker فشل: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
        error.status = response.status;
        throw error;
      }
      try { return await response.json(); }
      catch {
        const error = new Error('استجاب Cloudflare Worker برمز نجاح لكن الرد ليس JSON صالحاً. تحقق من مسار التحويل وإعداد الـWorker.');
        error.status = response.status;
        throw error;
      }
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (controller.signal.aborted) throw new Error('انتهت مهلة الاتصال بـCloudflare Worker بعد 20 ثانية. تحقق من حالة الـWorker واتصاله بـMangaDex.');
      if (error instanceof TypeError) {
        throw new Error(`تعذر الوصول إلى Cloudflare Worker (${API}). تحقق من اتصال الإنترنت، وحالة الـWorker، وإعدادات CORS.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function describeApiError(error, operation) {
  if (error?.status === 429) return `تجاوزت الطلبات الحد المسموح أثناء ${operation} (HTTP 429). انتظر قليلاً ثم أعد المحاولة.`;
  if (error?.status === 404) return `لم يعثر الـWorker على المسار المطلوب أثناء ${operation} (HTTP 404). تحقق من أن هذا المسار مدعوم في Worker proxy. التفاصيل: ${error.message}`;
  if (error?.status >= 500) return `حدث خطأ من الخادم أثناء ${operation} (${error.message}). تحقق من سجلات Cloudflare Worker واتصاله بـMangaDex.`;
  return error?.message || `تعذر ${operation}. تحقق من اتصال Cloudflare Worker ثم أعد المحاولة.`;
}

function showHomeMode(mode) {
  state.mode = mode;
  state.offset = 0;
  state.page = 1;
  state.query = '';
  loadListing();
}

async function loadListing() {
  const token = ++state.listingToken;
  state.homeController?.abort();
  state.homeController = new AbortController();
  const { signal } = state.homeController;
  show(homeView);
  grid.replaceChildren();
  $('pagination').hidden = true;
  $('retryBtn').hidden = true;
  if (state.mode === 'favorites') {
    $('sectionTitle').textContent = 'مانغاتي المفضلة';
    const saved = [...state.favorites.values()];
    if (!saved.length) {
      setStatus(homeStatus, 'لم تضف أي مانغا إلى المفضلة بعد. اضغط رمز القلب على أي بطاقة لحفظها.', 'empty');
      return;
    }
    setStatus(homeStatus, '');
    renderCards(saved, true);
    return;
  }

  const searching = state.mode === 'search';
  $('sectionTitle').textContent = searching ? `نتائج البحث: ${state.query}` : 'الأكثر شعبية';
  setStatus(homeStatus, searching ? 'جارٍ البحث في MangaDex...' : 'جارٍ تحميل المانغا الأكثر شعبية...');
  const params = {
    limit: PAGE_SIZE, offset: state.offset,
    'includes[]': ['cover_art'],
    'contentRating[]': ['safe', 'suggestive']
  };
  if (searching) params.title = state.query;
  else {
    params['availableTranslatedLanguage[]'] = ['ar'];
    params['order[followedCount]'] = 'desc';
  }

  try {
    const result = await requestJson(makeApiUrl('/manga', params), signal);
    if (token !== state.listingToken) return;
    const items = result.data || [];
    if (!items.length) {
      setStatus(homeStatus, searching ? 'لم يتم العثور على نتائج مطابقة. جرّب اسماً آخر.' : 'لا توجد نتائج متاحة حالياً.', 'empty');
      return;
    }
    setStatus(homeStatus, '');
    renderCards(items, false);
    const total = Number(result.total) || 0;
    $('pagination').hidden = total <= PAGE_SIZE;
    $('prevPage').disabled = state.offset <= 0;
    $('nextPage').disabled = state.offset + PAGE_SIZE >= total;
    $('pageLabel').textContent = `الصفحة ${state.page}`;
    loadRatings(items, token);
  } catch (error) {
    if (error.name === 'AbortError' || token !== state.listingToken) return;
    setStatus(homeStatus, describeApiError(error, searching ? 'البحث عن المانغا' : 'تحميل قائمة المانغا'), 'error');
    $('retryBtn').hidden = false;
  }
}

function renderCards(items, savedItems) {
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', `عرض معلومات ${titleOf(item)}`);

    const coverWrap = document.createElement('div');
    coverWrap.className = 'cover-wrap';
    const img = document.createElement('img');
    img.className = 'cover';
    img.loading = 'lazy';
    img.alt = `غلاف ${titleOf(item)}`;
    img.src = savedItems ? coverFromSaved(item) : coverOf(item);
    const placeholder = document.createElement('span');
    placeholder.className = 'cover-placeholder';
    placeholder.textContent = 'لا يتوفر غلاف';
    placeholder.hidden = Boolean(img.src);
    img.addEventListener('error', () => {
      img.hidden = true;
      placeholder.hidden = false;
    }, { once: true });
    if (!img.src) img.hidden = true;
    coverWrap.append(img, placeholder);

    const body = document.createElement('div');
    body.className = 'cardbody';
    const title = document.createElement('h3');
    title.className = 'title';
    title.textContent = titleOf(item);
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const rating = document.createElement('span');
    rating.className = 'rating';
    rating.dataset.ratingId = item.id;
    rating.textContent = formatRating(state.ratings.get(item.id));
    const status = document.createElement('span');
    status.className = 'sub';
    status.textContent = item.attributes?.status || 'الحالة غير محددة';
    meta.append(rating, status);
    body.append(title, meta);

    const favorite = document.createElement('button');
    favorite.type = 'button';
    favorite.className = 'favorite-toggle';
    favorite.textContent = state.favorites.has(item.id) ? '♥' : '♡';
    favorite.setAttribute('aria-label', state.favorites.has(item.id) ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة');
    favorite.setAttribute('aria-pressed', String(state.favorites.has(item.id)));
    favorite.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFavorite(item, savedItems);
    });
    card.append(coverWrap, body, favorite);
    card.addEventListener('click', () => openManga(item.id));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openManga(item.id);
      }
    });
    fragment.append(card);
  });
  grid.replaceChildren(fragment);
}

function formatRating(value) {
  return Number.isFinite(value) && value > 0 ? `★ ${value.toFixed(1)}/10` : '★ لا يوجد تقييم';
}

async function loadRatings(items, token) {
  const missing = items.filter((item) => !state.ratings.has(item.id)).map((item) => item.id);
  if (!missing.length) {
    updateRatingLabels(items);
    return;
  }
  try {
    const result = await requestJson(makeApiUrl('/statistics/manga', { 'mangaId[]': missing }), state.homeController?.signal);
    Object.entries(result.statistics || {}).forEach(([id, stats]) => {
      const rating = Number(stats?.rating?.average);
      state.ratings.set(id, Number.isFinite(rating) ? rating : null);
    });
  } catch {
    missing.forEach((id) => { if (!state.ratings.has(id)) state.ratings.set(id, null); });
  }
  if (token === state.listingToken) updateRatingLabels(items);
}

function updateRatingLabels(items) {
  items.forEach((item) => {
    const label = grid.querySelector(`[data-rating-id="${CSS.escape(item.id)}"]`);
    if (label) label.textContent = formatRating(state.ratings.get(item.id));
  });
}

function toggleFavorite(manga, savedItems) {
  if (state.favorites.has(manga.id)) state.favorites.delete(manga.id);
  else {
    state.favorites.set(manga.id, {
      id: manga.id,
      attributes: { title: manga.attributes?.title || {}, status: manga.attributes?.status || '' },
      cover: savedItems ? coverFromSaved(manga) : coverOf(manga)
    });
  }
  persistFavorites();
  if (state.mode === 'favorites') loadListing();
  else {
    const card = [...grid.querySelectorAll('.card')].find((item) => item.getAttribute('aria-label') === `عرض معلومات ${titleOf(manga)}`);
    if (card) {
      const button = card.querySelector('.favorite-toggle');
      const isFavorite = state.favorites.has(manga.id);
      button.textContent = isFavorite ? '♥' : '♡';
      button.setAttribute('aria-label', isFavorite ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة');
      button.setAttribute('aria-pressed', String(isFavorite));
    }
  }
}

async function searchManga(query) {
  state.mode = 'search';
  state.query = query.trim();
  state.offset = 0;
  state.page = 1;
  loadListing();
}

async function openManga(id) {
  state.detailController?.abort();
  state.detailController = new AbortController();
  const token = ++state.detailToken;
  const { signal } = state.detailController;
  state.currentManga = null;
  state.chapters = [];
  state.chapterOffset = 0;
  show(detailView);
  $('detailContent').replaceChildren();
  $('chapterList').replaceChildren();
  $('moreChaptersBtn').hidden = true;
  setStatus($('chapterStatus'), 'جارٍ تحميل معلومات المانغا والفصول العربية...');
  const loading = document.createElement('p');
  loading.className = 'status';
  loading.textContent = 'جارٍ تحميل التفاصيل...';
  $('detailContent').append(loading);
  try {
    const result = await requestJson(makeApiUrl(`/manga/${encodeURIComponent(id)}`, {
      'includes[]': ['cover_art', 'author', 'artist']
    }), signal);
    if (token !== state.detailToken) return;
    const manga = result.data;
    if (!manga) throw new Error('لم يتم العثور على المانغا في رد MangaDex.');
    state.currentManga = manga;
    renderDetails(manga);
    await Promise.all([loadMangaRating(manga.id, signal), loadChapters(manga.id, token, signal)]);
  } catch (error) {
    if (error.name === 'AbortError' || token !== state.detailToken) return;
    $('detailContent').textContent = describeApiError(error, 'تحميل تفاصيل المانغا');
    setStatus($('chapterStatus'), describeApiError(error, 'تحميل الفصول العربية'), 'error');
  }
}

function renderDetails(manga) {
  const attributes = manga.attributes || {};
  const description = attributes.description?.ar || attributes.description?.en || Object.values(attributes.description || {})[0] || 'لا يوجد وصف متاح.';
  const wrapper = document.createElement('div');
  wrapper.className = 'detail';
  const img = document.createElement('img');
  img.className = 'detail-cover';
  img.alt = `غلاف ${titleOf(manga)}`;
  img.src = coverOf(manga, 512);
  img.addEventListener('error', () => {
    img.replaceWith(Object.assign(document.createElement('div'), { className: 'detail-cover-placeholder', textContent: 'لا يتوفر غلاف' }));
  }, { once: true });
  const text = document.createElement('div');
  const heading = document.createElement('h2');
  heading.id = 'detailHeading';
  heading.textContent = titleOf(manga);
  const metadata = document.createElement('p');
  metadata.className = 'sub';
  metadata.textContent = `الحالة: ${attributes.status || 'غير محددة'} · السنة: ${attributes.year || 'غير محددة'}`;
  const rating = document.createElement('p');
  rating.className = 'detail-rating';
  rating.id = 'detailRating';
  rating.textContent = formatRating(state.ratings.get(manga.id));
  const descriptionHeading = document.createElement('h3');
  descriptionHeading.textContent = 'نبذة';
  const descriptionText = document.createElement('p');
  descriptionText.className = 'description';
  descriptionText.textContent = description;
  const favorite = document.createElement('button');
  favorite.type = 'button';
  favorite.className = 'secondary detail-favorite';
  const updateFavoriteButton = () => {
    favorite.textContent = state.favorites.has(manga.id) ? '♥ إزالة من المفضلة' : '♡ أضف إلى المفضلة';
    favorite.setAttribute('aria-pressed', String(state.favorites.has(manga.id)));
  };
  updateFavoriteButton();
  favorite.addEventListener('click', () => {
    toggleFavorite(manga, false);
    updateFavoriteButton();
  });
  text.append(heading, metadata, rating, descriptionHeading, descriptionText, favorite);
  wrapper.append(img, text);
  $('detailContent').replaceChildren(wrapper);
}

async function loadMangaRating(id, signal) {
  try {
    const result = await requestJson(makeApiUrl('/statistics/manga', { 'mangaId[]': id }), signal);
    const average = Number(result.statistics?.[id]?.rating?.average);
    state.ratings.set(id, Number.isFinite(average) ? average : null);
    const label = $('detailRating');
    if (label && state.currentManga?.id === id) label.textContent = formatRating(state.ratings.get(id));
  } catch {
    // Ratings are optional; manga details and chapters remain usable if statistics are unavailable.
  }
}

async function loadChapters(id, token, signal, append = false) {
  if (!append) {
    state.chapters = [];
    state.chapterOffset = 0;
    $('chapterList').replaceChildren();
  }
  setStatus($('chapterStatus'), 'جارٍ تحميل الفصول العربية...');
  $('moreChaptersBtn').disabled = true;
  try {
    const result = await requestJson(makeApiUrl(`/manga/${encodeURIComponent(id)}/feed`, {
      limit: 100,
      offset: state.chapterOffset,
      'translatedLanguage[]': ['ar'],
      'order[chapter]': 'asc',
      'order[volume]': 'asc',
      'contentRating[]': ['safe', 'suggestive'],
      'includes[]': ['scanlation_group']
    }), signal);
    if (token !== state.detailToken) return;
    const items = result.data || [];
    state.chapters = append ? state.chapters.concat(items) : items;
    state.chapterOffset += items.length;
    renderChapters(append ? items : state.chapters);
    setStatus($('chapterStatus'), state.chapters.length
      ? `عدد الفصول العربية: ${state.chapters.length}`
      : 'لا توجد فصول مترجمة للعربية. قد تتوفر لاحقاً على MangaDex.', state.chapters.length ? '' : 'empty');
    $('moreChaptersBtn').hidden = items.length < 100;
  } catch (error) {
    if (error.name === 'AbortError' || token !== state.detailToken) return;
    setStatus($('chapterStatus'), describeApiError(error, 'تحميل الفصول العربية'), 'error');
  } finally {
    $('moreChaptersBtn').disabled = false;
  }
}

function renderChapters(items) {
  const fragment = document.createDocumentFragment();
  items.forEach((chapter) => {
    const button = document.createElement('button');
    button.className = 'chapter secondary';
    button.type = 'button';
    const number = chapter.attributes?.chapter || '?';
    const label = document.createElement('span');
    label.textContent = `الفصل ${number}${chapter.attributes?.title ? ` — ${chapter.attributes.title}` : ''}`;
    const language = document.createElement('small');
    language.textContent = chapter.attributes?.translatedLanguage || 'ar';
    button.append(label, language);
    button.addEventListener('click', () => openChapter(state.chapters.findIndex((item) => item.id === chapter.id)));
    fragment.append(button);
  });
  if (!items.length && !state.chapters.length) $('chapterList').replaceChildren();
  else $('chapterList').append(fragment);
}

async function openChapter(index) {
  if (index < 0 || index >= state.chapters.length) return;
  state.readerController?.abort();
  state.readerController = new AbortController();
  const token = ++state.readerToken;
  const { signal } = state.readerController;
  state.currentChapterIndex = index;
  const chapter = state.chapters[index];
  show(readerView);
  $('readerPages').replaceChildren();
  $('readerTitle').textContent = `الفصل ${chapter.attributes?.chapter || '?'}`;
  $('prevChapter').disabled = index <= 0;
  $('nextChapter').disabled = index >= state.chapters.length - 1;
  setStatus($('readerStatus'), 'جارٍ تحميل صفحات الفصل...');
  try {
    const result = await requestJson(makeApiUrl(`/at-home/server/${encodeURIComponent(chapter.id)}`), signal);
    if (token !== state.readerToken) return;
    const chapterData = result.chapter;
    const useSaver = Array.isArray(chapterData?.dataSaver) && chapterData.dataSaver.length > 0;
    const pages = useSaver ? chapterData.dataSaver : chapterData?.data;
    if (!result.baseUrl || !chapterData?.hash || !Array.isArray(pages) || !pages.length) throw new Error('لا توجد صفحات متاحة لهذا الفصل في رد MangaDex.');
    const folder = useSaver ? 'data-saver' : 'data';
    const fragment = document.createDocumentFragment();
    pages.forEach((filename, pageIndex) => {
      const image = document.createElement('img');
      image.loading = pageIndex < 2 ? 'eager' : 'lazy';
      image.decoding = 'async';
      image.alt = `صفحة ${pageIndex + 1} من الفصل ${chapter.attributes?.chapter || '?'}`;
      // MangaDex at-home returns the image CDN base URL; page files are served directly from that CDN.
      image.src = `${result.baseUrl}/${folder}/${encodeURIComponent(chapterData.hash)}/${encodeURIComponent(filename)}`;
      image.addEventListener('error', () => {
        const note = document.createElement('p');
        note.className = 'page-error';
        note.textContent = `تعذر تحميل الصفحة ${pageIndex + 1}. قد تكون غير متاحة من MangaDex.`;
        image.replaceWith(note);
      }, { once: true });
      fragment.append(image);
    });
    $('readerPages').replaceChildren(fragment);
    setStatus($('readerStatus'), `${pages.length} صفحة`);
    $('readerStatus').classList.add('reader-count');
  } catch (error) {
    if (error.name === 'AbortError' || token !== state.readerToken) return;
    setStatus($('readerStatus'), describeApiError(error, 'تحميل صفحات الفصل'), 'error');
  }
}

$('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('searchInput').value.trim();
  if (query) searchManga(query);
});
$('homeBtn').addEventListener('click', () => showHomeMode('popular'));
$('popularBtn').addEventListener('click', () => showHomeMode('popular'));
$('favoritesBtn').addEventListener('click', () => {
  state.mode = 'favorites';
  state.offset = 0;
  state.page = 1;
  loadListing();
});
$('retryBtn').addEventListener('click', loadListing);
$('prevPage').addEventListener('click', () => {
  if (state.offset <= 0) return;
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  state.page -= 1;
  loadListing();
});
$('nextPage').addEventListener('click', () => {
  state.offset += PAGE_SIZE;
  state.page += 1;
  loadListing();
});
$('backBtn').addEventListener('click', () => show(homeView));
$('readerBack').addEventListener('click', () => show(detailView));
$('readerTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
$('prevChapter').addEventListener('click', () => openChapter(state.currentChapterIndex - 1));
$('nextChapter').addEventListener('click', () => openChapter(state.currentChapterIndex + 1));
$('moreChaptersBtn').addEventListener('click', () => {
  if (state.currentManga) loadChapters(state.currentManga.id, state.detailToken, state.detailController.signal, true);
});

persistFavorites();
loadListing();
