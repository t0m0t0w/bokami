(() => {
  'use strict';

  const EPUB_ALLOWED_TAGS = [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'div', 'span', 'blockquote', 'pre', 'code', 'em', 'strong', 'i', 'b', 'u', 's',
    'sub', 'sup', 'small', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    'figure', 'figcaption', 'img', 'a', 'section', 'article', 'aside',
    'header', 'footer', 'nav', 'ruby', 'rt', 'rp'
  ];
  const EPUB_ALLOWED_TAG_SET = new Set(EPUB_ALLOWED_TAGS);
  const EPUB_ALLOWED_ATTRS = ['src', 'alt', 'href', 'data-epub-href', 'title', 'colspan', 'rowspan', 'rel', 'target'];

  const state = {
    isAdmin: false,

    // Profiles
    profiles: [],
    activeProfileId: localStorage.getItem('bokami_profile_id') || null,
    activeProfile: null,
    manageProfilesMode: false,
    editingProfileId: null,
    draftProfileAvatar: '',
    draftProfileColor: '#00A3FF',
    pendingAdminAction: null,

    // Library
    books: [],
    filteredBooks: [],
    adminOverview: null,
    activeAdminTab: 'books',
    preferences: {
      shelfView: 'grid',
      gridCoverMode: 'c1',
      readerMode: 'auto',
      fitMode: 'height'
    },
    filter: 'all',
    searchQuery: '',

    // Rygg carousel state
    carouselIndex: 0,
    carouselCoverMode: 'c1',

    // Reader state
    activeBook: null,
    currentPageIndex: 0,
    effectiveReaderMode: 'spread',
    barsHidden: false,
    drawerTab: 'chapters',

    // Zoom & Pan state
    zoomScale: 1,
    panX: 0,
    panY: 0,
    isDraggingPan: false,
    dragStartX: 0,
    dragStartY: 0,
    dragMoved: false
  };

  const preloadedUrls = new Set();
  let saveProgressTimer = null;
  let verticalObserver = null;
  let activePdfDoc = null;
  const pdfPageRenderCache = new Map();

  function waitForPdfJs(timeoutMs = 8000) {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('bokami:pdfjs-ready', finish);
        resolve(window.pdfjsLib || null);
      };
      window.addEventListener('bokami:pdfjs-ready', finish, { once: true });
      setTimeout(finish, timeoutMs);
    });
  }

  // DOM Elements
  const el = {
    ambientBackdrop: document.getElementById('ambient-backdrop'),
    ambientBackdropImg: document.getElementById('ambient-backdrop-img'),

    // Password Screen
    passwordScreen: document.getElementById('password-screen'),
    passwordInput: document.getElementById('password-input'),
    btnPasswordSubmit: document.getElementById('btn-password-submit'),
    passwordError: document.getElementById('password-error'),

    // Profile Screen
    profileScreen: document.getElementById('profile-screen'),
    profilesGrid: document.getElementById('profiles-grid'),
    btnManageProfiles: document.getElementById('btn-manage-profiles'),
    btnProfileAdminUnlock: document.getElementById('btn-profile-admin-unlock'),
    btnLogoutProfileScreen: document.getElementById('btn-logout-profile-screen'),

    // Admin Login Modal
    adminLoginModal: document.getElementById('admin-login-modal'),
    adminLoginTitle: document.getElementById('admin-login-title'),
    adminLoginDesc: document.getElementById('admin-login-desc'),
    inputAdminPassword: document.getElementById('input-admin-password'),
    adminLoginError: document.getElementById('admin-login-error'),
    btnCloseAdminLogin: document.getElementById('btn-close-admin-login'),
    btnCancelAdminLogin: document.getElementById('btn-cancel-admin-login'),
    btnSubmitAdminLogin: document.getElementById('btn-submit-admin-login'),

    // Profile Modal
    profileModal: document.getElementById('profile-modal'),
    profileModalTitle: document.getElementById('profile-modal-title'),
    btnCloseProfileModal: document.getElementById('btn-close-profile-modal'),
    avatarPreviewBox: document.getElementById('avatar-preview-box'),
    avatarPreviewInitials: document.getElementById('avatar-preview-initials'),
    avatarPreviewImg: document.getElementById('avatar-preview-img'),
    inputProfileAvatar: document.getElementById('input-profile-avatar'),
    btnClearAvatar: document.getElementById('btn-clear-avatar'),
    inputProfileName: document.getElementById('input-profile-name'),
    profileColorSwatches: document.getElementById('profile-color-swatches'),
    btnDeleteProfile: document.getElementById('btn-delete-profile'),
    btnCancelProfile: document.getElementById('btn-cancel-profile'),
    btnSaveProfile: document.getElementById('btn-save-profile'),

    // Shelf Screen
    shelfScreen: document.getElementById('shelf-screen'),
    readerScreen: document.getElementById('reader-screen'),
    bookCountBadge: document.getElementById('book-count-badge'),
    searchInput: document.getElementById('search-input'),
    btnViewGrid: document.getElementById('btn-view-grid'),
    btnViewSpine: document.getElementById('btn-view-spine'),
    gridCoverSelector: document.getElementById('grid-cover-selector'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnSettings: document.getElementById('btn-settings'),
    btnSwitchProfile: document.getElementById('btn-switch-profile'),
    currentProfileAvatar: document.getElementById('current-profile-avatar'),
    currentProfileName: document.getElementById('current-profile-name'),
    btnEmptySettings: document.getElementById('btn-empty-settings'),
    subbarStatus: document.getElementById('subbar-status'),
    gridViewContainer: document.getElementById('grid-view-container'),
    booksGrid: document.getElementById('books-grid'),
    spineViewContainer: document.getElementById('spine-view-container'),
    spineStage: document.getElementById('spine-stage'),
    spineTrack: document.getElementById('spine-track'),
    carouselPrev: document.getElementById('carousel-prev'),
    carouselNext: document.getElementById('carousel-next'),
    carouselBookTitle: document.getElementById('carousel-book-title'),
    carouselBookMeta: document.getElementById('carousel-book-meta'),
    carouselOpenBtn: document.getElementById('carousel-open-btn'),
    carouselBookmarksBtn: document.getElementById('carousel-bookmarks-btn'),
    carouselSizeControl: document.getElementById('carousel-size-control'),
    btnScaleDown: document.getElementById('btn-scale-down'),
    btnScaleUp: document.getElementById('btn-scale-up'),
    carouselScaleLabel: document.getElementById('carousel-scale-label'),
    emptyState: document.getElementById('empty-state'),
    emptyStateDesc: document.getElementById('empty-state-desc'),

    // Reader elements
    readerTopbar: document.getElementById('reader-topbar'),
    readerBottombar: document.getElementById('reader-bottombar'),
    btnBackShelf: document.getElementById('btn-back-shelf'),
    readerBookTitle: document.getElementById('reader-book-title'),
    readerChapterBadge: document.getElementById('reader-chapter-badge'),
    btnOpenExport: document.getElementById('btn-open-export'),
    btnViewOptions: document.getElementById('btn-view-options'),
    viewOptionsPopover: document.getElementById('view-options-popover'),
    popoverSpreadSection: document.getElementById('popover-spread-section'),
    popoverScaleSection: document.getElementById('popover-scale-section'),
    btnSpreadOffset: document.getElementById('btn-spread-offset'),
    btnReaderScaleDown: document.getElementById('btn-reader-scale-down'),
    btnReaderScaleUp: document.getElementById('btn-reader-scale-up'),
    readerScaleLabel: document.getElementById('reader-scale-label'),
    btnZoomReset: document.getElementById('btn-zoom-reset'),
    btnBookmarkToggle: document.getElementById('btn-bookmark-toggle'),
    btnBookmarksDrawer: document.getElementById('btn-bookmarks-drawer'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    readerViewport: document.getElementById('reader-viewport'),
    readerStage: document.getElementById('reader-stage'),
    zoomPanLayer: document.getElementById('zoom-pan-layer'),
    spreadContainer: document.getElementById('spread-container'),
    zonePrev: document.getElementById('zone-prev'),
    zoneNext: document.getElementById('zone-next'),
    readerVertical: document.getElementById('reader-vertical'),
    bookmarksDrawer: document.getElementById('bookmarks-drawer'),
    btnCloseDrawer: document.getElementById('btn-close-drawer'),
    tabBtnChapters: document.getElementById('tab-btn-chapters'),
    tabBtnBookmarks: document.getElementById('tab-btn-bookmarks'),
    drawerPaneChapters: document.getElementById('drawer-pane-chapters'),
    drawerPaneBookmarks: document.getElementById('drawer-pane-bookmarks'),
    chapterAddForm: document.getElementById('chapter-add-form'),
    chapterTitleInput: document.getElementById('chapter-title-input'),
    btnSaveChapter: document.getElementById('btn-save-chapter'),
    chaptersList: document.getElementById('chapters-list'),
    bookmarkNoteInput: document.getElementById('bookmark-note-input'),
    btnSaveBookmarkNote: document.getElementById('btn-save-bookmark-note'),
    personalBookmarkSubnote: document.getElementById('personal-bookmark-subnote'),
    bookmarksList: document.getElementById('bookmarks-list'),
    btnPrevPage: document.getElementById('btn-prev-page'),
    btnNextPage: document.getElementById('btn-next-page'),
    pageScrubber: document.getElementById('page-scrubber'),
    scrubberVisualFill: document.getElementById('scrubber-visual-fill'),
    scrubberBookmarks: document.getElementById('scrubber-bookmarks'),
    scrubberCurrentLabel: document.getElementById('scrubber-current-label'),

    // Export Modal
    exportModal: document.getElementById('export-modal'),
    btnCloseExport: document.getElementById('btn-close-export'),
    exportFromInput: document.getElementById('export-from-input'),
    exportToInput: document.getElementById('export-to-input'),
    btnPresetCurrent: document.getElementById('btn-preset-current'),
    btnPresetChapter: document.getElementById('btn-preset-chapter'),
    btnPresetAll: document.getElementById('btn-preset-all'),
    exportSummaryText: document.getElementById('export-summary-text'),
    btnExportZip: document.getElementById('btn-export-zip'),
    btnExportPdf: document.getElementById('btn-export-pdf'),

    // Settings / Admin Modal
    settingsModal: document.getElementById('settings-modal'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    settingsUserView: document.getElementById('settings-user-view'),
    settingsAdminView: document.getElementById('settings-admin-view'),
    btnSettingsAdminUnlock: document.getElementById('btn-settings-admin-unlock'),
    btnSettingsUserLogout: document.getElementById('btn-settings-user-logout'),
    inputUploadEbook: document.getElementById('input-upload-ebook'),
    ebookUploadStatus: document.getElementById('ebook-upload-status'),
    adminBooksList: document.getElementById('admin-books-list'),
    adminUsersList: document.getElementById('admin-users-list'),
    inputNewReaderPassword: document.getElementById('input-new-reader-password'),
    inputNewGlobalAdminPassword: document.getElementById('input-new-global-admin-password'),
    readerPwdEnvNote: document.getElementById('reader-pwd-env-note'),
    adminPwdEnvNote: document.getElementById('admin-pwd-env-note'),
    btnSaveAdminPasswords: document.getElementById('btn-save-admin-passwords'),
    adminPasswordsStatus: document.getElementById('admin-passwords-status'),
    lanUrlsList: document.getElementById('lan-urls-list'),
    btnAdminLock: document.getElementById('btn-admin-lock'),
    btnSettingsAdminLogout: document.getElementById('btn-settings-admin-logout')
  };

  // ======================== SECURITY & SANITIZATION HELPERS ========================
  function isSafeAvatarUrl(val) {
    if (typeof val !== 'string' || !val) return false;
    return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(val);
  }

  function safeHexColor(val) {
    return typeof val === 'string' && /^#[0-9a-fA-F]{6}$/.test(val) ? val : '#00A3FF';
  }

  function isSafeExternalHref(val) {
    if (typeof val !== 'string') return false;
    const trimmed = val.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('#')) return true;
    try {
      const u = new URL(trimmed);
      return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:';
    } catch {
      return false;
    }
  }

  function cloneAllowedEpubNodes(srcNode, dstParent) {
    for (const child of Array.from(srcNode.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        dstParent.appendChild(document.createTextNode(child.textContent || ''));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName.toLowerCase();
      if (!EPUB_ALLOWED_TAG_SET.has(tag)) {
        continue;
      }

      const safeEl = document.createElement(tag);
      if (tag === 'img') {
        const rawSrc = child.getAttribute('src') || '';
        if (rawSrc.startsWith('/epub-resource/')) {
          safeEl.setAttribute('src', rawSrc);
        }
        const rawAlt = child.getAttribute('alt');
        if (rawAlt) safeEl.setAttribute('alt', rawAlt.slice(0, 300));
      } else if (tag === 'a') {
        const rawHref = child.getAttribute('href') || '';
        if (isSafeExternalHref(rawHref)) {
          safeEl.setAttribute('href', rawHref.trim());
          if (rawHref.trim().startsWith('http://') || rawHref.trim().startsWith('https://')) {
            safeEl.setAttribute('rel', 'noopener noreferrer');
            safeEl.setAttribute('target', '_blank');
          }
        }
        const epubHref = child.getAttribute('data-epub-href');
        if (epubHref && !epubHref.includes(':')) {
          safeEl.setAttribute('data-epub-href', epubHref);
        }
        const title = child.getAttribute('title');
        if (title) safeEl.setAttribute('title', title.slice(0, 200));
      } else if (tag === 'td' || tag === 'th') {
        for (const attrName of ['colspan', 'rowspan']) {
          const val = parseInt(child.getAttribute(attrName) || '', 10);
          if (Number.isInteger(val) && val >= 1 && val <= 100) {
            safeEl.setAttribute(attrName, String(val));
          }
        }
      }

      cloneAllowedEpubNodes(child, safeEl);
      dstParent.appendChild(safeEl);
    }
  }

  function safeSetEpubHtml(container, html) {
    const rawHtml = String(html || '');
    if ('setHTML' in Element.prototype) {
      container.setHTML(rawHtml, {
        sanitizer: {
          elements: EPUB_ALLOWED_TAGS,
          attributes: EPUB_ALLOWED_ATTRS
        }
      });
    } else {
      const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
      const frag = document.createDocumentFragment();
      cloneAllowedEpubNodes(doc.body, frag);
      container.replaceChildren(frag);
    }

    container.querySelectorAll('img').forEach((imgEl) => {
      const rawSrc = imgEl.getAttribute('src') || '';
      if (!rawSrc.startsWith('/epub-resource/')) {
        imgEl.remove();
      }
    });

    container.querySelectorAll('a').forEach((aEl) => {
      const rawHref = aEl.getAttribute('href');
      if (rawHref !== null && !isSafeExternalHref(rawHref)) {
        aEl.removeAttribute('href');
      } else if (rawHref && (rawHref.startsWith('http://') || rawHref.startsWith('https://'))) {
        aEl.setAttribute('rel', 'noopener noreferrer');
        aEl.setAttribute('target', '_blank');
      }
    });
  }

  // ======================== API HELPERS ========================
  function requestHeaders() {
    const h = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch'
    };
    if (state.activeProfileId) {
      h['X-Profile-Id'] = state.activeProfileId;
    }
    return h;
  }

  async function parseJsonSafe(res) {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  async function handleHttpError(res, json, url) {
    if (res.status === 401 && url !== '/api/auth/login' && url !== '/api/auth/admin-unlock') {
      showPasswordScreen();
    } else if (res.status === 403 && json && json.requireAdmin) {
      state.isAdmin = false;
      syncAdminControlsVisibility();
    }
    throw new Error((json && json.error) || `HTTP ${res.status}`);
  }

  async function apiGet(url) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: requestHeaders()
    });
    const json = await parseJsonSafe(res);
    if (!res.ok) {
      await handleHttpError(res, json, url);
    }
    return json;
  }

  async function apiPost(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: requestHeaders(),
      body: JSON.stringify(data || {})
    });
    const json = await parseJsonSafe(res);
    if (!res.ok) {
      await handleHttpError(res, json, url);
    }
    return json;
  }

  async function apiPut(url, data) {
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: requestHeaders(),
      body: JSON.stringify(data || {})
    });
    const json = await parseJsonSafe(res);
    if (!res.ok) {
      await handleHttpError(res, json, url);
    }
    return json;
  }

  async function apiDelete(url) {
    const res = await fetch(url, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: requestHeaders()
    });
    const json = await parseJsonSafe(res);
    if (!res.ok) {
      await handleHttpError(res, json, url);
    }
    return json;
  }

  function savePreferences(partial) {
    state.preferences = { ...state.preferences, ...partial };
    apiPost('/api/preferences', partial).catch(() => {});
  }

  function getInitials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return String(name || '?').slice(0, 2).toUpperCase();
  }

  function showScreen(screenName) {
    el.passwordScreen.classList.toggle('active', screenName === 'password');
    el.profileScreen.classList.toggle('active', screenName === 'profile');
    el.shelfScreen.classList.toggle('active', screenName === 'shelf');
    el.readerScreen.classList.toggle('active', screenName === 'reader');
    if (el.ambientBackdrop) {
      el.ambientBackdrop.classList.toggle('is-hidden', screenName === 'reader');
    }
  }

  function syncAdminControlsVisibility() {
    if (el.btnProfileAdminUnlock) {
      el.btnProfileAdminUnlock.textContent = state.isAdmin ? 'Lås admin' : 'Admin-innlogging';
      el.btnProfileAdminUnlock.classList.toggle('active', state.isAdmin);
    }
    if (el.carouselSizeControl) {
      el.carouselSizeControl.classList.toggle('hidden', !state.isAdmin);
    }
    if (el.popoverScaleSection) {
      el.popoverScaleSection.classList.toggle('hidden', !state.isAdmin);
    }
    if (el.popoverSpreadSection) {
      el.popoverSpreadSection.classList.toggle(
        'hidden',
        !state.isAdmin || state.effectiveReaderMode !== 'spread'
      );
    }
    if (el.chapterAddForm) {
      el.chapterAddForm.classList.toggle('hidden', !state.isAdmin);
    }
  }

  async function loadRandomBackdrop() {
    if (!el.ambientBackdropImg) return;
    try {
      const data = await apiGet('/api/random-backdrop');
      if (data && data.url) {
        el.ambientBackdropImg.onload = () => {
          el.ambientBackdropImg.classList.add('is-loaded');
        };
        el.ambientBackdropImg.src = data.url;
      } else {
        el.ambientBackdropImg.removeAttribute('src');
        el.ambientBackdropImg.classList.remove('is-loaded');
      }
    } catch {
      // ignore
    }
  }

  // ======================== 0A) PASSWORD GATE & ADMIN UNLOCK ========================
  async function checkAuthAndBoot() {
    try {
      const res = await fetch('/api/auth/check', {
        credentials: 'same-origin',
        headers: requestHeaders()
      });
      const data = await res.json();
      if (data.authenticated) {
        state.isAdmin = Boolean(data.isAdmin);
        if (data.activeProfileId) {
          state.activeProfileId = data.activeProfileId;
          localStorage.setItem('bokami_profile_id', data.activeProfileId);
        }
        syncAdminControlsVisibility();
        loadProfiles(false);
      } else {
        showPasswordScreen();
      }
    } catch {
      showPasswordScreen();
    }
  }

  function showPasswordScreen() {
    state.isAdmin = false;
    state.activeBook = null;
    syncAdminControlsVisibility();
    el.settingsModal.classList.add('hidden');
    el.adminLoginModal.classList.add('hidden');
    el.profileModal.classList.add('hidden');
    el.exportModal.classList.add('hidden');
    showScreen('password');
    el.passwordError.classList.add('hidden');
    setTimeout(() => el.passwordInput.focus(), 50);
  }

  async function submitPassword() {
    const pwd = el.passwordInput.value;
    try {
      const res = await apiPost('/api/auth/login', { password: pwd });
      if (res.ok) {
        state.isAdmin = Boolean(res.isAdmin);
        el.passwordInput.value = '';
        el.passwordError.classList.add('hidden');
        syncAdminControlsVisibility();
        if (res.matchedProfileId) {
          state.activeProfileId = res.matchedProfileId;
          localStorage.setItem('bokami_profile_id', res.matchedProfileId);
        }
        loadProfiles(false);
      }
    } catch (err) {
      el.passwordError.textContent = err.message || 'Feil passord';
      el.passwordError.classList.remove('hidden');
      el.passwordInput.select();
    }
  }

  async function logoutSession() {
    try {
      await apiPost('/api/auth/logout', {});
    } catch {
      // ignore
    }
    state.isAdmin = false;
    state.activeProfile = null;
    state.activeBook = null;
    state.books = [];
    state.filteredBooks = [];
    showPasswordScreen();
  }

  function openAdminLoginModal(pendingAction = null, title = 'Admin-innlogging', desc = 'Skriv inn admin-passord for å låse opp administrator-tilgang.') {
    state.pendingAdminAction = pendingAction;
    el.adminLoginTitle.textContent = title;
    el.adminLoginDesc.textContent = desc;
    el.inputAdminPassword.value = '';
    el.adminLoginError.classList.add('hidden');
    el.adminLoginModal.classList.remove('hidden');
    setTimeout(() => el.inputAdminPassword.focus(), 40);
  }

  async function submitAdminLogin() {
    const pwd = el.inputAdminPassword.value;
    const action = state.pendingAdminAction;
    const payload = { password: pwd };
    if (action && action.profileId) {
      payload.profileId = action.profileId;
    }

    try {
      const res = await apiPost('/api/auth/admin-unlock', payload);
      state.isAdmin = Boolean(res.isAdmin);
      el.adminLoginModal.classList.add('hidden');
      el.inputAdminPassword.value = '';
      el.adminLoginError.classList.add('hidden');
      state.pendingAdminAction = null;
      syncAdminControlsVisibility();

      if (action && action.type === 'select-profile' && action.profileId) {
        await selectProfile(action.profileId);
        return;
      }
      if (action && action.type === 'manage-profile' && action.profile) {
        await loadProfiles(true);
        openProfileModal(action.profile);
        return;
      }
      if (action && action.type === 'open-settings') {
        await loadProfiles(true, true);
        if (el.shelfScreen.classList.contains('active')) {
          await loadLibrary();
        }
        if (!el.settingsModal.classList.contains('hidden')) {
          await openSettingsModal();
        }
        return;
      }

      await loadProfiles(true);
    } catch (err) {
      el.adminLoginError.textContent = err.message || 'Feil admin-passord';
      el.adminLoginError.classList.remove('hidden');
      el.inputAdminPassword.select();
    }
  }

  async function lockAdminMode() {
    try {
      const res = await apiPost('/api/auth/admin-lock', {});
      state.isAdmin = Boolean(res.isAdmin);
      state.activeProfileId = res.activeProfileId || null;
      if (state.activeProfileId) {
        localStorage.setItem('bokami_profile_id', state.activeProfileId);
      } else {
        localStorage.removeItem('bokami_profile_id');
      }
      syncAdminControlsVisibility();
      el.settingsModal.classList.add('hidden');
      if (!state.activeProfileId) {
        await loadProfiles(true);
      } else if (el.shelfScreen.classList.contains('active')) {
        await loadLibrary();
      } else {
        await loadProfiles(true);
      }
    } catch (err) {
      console.error('Kunne ikke låse admin:', err);
    }
  }

  // ======================== 0B) PROFILES (NETFLIX-STYLE) ========================
  async function loadProfiles(showSelector = false, suppressScreenSwitch = false) {
    try {
      loadRandomBackdrop();
      const data = await apiGet('/api/profiles');
      state.profiles = data.profiles || [];
      state.isAdmin = Boolean(data.isAdmin);
      syncAdminControlsVisibility();

      if (!showSelector && state.activeProfileId) {
        const found = state.profiles.find((p) => p.id === state.activeProfileId);
        if (found && (!found.isAdmin || state.isAdmin)) {
          await selectProfile(found.id);
          return;
        }
      }

      renderProfileSelector();
      if (!suppressScreenSwitch) {
        showScreen('profile');
      }
    } catch (err) {
      console.error('Feil ved lasting av profiler:', err);
    }
  }

  function renderProfileSelector() {
    el.profilesGrid.classList.toggle('manage-mode', state.manageProfilesMode);
    el.btnManageProfiles.textContent = state.manageProfilesMode ? 'Ferdig' : 'Rediger profiler';
    el.btnManageProfiles.classList.toggle('active', state.manageProfilesMode);
    el.profilesGrid.replaceChildren();

    state.profiles.forEach((prof) => {
      const card = document.createElement('div');
      card.className = 'profile-card';

      const tile = document.createElement('div');
      tile.className = 'profile-avatar-tile';

      if (isSafeAvatarUrl(prof.avatar)) {
        const img = document.createElement('img');
        img.src = prof.avatar;
        img.alt = prof.name;
        tile.appendChild(img);
      } else {
        const initSpan = document.createElement('span');
        initSpan.style.color = safeHexColor(prof.color);
        initSpan.textContent = getInitials(prof.name);
        tile.appendChild(initSpan);
      }

      if (prof.isAdmin) {
        const adminBadge = document.createElement('span');
        adminBadge.className = 'profile-admin-badge';
        adminBadge.textContent = 'Admin';
        tile.appendChild(adminBadge);

        if (!state.isAdmin) {
          const lockBadge = document.createElement('span');
          lockBadge.className = 'profile-lock-badge';
          lockBadge.textContent = '🔒';
          lockBadge.title = 'Krever admin-passord';
          tile.appendChild(lockBadge);
        }
      }

      const editOverlay = document.createElement('div');
      editOverlay.className = 'profile-edit-overlay';
      editOverlay.textContent = 'Rediger';
      tile.appendChild(editOverlay);

      const nameEl = document.createElement('div');
      nameEl.className = 'profile-card-name';
      nameEl.textContent = prof.name;

      const metaEl = document.createElement('div');
      metaEl.className = 'profile-card-meta';
      metaEl.textContent = `${prof.bookmarkTotal || 0} bokmerker`;

      card.append(tile, nameEl, metaEl);

      card.addEventListener('click', () => {
        if (state.manageProfilesMode) {
          if (prof.isAdmin && !state.isAdmin) {
            openAdminLoginModal(
              { type: 'manage-profile', profileId: prof.id, profile: prof },
              `Lås opp ${prof.name}`,
              'Denne profilen er administrator. Skriv inn admin-passord for å redigere den.'
            );
          } else {
            openProfileModal(prof);
          }
        } else if (prof.isAdmin && !state.isAdmin) {
          openAdminLoginModal(
            { type: 'select-profile', profileId: prof.id },
            `Admin: ${prof.name}`,
            `Skriv inn admin-passord for å bruke admin-profilen ${prof.name}.`
          );
        } else {
          selectProfile(prof.id);
        }
      });

      el.profilesGrid.appendChild(card);
    });

    // "+ Ny bruker" card
    const addCard = document.createElement('div');
    addCard.className = 'profile-card add-profile-card';

    const addTile = document.createElement('div');
    addTile.className = 'profile-avatar-tile';
    addTile.textContent = '+';

    const addName = document.createElement('div');
    addName.className = 'profile-card-name';
    addName.textContent = 'Ny bruker';

    const addMeta = document.createElement('div');
    addMeta.className = 'profile-card-meta';
    addMeta.textContent = 'Lag profil';

    addCard.append(addTile, addName, addMeta);
    addCard.addEventListener('click', () => openProfileModal(null));
    el.profilesGrid.appendChild(addCard);
  }

  async function selectProfile(profileId) {
    try {
      await apiPost('/api/session/profile', { profileId });
      state.activeProfileId = profileId;
      localStorage.setItem('bokami_profile_id', profileId);
      state.manageProfilesMode = false;
      showScreen('shelf');
      await loadLibrary();
    } catch (err) {
      openAdminLoginModal(
        { type: 'select-profile', profileId },
        'Admin-tilgang kreves',
        err.message || 'Skriv inn admin-passord for å velge denne profilen.'
      );
    }
  }

  function updateTopbarProfileBadge(profile) {
    if (!profile) return;
    state.activeProfile = profile;
    el.currentProfileName.textContent = profile.name;
    el.currentProfileAvatar.replaceChildren();
    if (isSafeAvatarUrl(profile.avatar)) {
      const img = document.createElement('img');
      img.src = profile.avatar;
      img.alt = profile.name;
      el.currentProfileAvatar.appendChild(img);
      el.currentProfileAvatar.style.background = 'transparent';
    } else {
      el.currentProfileAvatar.textContent = getInitials(profile.name);
      el.currentProfileAvatar.style.background = safeHexColor(profile.color);
    }
    if (el.personalBookmarkSubnote) {
      el.personalBookmarkSubnote.textContent = `Kun synlig for ${profile.name}`;
    }
  }

  function openProfileModal(profile = null) {
    state.editingProfileId = profile ? profile.id : null;
    state.draftProfileAvatar = profile && isSafeAvatarUrl(profile.avatar) ? profile.avatar : '';
    state.draftProfileColor = profile ? safeHexColor(profile.color) : '#00A3FF';

    el.profileModalTitle.textContent = profile ? `Rediger ${profile.name}` : 'Ny profil';
    el.inputProfileName.value = profile ? profile.name : '';
    el.btnDeleteProfile.classList.toggle(
      'hidden',
      !profile || state.profiles.length <= 1 || Boolean(profile && profile.isAdmin && state.profiles.filter((p) => p.isAdmin).length <= 1)
    );

    refreshProfileModalPreview();
    el.profileModal.classList.remove('hidden');
    el.inputProfileName.focus();
  }

  function refreshProfileModalPreview() {
    const name = el.inputProfileName.value.trim() || 'NY';
    if (isSafeAvatarUrl(state.draftProfileAvatar)) {
      el.avatarPreviewImg.src = state.draftProfileAvatar;
      el.avatarPreviewImg.classList.remove('hidden');
      el.avatarPreviewInitials.classList.add('hidden');
      el.btnClearAvatar.classList.remove('hidden');
    } else {
      el.avatarPreviewImg.removeAttribute('src');
      el.avatarPreviewImg.classList.add('hidden');
      el.avatarPreviewInitials.classList.remove('hidden');
      el.avatarPreviewInitials.textContent = getInitials(name);
      el.avatarPreviewInitials.style.color = safeHexColor(state.draftProfileColor);
      el.btnClearAvatar.classList.add('hidden');
    }

    el.profileColorSwatches.querySelectorAll('.color-swatch').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.color === state.draftProfileColor);
    });
  }

  function resizeImageFileToDataUrl(file, maxSize = 240) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = maxSize;
          canvas.height = maxSize;
          const ctx = canvas.getContext('2d');
          const minSide = Math.min(img.width, img.height);
          const sx = (img.width - minSide) / 2;
          const sy = (img.height - minSide) / 2;
          ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, maxSize, maxSize);
          resolve(canvas.toDataURL('image/jpeg', 0.86));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function saveProfileFromModal() {
    const name = el.inputProfileName.value.trim();
    if (!name) {
      el.inputProfileName.focus();
      return;
    }

    try {
      if (state.editingProfileId) {
        await apiPut(`/api/profiles/${encodeURIComponent(state.editingProfileId)}`, {
          name,
          avatar: state.draftProfileAvatar,
          color: state.draftProfileColor
        });
        el.profileModal.classList.add('hidden');
        await loadProfiles(true);
      } else {
        const res = await apiPost('/api/profiles', {
          name,
          avatar: state.draftProfileAvatar,
          color: state.draftProfileColor
        });
        el.profileModal.classList.add('hidden');
        await loadProfiles(true);
        if (res.profile && !state.manageProfilesMode) {
          await selectProfile(res.profile.id);
        }
      }
    } catch (err) {
      console.error('Kunne ikke lagre profil:', err);
    }
  }

  async function deleteEditingProfile() {
    if (!state.editingProfileId) return;
    try {
      await apiDelete(`/api/profiles/${encodeURIComponent(state.editingProfileId)}`);
      if (state.activeProfileId === state.editingProfileId) {
        state.activeProfileId = null;
        localStorage.removeItem('bokami_profile_id');
      }
      el.profileModal.classList.add('hidden');
      await loadProfiles(true);
    } catch (err) {
      console.error('Kunne ikke slette profil:', err);
    }
  }

  // ======================== DATA LOADING & FILTERING ========================
  async function loadLibrary() {
    try {
      el.subbarStatus.textContent = 'Oppdaterer...';
      const data = await apiGet('/api/books');
      state.books = data.books || [];
      state.isAdmin = Boolean(data.isAdmin);
      syncAdminControlsVisibility();
      if (data.profile) {
        updateTopbarProfileBadge(data.profile);
      }
      if (data.preferences) {
        state.preferences = { ...state.preferences, ...data.preferences };
      }
      applyFilterAndRender();
      syncTopbarControls();
      if (state.isAdmin) {
        ensurePdfCoversGenerated();
      }
    } catch (err) {
      el.subbarStatus.textContent = 'Kunne ikke laste bokhylle';
      console.error(err);
    }
  }

  async function ensurePdfCoversGenerated() {
    if (!state.isAdmin) return;
    const pdfjs = await waitForPdfJs();
    if (!pdfjs) return;
    for (const book of state.books) {
      if (book.format === 'pdf' && (!book.covers || !book.covers.hasC1) && book.ebookUrl) {
        try {
          const pdfDoc = await pdfjs.getDocument({
            url: book.ebookUrl,
            isEvalSupported: false
          }).promise;
          const page = await pdfDoc.getPage(1);
          const vp = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(vp.width);
          canvas.height = Math.round(vp.height);
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const dataUrl = canvas.toDataURL('image/jpeg', 0.88);

          const res = await apiPost(`/api/books/${encodeURIComponent(book.id)}/cover-cache`, {
            dataUrl,
            pageCount: pdfDoc.numPages
          });
          if (res && res.covers) {
            book.covers = res.covers;
            if (res.totalPages) book.totalPages = res.totalPages;
            applyFilterAndRender();
          }
        } catch (err) {
          console.warn('Kunne ikke generere PDF-forside:', err);
        }
      }
    }
  }

  function applyFilterAndRender() {
    const q = state.searchQuery.trim().toLowerCase();
    state.filteredBooks = state.books.filter((b) => {
      if (q && !b.title.toLowerCase().includes(q)) return false;
      if (state.filter === 'reading') {
        return b.progress && b.progress.pageIndex > 0 && !b.progress.completed;
      }
      if (state.filter === 'bookmarked') {
        return (b.bookmarkCount || 0) > 0;
      }
      if (state.filter === 'completed') {
        return b.progress && b.progress.completed;
      }
      return true;
    });

    el.bookCountBadge.textContent = String(state.books.length);
    el.subbarStatus.textContent = `${state.filteredBooks.length} av ${state.books.length} bøker`;

    if (state.carouselIndex >= state.filteredBooks.length) {
      state.carouselIndex = Math.max(0, state.filteredBooks.length - 1);
    }

    const isEmpty = state.filteredBooks.length === 0;
    el.emptyState.classList.toggle('hidden', !isEmpty);

    if (isEmpty) {
      el.gridViewContainer.classList.remove('active');
      el.spineViewContainer.classList.remove('active');
      el.emptyStateDesc.textContent =
        state.books.length === 0
          ? 'Ingen bøker er tilgjengelige for denne profilen.'
          : 'Ingen bøker passer med valgt filter eller søk.';
      return;
    }

    if (state.preferences.shelfView === 'spine') {
      el.gridViewContainer.classList.remove('active');
      el.spineViewContainer.classList.add('active');
      renderSpineCarousel();
    } else {
      el.spineViewContainer.classList.remove('active');
      el.gridViewContainer.classList.add('active');
      renderGridView();
    }
  }

  function syncTopbarControls() {
    const isSpine = state.preferences.shelfView === 'spine';
    el.btnViewGrid.classList.toggle('active', !isSpine);
    el.btnViewSpine.classList.toggle('active', isSpine);
    el.gridCoverSelector.classList.toggle('hidden', isSpine);

    document.querySelectorAll('[data-grid-cover]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.gridCover === state.preferences.gridCoverMode);
    });
  }

  // ======================== BOOK PROPORTION & SIZE VARIABLE HELPERS ========================
  function getBookDims(book) {
    const dims = (book && book.covers && book.covers.dims) || {};
    const c1 = dims.c1 || { width: 1460, height: 2000, ratio: 0.732 };
    const c2 = dims.c2 || { width: 120, height: c1.height || 2000, ratio: 0.06 };
    const c3 = dims.c3 || c1;
    return { c1, c2, c3 };
  }

  function applyGridThumbProportions(thumbEl, book, mode) {
    const { c1, c2, c3 } = getBookDims(book);
    const scale = Math.max(0.5, Math.min(1.5, Number(book.sizeScale) || 1.0));
    if (mode === 'c2') {
      const spineRatio = book.covers && book.covers.hasC2 ? (c2.ratio || 0.065) : 0.11;
      thumbEl.style.setProperty('--grid-book-ar', spineRatio.toFixed(4));
      thumbEl.style.setProperty('--grid-book-w', `${Math.round(28 * scale)}%`);
      return;
    }
    const targetDim = mode === 'c3' ? c3 : c1;
    const ratio = targetDim.ratio || 0.732;
    const widthPct = Math.min(100, Math.max(55, Math.round(88 * scale)));
    thumbEl.style.setProperty('--grid-book-ar', ratio.toFixed(4));
    thumbEl.style.setProperty('--grid-book-w', `${widthPct}%`);
  }

  function computeCarouselItemSize(book, mode, isCenter) {
    const { c1, c2, c3 } = getBookDims(book);
    const stageH = el.spineStage.clientHeight || (window.innerWidth <= 768 ? 320 : 500);
    const maxBookH = Math.max(220, stageH - 28);

    const scale = Math.max(0.5, Math.min(1.5, Number(book.sizeScale) || 1.0));
    const bookHeight = Math.round(maxBookH * scale);

    if (isCenter && mode !== 'c2') {
      const activeDim = mode === 'c3' ? c3 : c1;
      const activeRatio = activeDim.ratio || 0.732;
      const bookWidth = Math.round(bookHeight * activeRatio);
      return { width: bookWidth, height: bookHeight };
    }

    if (book.covers && book.covers.hasC2 && c2.ratio) {
      const exactSpineWidth = Math.max(16, Math.round(bookHeight * c2.ratio));
      return { width: exactSpineWidth, height: bookHeight };
    }

    const isMobile = window.innerWidth <= 768;
    const baseGeneratedW = isMobile ? 34 : 44;
    const spineWidth = Math.round(baseGeneratedW * scale);
    return { width: spineWidth, height: bookHeight };
  }

  function createCoverOrSpineNode(book, mode) {
    if (mode === 'c2' && (!book.covers || !book.covers.hasC2)) {
      const wrap = document.createElement('div');
      wrap.className = 'generated-spine';
      if (book.covers && book.covers.c1) {
        const bgImg = document.createElement('img');
        bgImg.className = 'generated-spine-bg';
        bgImg.src = book.covers.c1;
        bgImg.alt = '';
        wrap.appendChild(bgImg);
      }
      const titleSpan = document.createElement('span');
      titleSpan.className = 'generated-spine-title';
      titleSpan.textContent = book.title;
      wrap.appendChild(titleSpan);
      return wrap;
    }

    const coverUrl = book.covers ? (book.covers[mode] || book.covers.c1) : null;
    if (!coverUrl) {
      const wrap = document.createElement('div');
      wrap.className = 'generated-cover';

      const badge = document.createElement('span');
      badge.className = 'generated-cover-badge';
      badge.textContent = String(book.format || 'bok').toUpperCase();

      const titleDiv = document.createElement('div');
      titleDiv.className = 'generated-cover-title';
      titleDiv.textContent = book.title;

      wrap.append(badge, titleDiv);
      return wrap;
    }

    const img = document.createElement('img');
    img.src = coverUrl;
    img.alt = book.title;
    img.loading = 'lazy';
    return img;
  }

  function createCoverSwitcherNode(initialMode) {
    const switcher = document.createElement('div');
    switcher.className = 'card-cover-switcher';
    switcher.title = 'Bytt forhåndsvisning';
    const options = [
      ['c1', 'Forsats'],
      ['c2', 'Rygg'],
      ['c3', 'Baksats']
    ];
    for (const [key, label] of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `mini-cover-btn${initialMode === key ? ' active' : ''}`;
      btn.dataset.cardCover = key;
      btn.textContent = label;
      switcher.appendChild(btn);
    }
    return switcher;
  }

  async function adjustBookSizeScale(book, delta) {
    if (!book || !state.isAdmin) return;
    const current = Number(book.sizeScale) || 1.0;
    const next = Math.max(0.5, Math.min(1.4, Math.round((current + delta) * 100) / 100));
    book.sizeScale = next;

    const libBook = state.books.find((b) => b.id === book.id);
    if (libBook) libBook.sizeScale = next;

    if (el.carouselScaleLabel) {
      el.carouselScaleLabel.textContent = `${Math.round(next * 100)}%`;
    }
    if (el.readerScaleLabel) {
      el.readerScaleLabel.textContent = `${Math.round(next * 100)}%`;
    }

    if (!state.activeBook) {
      if (state.preferences.shelfView === 'spine') {
        updateSpineCarouselSelection();
      } else {
        renderGridView();
      }
    }

    try {
      await apiPost(`/api/books/${encodeURIComponent(book.id)}/meta`, { sizeScale: next });
    } catch (err) {
      console.error('Feil ved lagring av bokstørrelse:', err);
    }
  }

  // ======================== 1) GRID VIEW RENDERER ========================
  function renderGridView() {
    const coverMode = state.preferences.gridCoverMode || 'c1';
    el.booksGrid.classList.toggle('spine-mode-grid', coverMode === 'c2');
    el.booksGrid.replaceChildren();

    state.filteredBooks.forEach((book) => {
      const card = document.createElement('article');
      card.className = 'book-card';

      const statusText = book.progress
        ? book.progress.completed
          ? `Fullført · ${book.totalPages} sider`
          : `Side ${book.progress.pageIndex + 1} av ${book.totalPages}`
        : `${book.totalPages} sider`;

      const thumbEl = document.createElement('div');
      thumbEl.className = 'book-card-thumb';

      const mediaSlot = document.createElement('div');
      mediaSlot.className = 'thumb-media-slot';
      mediaSlot.style.width = '100%';
      mediaSlot.style.height = '100%';
      mediaSlot.appendChild(createCoverOrSpineNode(book, coverMode));

      const badges = document.createElement('div');
      badges.className = 'card-badges';
      if (book.adminOnly) {
        const admBadge = document.createElement('span');
        admBadge.className = 'card-badge';
        admBadge.textContent = 'ADMIN';
        badges.appendChild(admBadge);
      }
      if (book.format === 'epub' || book.format === 'pdf') {
        const fmtBadge = document.createElement('span');
        fmtBadge.className = 'card-badge';
        fmtBadge.textContent = book.format.toUpperCase();
        badges.appendChild(fmtBadge);
      }
      if (book.bookmarkCount > 0) {
        const bmBadge = document.createElement('span');
        bmBadge.className = 'card-badge';
        bmBadge.title = `${book.bookmarkCount} bokmerker`;
        bmBadge.textContent = `★ ${book.bookmarkCount}`;
        badges.appendChild(bmBadge);
      }

      const switcher = createCoverSwitcherNode(coverMode);
      thumbEl.append(mediaSlot, badges, switcher);
      applyGridThumbProportions(thumbEl, book, coverMode);

      const bodyEl = document.createElement('div');
      bodyEl.className = 'book-card-body';

      const titleEl = document.createElement('div');
      titleEl.className = 'book-card-title';
      titleEl.title = book.title;
      titleEl.textContent = book.title;

      const metaEl = document.createElement('div');
      metaEl.className = 'book-card-meta';
      metaEl.textContent = statusText;

      bodyEl.append(titleEl, metaEl);
      card.append(thumbEl, bodyEl);

      switcher.querySelectorAll('.mini-cover-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const type = btn.dataset.cardCover;
          mediaSlot.replaceChildren(createCoverOrSpineNode(book, type));
          applyGridThumbProportions(thumbEl, book, type);
          switcher.querySelectorAll('.mini-cover-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });

      card.addEventListener('click', () => {
        openBook(book.id);
      });

      el.booksGrid.appendChild(card);
    });
  }

  // ======================== 2) RYGG CAROUSEL RENDERER ========================
  function renderSpineCarousel() {
    el.spineTrack.replaceChildren();
    if (state.filteredBooks.length === 0) return;

    state.filteredBooks.forEach((book, idx) => {
      const isCenter = idx === state.carouselIndex;
      const item = document.createElement('div');
      item.className = `spine-item ${isCenter ? 'active' : ''}`;
      item.dataset.index = String(idx);

      const centerMode = state.carouselCoverMode || 'c1';
      const activeMode = isCenter ? centerMode : 'c2';

      const size = computeCarouselItemSize(book, activeMode, isCenter);
      item.style.width = `${size.width}px`;
      item.style.height = `${size.height}px`;
      item.dataset.targetWidth = String(size.width);

      const mediaSlot = document.createElement('div');
      mediaSlot.className = 'spine-media-slot';
      mediaSlot.style.width = '100%';
      mediaSlot.style.height = '100%';
      mediaSlot.appendChild(createCoverOrSpineNode(book, activeMode));

      const switcher = createCoverSwitcherNode(centerMode);
      item.append(mediaSlot, switcher);

      switcher.querySelectorAll('.mini-cover-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const type = btn.dataset.cardCover;
          state.carouselCoverMode = type;
          mediaSlot.replaceChildren(createCoverOrSpineNode(book, type));
          const nextSize = computeCarouselItemSize(book, type, true);
          item.style.width = `${nextSize.width}px`;
          item.style.height = `${nextSize.height}px`;
          item.dataset.targetWidth = String(nextSize.width);
          switcher.querySelectorAll('.mini-cover-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          centerActiveSpineItem();
        });
      });

      item.addEventListener('click', () => {
        if (state.carouselIndex === idx) {
          openBook(book.id);
        } else {
          state.carouselIndex = idx;
          state.carouselCoverMode = 'c1';
          updateSpineCarouselSelection();
        }
      });

      el.spineTrack.appendChild(item);
    });

    updateSpineCarouselFooter();
    requestAnimationFrame(centerActiveSpineItem);
  }

  function updateSpineCarouselSelection() {
    const items = el.spineTrack.querySelectorAll('.spine-item');
    items.forEach((item, idx) => {
      const book = state.filteredBooks[idx];
      if (!book) return;
      const isCenter = idx === state.carouselIndex;
      item.classList.toggle('active', isCenter);

      const mediaSlot = item.querySelector('.spine-media-slot');
      const centerMode = state.carouselCoverMode || 'c1';
      const activeMode = isCenter ? centerMode : 'c2';

      const size = computeCarouselItemSize(book, activeMode, isCenter);
      item.style.width = `${size.width}px`;
      item.style.height = `${size.height}px`;
      item.dataset.targetWidth = String(size.width);

      if (mediaSlot) {
        mediaSlot.replaceChildren(createCoverOrSpineNode(book, activeMode));
      }

      if (isCenter) {
        item.querySelectorAll('.mini-cover-btn').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.cardCover === centerMode);
        });
      }
    });

    updateSpineCarouselFooter();
    centerActiveSpineItem();
  }

  function centerActiveSpineItem() {
    const items = Array.from(el.spineTrack.querySelectorAll('.spine-item'));
    if (items.length === 0) return;
    const activeIdx = Math.max(0, Math.min(items.length - 1, state.carouselIndex));
    const gap = 10;

    let offsetBefore = 0;
    for (let i = 0; i < activeIdx; i++) {
      const w = parseFloat(items[i].dataset.targetWidth) || items[i].offsetWidth || 44;
      offsetBefore += w + gap;
    }
    const activeW = parseFloat(items[activeIdx].dataset.targetWidth) || items[activeIdx].offsetWidth || 300;
    const translateX = -(offsetBefore + activeW / 2);
    el.spineTrack.style.transform = `translateX(${Math.round(translateX)}px)`;
  }

  function updateSpineCarouselFooter() {
    const book = state.filteredBooks[state.carouselIndex];
    if (!book) return;

    el.carouselBookTitle.textContent = book.title;
    const progText = book.progress
      ? book.progress.completed
        ? `Fullført (${book.totalPages} sider)`
        : `Side ${book.progress.pageIndex + 1} av ${book.totalPages}`
      : `${book.totalPages} sider`;

    const chText = book.chapterCount > 0 ? ` · ${book.chapterCount} kapitler` : '';
    const bmText = book.bookmarkCount > 0 ? ` · ★ ${book.bookmarkCount}` : '';
    el.carouselBookMeta.textContent = `${progText}${chText}${bmText}`;

    const label =
      book.progress && book.progress.pageIndex > 0 && !book.progress.completed
        ? `Les videre (Side ${book.progress.pageIndex + 1})`
        : 'Åpne bok';
    el.carouselOpenBtn.textContent = label;

    if (el.carouselScaleLabel) {
      el.carouselScaleLabel.textContent = `${Math.round((book.sizeScale || 1.0) * 100)}%`;
    }
  }

  function stepCarousel(delta) {
    if (state.filteredBooks.length === 0) return;
    const next = Math.max(0, Math.min(state.filteredBooks.length - 1, state.carouselIndex + delta));
    if (next !== state.carouselIndex) {
      state.carouselIndex = next;
      state.carouselCoverMode = 'c1';
      updateSpineCarouselSelection();
    }
  }

  // ======================== READER (PLAYER: IMAGES, PDF & EPUB) ========================
  async function renderPdfPageToDataUrl(pageNumber, scale = 1.8) {
    if (!activePdfDoc) return '';
    const cacheKey = `${state.activeBook ? state.activeBook.id : ''}::${pageNumber}::${scale}`;
    if (pdfPageRenderCache.has(cacheKey)) {
      return pdfPageRenderCache.get(cacheKey);
    }
    const page = await activePdfDoc.getPage(pageNumber);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    pdfPageRenderCache.set(cacheKey, dataUrl);
    return dataUrl;
  }

  async function openBook(bookId, openDrawer = false) {
    try {
      const detail = await apiGet(`/api/books/${encodeURIComponent(bookId)}`);
      state.activeBook = detail;
      state.isAdmin = Boolean(detail.isAdmin);
      syncAdminControlsVisibility();
      activePdfDoc = null;
      pdfPageRenderCache.clear();

      if (detail.format === 'pdf' && detail.ebookUrl) {
        const pdfjs = await waitForPdfJs();
        if (pdfjs) {
          activePdfDoc = await pdfjs.getDocument({
            url: detail.ebookUrl,
            isEvalSupported: false
          }).promise;
          if (activePdfDoc.numPages && activePdfDoc.numPages !== detail.totalPages) {
            detail.totalPages = activePdfDoc.numPages;
            detail.pages = Array.from({ length: activePdfDoc.numPages }, (_, idx) => ({
              index: idx,
              filename: `page-${idx + 1}.pdf`,
              label: idx === 0 ? 'Forsats / Side 1' : `Side ${idx + 1}`,
              shortLabel: `Side ${idx + 1}`,
              type: idx === 0 ? 'c1' : 'page',
              pageNumber: idx + 1,
              pdfPageNumber: idx + 1
            }));
          }
        }
      }

      const savedIndex = detail.progress ? detail.progress.pageIndex : 0;
      state.currentPageIndex = Math.max(0, Math.min(detail.totalPages - 1, savedIndex));

      resetZoom(false);
      setBarsHidden(false);
      el.viewOptionsPopover.classList.add('hidden');
      el.btnViewOptions.classList.remove('active');
      resolveEffectiveReaderMode();

      showScreen('reader');

      el.readerBookTitle.textContent = detail.title;
      el.pageScrubber.max = String(Math.max(0, detail.totalPages - 1));

      setDrawerOpen(openDrawer);
      syncReaderToolbar();
      renderChaptersList();
      renderBookmarksList();
      renderScrubberTicks();

      if (state.effectiveReaderMode === 'vertical') {
        renderVerticalReader();
      } else {
        renderPagedReader();
      }
    } catch (err) {
      console.error('Feil ved åpning av bok:', err);
    }
  }

  function closeReader() {
    if (verticalObserver) {
      verticalObserver.disconnect();
      verticalObserver = null;
    }
    state.activeBook = null;
    activePdfDoc = null;
    pdfPageRenderCache.clear();
    resetZoom(false);
    setBarsHidden(false);
    el.viewOptionsPopover.classList.add('hidden');
    showScreen('shelf');
    loadLibrary();
  }

  function isDrawerOpen() {
    return !el.bookmarksDrawer.classList.contains('is-closed');
  }

  function setDrawerOpen(open, switchToTab = null) {
    el.bookmarksDrawer.classList.toggle('is-closed', !open);
    el.btnBookmarksDrawer.classList.toggle('active', Boolean(open));
    if (open && switchToTab) {
      state.drawerTab = switchToTab;
      el.tabBtnChapters.classList.toggle('active', switchToTab === 'chapters');
      el.tabBtnBookmarks.classList.toggle('active', switchToTab === 'bookmarks');
      el.drawerPaneChapters.classList.toggle('active', switchToTab === 'chapters');
      el.drawerPaneBookmarks.classList.toggle('active', switchToTab === 'bookmarks');
    }
  }

  function setBarsHidden(hidden) {
    state.barsHidden = Boolean(hidden);
    el.readerScreen.classList.toggle('bars-hidden', state.barsHidden);
    if (state.barsHidden) {
      el.viewOptionsPopover.classList.add('hidden');
      el.btnViewOptions.classList.remove('active');
    }
  }

  function toggleBarsHidden() {
    setBarsHidden(!state.barsHidden);
  }

  function resolveEffectiveReaderMode() {
    const pref = state.preferences.readerMode;
    if (pref === 'single' || pref === 'spread' || pref === 'vertical') {
      state.effectiveReaderMode = pref;
    } else {
      state.effectiveReaderMode = window.innerWidth >= 820 ? 'spread' : 'single';
    }
  }

  function syncReaderToolbar() {
    document.querySelectorAll('[data-reader-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.readerMode === state.effectiveReaderMode);
    });

    const book = state.activeBook;
    const forsatsAlene = book ? Boolean(book.forsatsAlene) : true;
    el.popoverSpreadSection.classList.toggle(
      'hidden',
      !state.isAdmin || state.effectiveReaderMode !== 'spread'
    );
    if (el.popoverScaleSection) {
      el.popoverScaleSection.classList.toggle('hidden', !state.isAdmin);
    }
    el.btnSpreadOffset.textContent = forsatsAlene ? 'På' : 'Av';
    el.btnSpreadOffset.classList.toggle('active', forsatsAlene);

    if (el.readerScaleLabel && book) {
      el.readerScaleLabel.textContent = `${Math.round((book.sizeScale || 1.0) * 100)}%`;
    }

    const isVertical = state.effectiveReaderMode === 'vertical';
    el.readerStage.classList.toggle('hidden', isVertical);
    el.readerVertical.classList.toggle('hidden', !isVertical);
  }

  function getSpreadPageIndices(pageIndex) {
    const book = state.activeBook;
    if (!book || book.pages.length === 0) return [0];

    const total = book.pages.length;
    const idx = Math.max(0, Math.min(total - 1, pageIndex));

    if (state.effectiveReaderMode !== 'spread') {
      return [idx];
    }

    const soloFirst = Boolean(book.forsatsAlene);
    const lastPage = book.pages[total - 1];
    const soloLast = lastPage && lastPage.type === 'c3' && total > 1;

    if (soloFirst && idx === 0) {
      return [0];
    }

    if (soloLast && idx === total - 1) {
      return [total - 1];
    }

    const offset = soloFirst ? 1 : 0;
    const rel = idx - offset;
    const pairStart = offset + Math.floor(rel / 2) * 2;
    const pairEnd = pairStart + 1;

    if (pairEnd < total && !(soloLast && pairEnd === total - 1)) {
      return [pairStart, pairEnd];
    }
    return [pairStart];
  }

  function renderPagedReader() {
    const book = state.activeBook;
    if (!book) return;

    resetZoom(false);

    const indices = getSpreadPageIndices(state.currentPageIndex);
    state.currentPageIndex = indices[0];

    el.spreadContainer.className = `spread-container ${indices.length > 1 ? 'is-spread' : 'single-mode'}`;
    el.spreadContainer.replaceChildren();

    indices.forEach((i) => {
      const page = book.pages[i];
      if (!page) return;

      if (book.format === 'epub') {
        const card = document.createElement('div');
        card.className = 'epub-page-card';
        safeSetEpubHtml(card, page.html || '');
        el.spreadContainer.appendChild(card);
        return;
      }

      const img = document.createElement('img');
      img.className = 'reader-page-img';
      img.alt = page.label;
      img.draggable = false;

      if (book.format === 'pdf') {
        const pdfNum = page.pdfPageNumber || i + 1;
        renderPdfPageToDataUrl(pdfNum, 1.8).then((url) => {
          if (url) img.src = url;
        });
      } else {
        img.src = page.url;
      }

      el.spreadContainer.appendChild(img);
    });

    updateReaderIndicators(indices);
    if (book.format === 'images') {
      preloadAdjacentPages(indices[indices.length - 1]);
    } else if (book.format === 'pdf') {
      const nextNum = (indices[indices.length - 1] || 0) + 2;
      if (nextNum <= book.totalPages) {
        renderPdfPageToDataUrl(nextNum, 1.8).catch(() => {});
      }
    }
    scheduleSaveProgress();
  }

  function renderVerticalReader() {
    const book = state.activeBook;
    if (!book) return;

    if (verticalObserver) {
      verticalObserver.disconnect();
    }

    el.readerVertical.replaceChildren();

    book.pages.forEach((page) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'vertical-page-wrapper';
      wrapper.dataset.pageIndex = String(page.index);

      if (book.format === 'epub') {
        const card = document.createElement('div');
        card.className = 'epub-page-card';
        card.style.width = 'min(740px, 94vw)';
        card.style.height = 'auto';
        card.style.maxHeight = 'none';
        safeSetEpubHtml(card, page.html || '');
        wrapper.appendChild(card);
      } else if (book.format === 'pdf') {
        const img = document.createElement('img');
        img.className = 'pdf-lazy-img';
        img.dataset.pdfPage = String(page.pdfPageNumber || page.index + 1);
        img.alt = page.label;
        wrapper.appendChild(img);
      } else {
        const img = document.createElement('img');
        img.src = page.url;
        img.alt = page.label;
        img.loading = 'lazy';
        wrapper.appendChild(img);
      }

      const caption = document.createElement('div');
      caption.className = 'vertical-page-caption';
      caption.textContent = page.shortLabel || page.label;
      wrapper.appendChild(caption);

      wrapper.addEventListener('click', () => {
        toggleBarsHidden();
      });
      el.readerVertical.appendChild(wrapper);
    });

    verticalObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = parseInt(entry.target.dataset.pageIndex, 10);
            const lazyPdfImg = entry.target.querySelector('.pdf-lazy-img');
            if (lazyPdfImg && !lazyPdfImg.src) {
              const pNum = parseInt(lazyPdfImg.dataset.pdfPage, 10) || 1;
              renderPdfPageToDataUrl(pNum, 1.6).then((url) => {
                if (url) lazyPdfImg.src = url;
              });
            }
            if (!Number.isNaN(idx)) {
              state.currentPageIndex = idx;
              updateReaderIndicators([idx]);
              scheduleSaveProgress();
            }
          }
        }
      },
      {
        root: el.readerVertical,
        threshold: 0.25
      }
    );

    el.readerVertical.querySelectorAll('.vertical-page-wrapper').forEach((node) => {
      verticalObserver.observe(node);
    });

    requestAnimationFrame(() => {
      const target = el.readerVertical.querySelector(`[data-page-index="${state.currentPageIndex}"]`);
      if (target) {
        target.scrollIntoView({ block: 'start' });
      }
    });

    updateReaderIndicators([state.currentPageIndex]);
  }

  function getActiveChapterForPage(pageIndex) {
    const book = state.activeBook;
    if (!book || !Array.isArray(book.chapters) || book.chapters.length === 0) return null;
    let current = null;
    for (const ch of book.chapters) {
      if (ch.pageIndex <= pageIndex) {
        current = ch;
      } else {
        break;
      }
    }
    return current;
  }

  function updateReaderIndicators(visibleIndices) {
    const book = state.activeBook;
    if (!book) return;

    const firstIdx = visibleIndices[0];
    const lastIdx = visibleIndices[visibleIndices.length - 1];
    const firstPage = book.pages[firstIdx];

    if (visibleIndices.length > 1) {
      el.scrubberCurrentLabel.textContent = `${firstIdx + 1}–${lastIdx + 1} / ${book.totalPages}`;
    } else if (firstPage && (firstPage.type === 'c1' || firstPage.type === 'c3')) {
      el.scrubberCurrentLabel.textContent = `${firstPage.shortLabel} (${firstIdx + 1}/${book.totalPages})`;
    } else {
      el.scrubberCurrentLabel.textContent = `${firstIdx + 1} / ${book.totalPages}`;
    }

    const fillPct =
      book.totalPages > 1 ? Math.min(100, Math.max(0, (lastIdx / (book.totalPages - 1)) * 100)) : 100;
    if (el.scrubberVisualFill) {
      el.scrubberVisualFill.style.width = `${fillPct}%`;
    }

    const activeChapter = getActiveChapterForPage(lastIdx);
    if (activeChapter) {
      el.readerChapterBadge.textContent = activeChapter.title;
      el.readerChapterBadge.classList.remove('hidden');
    } else {
      el.readerChapterBadge.classList.add('hidden');
    }

    el.pageScrubber.value = String(firstIdx);

    const bms = book.bookmarks || [];
    const hasBm = visibleIndices.some((idx) => bms.some((b) => b.pageIndex === idx));
    el.btnBookmarkToggle.classList.toggle('active', hasBm);

    el.bookmarksList.querySelectorAll('.bookmark-item').forEach((item) => {
      const bmIdx = parseInt(item.dataset.pageIndex, 10);
      item.classList.toggle('current', visibleIndices.includes(bmIdx));
    });

    el.chaptersList.querySelectorAll('.bookmark-item').forEach((item) => {
      const chId = item.dataset.chapterId;
      item.classList.toggle('current', Boolean(activeChapter && activeChapter.id === chId));
    });
  }

  // ======================== EXPORT PAGES (PDF / ZIP) ========================
  function openExportModal() {
    const book = state.activeBook;
    if (!book) return;

    const visibleIndices = getSpreadPageIndices(state.currentPageIndex);
    const firstOneBased = visibleIndices[0] + 1;
    const lastOneBased = visibleIndices[visibleIndices.length - 1] + 1;

    el.exportFromInput.max = String(book.totalPages);
    el.exportToInput.max = String(book.totalPages);
    el.exportFromInput.value = String(firstOneBased);
    el.exportToInput.value = String(lastOneBased);

    const activeChapter = getActiveChapterForPage(visibleIndices[0]);
    el.btnPresetChapter.classList.toggle('hidden', !activeChapter);
    if (activeChapter) {
      el.btnPresetChapter.textContent = `Kapittel: ${activeChapter.title}`;
    }

    updateExportSummary();
    el.exportModal.classList.remove('hidden');
  }

  function updateExportSummary() {
    const book = state.activeBook;
    if (!book) return;
    const fromVal = Math.max(1, Math.min(book.totalPages, parseInt(el.exportFromInput.value, 10) || 1));
    const toVal = Math.max(fromVal, Math.min(book.totalPages, parseInt(el.exportToInput.value, 10) || fromVal));
    const count = toVal - fromVal + 1;
    el.exportSummaryText.textContent = `Valgt: Side ${fromVal} til ${toVal} (${count} ${count === 1 ? 'side' : 'sider'})`;
  }

  function triggerExportDownload(format) {
    const book = state.activeBook;
    if (!book) return;
    const fromVal = Math.max(1, Math.min(book.totalPages, parseInt(el.exportFromInput.value, 10) || 1));
    const toVal = Math.max(fromVal, Math.min(book.totalPages, parseInt(el.exportToInput.value, 10) || fromVal));

    const url = `/api/export/${encodeURIComponent(book.id)}?from=${fromVal}&to=${toVal}&format=${encodeURIComponent(format)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    el.exportModal.classList.add('hidden');
  }

  // ======================== TRACKPAD & MOUSE WHEEL ZOOM + AUTO-HIDE BARS ========================
  function applyZoomTransform() {
    const isZoomed = state.zoomScale > 1.01;
    el.readerStage.classList.toggle('is-zoomed', isZoomed);
    el.zoomPanLayer.style.transform = `translate3d(${Math.round(state.panX)}px, ${Math.round(state.panY)}px, 0) scale(${state.zoomScale.toFixed(3)})`;

    if (isZoomed) {
      el.btnZoomReset.textContent = `${Math.round(state.zoomScale * 100)}%`;
      el.btnZoomReset.classList.remove('hidden');
    } else {
      el.btnZoomReset.classList.add('hidden');
    }
  }

  function resetZoom(unhideBars = false) {
    state.zoomScale = 1;
    state.panX = 0;
    state.panY = 0;
    applyZoomTransform();
    if (unhideBars) {
      setBarsHidden(false);
    }
  }

  function zoomByWheel(e) {
    if (!state.activeBook || state.effectiveReaderMode === 'vertical') return;
    e.preventDefault();

    const rect = el.readerStage.getBoundingClientRect();
    const cursorX = e.clientX - (rect.left + rect.width / 2);
    const cursorY = e.clientY - (rect.top + rect.height / 2);

    const sensitivity = e.ctrlKey ? 0.012 : 0.0018;
    const factor = Math.exp(-e.deltaY * sensitivity);
    const prevScale = state.zoomScale;
    const nextScale = Math.max(1, Math.min(4.5, prevScale * factor));

    if (nextScale <= 1.01) {
      resetZoom(false);
      return;
    }

    const ratio = nextScale / prevScale;
    state.panX = cursorX - (cursorX - state.panX) * ratio;
    state.panY = cursorY - (cursorY - state.panY) * ratio;
    state.zoomScale = nextScale;

    if (state.zoomScale > 1.05 && !state.barsHidden) {
      setBarsHidden(true);
    }

    applyZoomTransform();
  }

  function preloadAdjacentPages(fromIndex) {
    const book = state.activeBook;
    if (!book) return;

    const candidates = [
      fromIndex + 1,
      fromIndex + 2,
      fromIndex + 3,
      fromIndex + 4,
      fromIndex - 1,
      fromIndex - 2
    ];

    candidates.forEach((idx) => {
      if (idx >= 0 && idx < book.pages.length) {
        const url = book.pages[idx].url;
        if (url && !preloadedUrls.has(url)) {
          const img = new Image();
          img.src = url;
          preloadedUrls.add(url);
        }
      }
    });
  }

  function goToPage(targetIndex) {
    const book = state.activeBook;
    if (!book) return;
    const clamped = Math.max(0, Math.min(book.totalPages - 1, targetIndex));
    state.currentPageIndex = clamped;

    if (state.effectiveReaderMode === 'vertical') {
      const target = el.readerVertical.querySelector(`[data-page-index="${clamped}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      updateReaderIndicators([clamped]);
      scheduleSaveProgress();
    } else {
      renderPagedReader();
    }
  }

  function stepPage(direction) {
    const book = state.activeBook;
    if (!book) return;

    if (state.effectiveReaderMode === 'vertical') {
      goToPage(state.currentPageIndex + direction);
      return;
    }

    const currentSpread = getSpreadPageIndices(state.currentPageIndex);
    if (direction > 0) {
      const nextIdx = currentSpread[currentSpread.length - 1] + 1;
      if (nextIdx < book.totalPages) {
        state.currentPageIndex = nextIdx;
        renderPagedReader();
      }
    } else if (direction < 0) {
      const prevIdx = currentSpread[0] - 1;
      if (prevIdx >= 0) {
        const prevSpread = getSpreadPageIndices(prevIdx);
        state.currentPageIndex = prevSpread[0];
        renderPagedReader();
      }
    }
  }

  function scheduleSaveProgress() {
    if (!state.activeBook) return;
    clearTimeout(saveProgressTimer);
    const bookId = state.activeBook.id;
    const indices = getSpreadPageIndices(state.currentPageIndex);
    const furthestIdx = indices[indices.length - 1];
    const totalPages = state.activeBook.totalPages;

    saveProgressTimer = setTimeout(() => {
      apiPost(`/api/progress/${encodeURIComponent(bookId)}`, {
        pageIndex: furthestIdx,
        totalPages,
        completed: furthestIdx >= totalPages - 1
      }).catch(() => {});
    }, 250);
  }

  // ======================== SHARED CHAPTERS & FORSATS ALENE (ADMIN-ONLY) ========================
  async function toggleBookForsatsAlene() {
    const book = state.activeBook;
    if (!book || !state.isAdmin) return;
    const nextVal = !book.forsatsAlene;
    try {
      const res = await apiPost(`/api/books/${encodeURIComponent(book.id)}/meta`, {
        forsatsAlene: nextVal
      });
      book.forsatsAlene = res.forsatsAlene;
      syncReaderToolbar();
      renderPagedReader();
    } catch (err) {
      console.error('Kunne ikke lagre Forsats alene for boka:', err);
    }
  }

  async function saveChapterOnCurrentPage() {
    const book = state.activeBook;
    if (!book || !state.isAdmin) return;
    const pageIndex = state.currentPageIndex;
    const title =
      el.chapterTitleInput.value.trim() || `Kapittel ${(book.chapters || []).length + 1}`;

    try {
      const res = await apiPost(`/api/books/${encodeURIComponent(book.id)}/chapters`, {
        title,
        pageIndex
      });
      el.chapterTitleInput.value = '';
      book.chapters = res.chapters || [];
      renderChaptersList();
      renderScrubberTicks();
      updateReaderIndicators(getSpreadPageIndices(state.currentPageIndex));
    } catch (err) {
      console.error('Kunne ikke lagre kapittel:', err);
    }
  }

  async function deleteChapter(chapterId) {
    const book = state.activeBook;
    if (!book || !state.isAdmin) return;
    try {
      const res = await apiDelete(
        `/api/books/${encodeURIComponent(book.id)}/chapters/${encodeURIComponent(chapterId)}`
      );
      book.chapters = res.chapters || [];
      renderChaptersList();
      renderScrubberTicks();
      updateReaderIndicators(getSpreadPageIndices(state.currentPageIndex));
    } catch (err) {
      console.error('Kunne ikke slette kapittel:', err);
    }
  }

  function renderChaptersList() {
    const book = state.activeBook;
    if (!book) return;

    const chs = book.chapters || [];
    el.chaptersList.replaceChildren();

    if (chs.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'padding:14px; color:var(--text-secondary); font-size:12px; text-align:center;';
      emptyMsg.textContent = state.isAdmin
        ? 'Ingen kapitler lagt til ennå. Skriv inn kapittelnavn over for å legge til på nåværende side.'
        : 'Ingen kapitler er lagt til i denne boka ennå.';
      el.chaptersList.appendChild(emptyMsg);
      return;
    }

    chs.forEach((ch) => {
      const item = document.createElement('div');
      item.className = 'bookmark-item';
      item.dataset.chapterId = ch.id;
      item.dataset.pageIndex = String(ch.pageIndex);

      const info = document.createElement('div');
      info.className = 'bookmark-info';

      const pageSpan = document.createElement('span');
      pageSpan.className = 'bookmark-page';
      pageSpan.textContent = ch.title;

      const noteSpan = document.createElement('span');
      noteSpan.className = 'bookmark-note';
      noteSpan.textContent = ch.pageLabel || `Side ${ch.pageIndex + 1}`;

      info.append(pageSpan, noteSpan);
      item.appendChild(info);

      if (state.isAdmin) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-icon btn-sm ch-del-btn';
        delBtn.title = 'Slett kapittel';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteChapter(ch.id);
        });
        item.appendChild(delBtn);
      }

      item.addEventListener('click', () => {
        goToPage(ch.pageIndex);
      });

      el.chaptersList.appendChild(item);
    });
  }

  // ======================== PERSONAL BOOKMARKS (PER PROFILE) ========================
  async function toggleBookmarkOnCurrentPage() {
    const book = state.activeBook;
    if (!book) return;

    const pageIndex = state.currentPageIndex;
    const page = book.pages[pageIndex];
    const pageLabel = page ? page.shortLabel || page.label : `Side ${pageIndex + 1}`;

    try {
      const res = await apiPost(`/api/bookmarks/${encodeURIComponent(book.id)}`, {
        pageIndex,
        pageLabel,
        toggle: true
      });
      book.bookmarks = res.bookmarks || [];
      renderBookmarksList();
      renderScrubberTicks();
      updateReaderIndicators(getSpreadPageIndices(state.currentPageIndex));
    } catch (err) {
      console.error('Kunne ikke lagre bokmerke:', err);
    }
  }

  async function saveBookmarkWithNote() {
    const book = state.activeBook;
    if (!book) return;

    const pageIndex = state.currentPageIndex;
    const page = book.pages[pageIndex];
    const pageLabel = page ? page.shortLabel || page.label : `Side ${pageIndex + 1}`;
    const note = el.bookmarkNoteInput.value.trim();

    try {
      const res = await apiPost(`/api/bookmarks/${encodeURIComponent(book.id)}`, {
        pageIndex,
        pageLabel,
        note,
        toggle: false
      });
      el.bookmarkNoteInput.value = '';
      book.bookmarks = res.bookmarks || [];
      renderBookmarksList();
      renderScrubberTicks();
      updateReaderIndicators(getSpreadPageIndices(state.currentPageIndex));
    } catch (err) {
      console.error('Kunne ikke lagre bokmerkenotat:', err);
    }
  }

  async function deleteBookmark(bookmarkId) {
    const book = state.activeBook;
    if (!book) return;
    try {
      const res = await apiDelete(
        `/api/bookmarks/${encodeURIComponent(book.id)}/${encodeURIComponent(bookmarkId)}`
      );
      book.bookmarks = res.bookmarks || [];
      renderBookmarksList();
      renderScrubberTicks();
      updateReaderIndicators(getSpreadPageIndices(state.currentPageIndex));
    } catch (err) {
      console.error('Kunne ikke slette bokmerke:', err);
    }
  }

  function renderBookmarksList() {
    const book = state.activeBook;
    if (!book) return;

    const bms = book.bookmarks || [];
    el.bookmarksList.replaceChildren();

    if (bms.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'padding:14px; color:var(--text-secondary); font-size:12px; text-align:center;';
      emptyMsg.textContent = 'Ingen bokmerker i denne boka ennå.';
      el.bookmarksList.appendChild(emptyMsg);
      return;
    }

    bms.forEach((bm) => {
      const item = document.createElement('div');
      item.className = 'bookmark-item';
      item.dataset.pageIndex = String(bm.pageIndex);

      const info = document.createElement('div');
      info.className = 'bookmark-info';

      const pageSpan = document.createElement('span');
      pageSpan.className = 'bookmark-page';
      pageSpan.style.color = 'var(--accent)';
      pageSpan.textContent = `★ ${bm.pageLabel || `Side ${bm.pageIndex + 1}`}`;
      info.appendChild(pageSpan);

      if (bm.note) {
        const noteSpan = document.createElement('span');
        noteSpan.className = 'bookmark-note';
        noteSpan.textContent = bm.note;
        info.appendChild(noteSpan);
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-icon btn-sm bm-del-btn';
      delBtn.title = 'Slett bokmerke';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteBookmark(bm.id);
      });

      item.append(info, delBtn);
      item.addEventListener('click', () => {
        goToPage(bm.pageIndex);
      });

      el.bookmarksList.appendChild(item);
    });
  }

  function renderScrubberTicks() {
    const book = state.activeBook;
    el.scrubberBookmarks.replaceChildren();
    if (!book || book.totalPages <= 1) return;

    (book.chapters || []).forEach((ch) => {
      const pct = (ch.pageIndex / (book.totalPages - 1)) * 100;
      const tick = document.createElement('div');
      tick.className = 'scrubber-ch-tick';
      tick.style.left = `${pct}%`;
      tick.title = ch.title;
      el.scrubberBookmarks.appendChild(tick);
    });

    (book.bookmarks || []).forEach((bm) => {
      const pct = (bm.pageIndex / (book.totalPages - 1)) * 100;
      const tick = document.createElement('div');
      tick.className = 'scrubber-bm-tick';
      tick.style.left = `${pct}%`;
      tick.title = bm.note ? `${bm.pageLabel}: ${bm.note}` : bm.pageLabel;
      el.scrubberBookmarks.appendChild(tick);
    });
  }

  // ======================== SETTINGS & ADMIN PANEL ========================
  function switchAdminTab(tabName) {
    state.activeAdminTab = tabName;
    document.querySelectorAll('[data-admin-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.adminTab === tabName);
    });
    document.getElementById('admin-pane-books').classList.toggle('active', tabName === 'books');
    document.getElementById('admin-pane-users').classList.toggle('active', tabName === 'users');
    document.getElementById('admin-pane-security').classList.toggle('active', tabName === 'security');
  }

  async function openSettingsModal() {
    el.settingsModal.classList.remove('hidden');
    if (!state.isAdmin) {
      el.settingsUserView.classList.remove('hidden');
      el.settingsAdminView.classList.add('hidden');
      return;
    }

    el.settingsUserView.classList.add('hidden');
    el.settingsAdminView.classList.remove('hidden');
    switchAdminTab(state.activeAdminTab || 'books');
    await refreshAdminOverview();
  }

  async function refreshAdminOverview() {
    try {
      const overview = await apiGet('/api/admin/overview');
      state.adminOverview = overview;
      renderAdminBooksList(overview.books || []);
      renderAdminUsersList(overview.profiles || [], overview.books || []);
      renderAdminSecurityPane(overview);
    } catch (err) {
      console.error('Kunne ikke laste admin-oversikt:', err);
    }
  }

  function renderAdminBooksList(books) {
    el.adminBooksList.replaceChildren();
    if (books.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'form-help';
      empty.textContent = 'Ingen bøker funnet i biblioteket.';
      el.adminBooksList.appendChild(empty);
      return;
    }

    books.forEach((book) => {
      const row = document.createElement('div');
      row.className = 'admin-book-row';

      const top = document.createElement('div');
      top.className = 'admin-book-top';

      const meta = document.createElement('div');
      meta.className = 'admin-book-meta';
      meta.textContent = `Mappe/fil: ${book.id} · ${String(book.format || 'images').toUpperCase()} · ${book.totalPages} sider`;

      const adminOnlyLabel = document.createElement('label');
      adminOnlyLabel.className = 'admin-checkbox-label';
      const adminOnlyCb = document.createElement('input');
      adminOnlyCb.type = 'checkbox';
      adminOnlyCb.checked = Boolean(book.adminOnly);
      const adminOnlyTxt = document.createElement('span');
      adminOnlyTxt.textContent = 'Kun admin';
      adminOnlyLabel.append(adminOnlyCb, adminOnlyTxt);

      top.append(meta, adminOnlyLabel);

      const inputRow = document.createElement('div');
      inputRow.className = 'input-row';

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.maxLength = 140;
      titleInput.value = book.customTitle || book.title;
      titleInput.placeholder = book.originalTitle || book.id;

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-primary btn-sm';
      saveBtn.textContent = 'Lagre navn';

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'btn btn-sm';
      resetBtn.textContent = 'Tilbakestill';
      resetBtn.disabled = !book.customTitle;

      const statusEl = document.createElement('span');
      statusEl.className = 'admin-inline-note hidden';

      inputRow.append(titleInput, saveBtn, resetBtn);
      row.append(top, inputRow, statusEl);

      const saveBookMetaChange = async (payload, okMsg) => {
        try {
          const updated = await apiPost(`/api/books/${encodeURIComponent(book.id)}/meta`, payload);
          statusEl.textContent = okMsg;
          statusEl.style.color = 'var(--accent)';
          statusEl.classList.remove('hidden');
          resetBtn.disabled = !updated.customTitle;
          await Promise.all([refreshAdminOverview(), loadLibrary()]);
        } catch (err) {
          statusEl.textContent = `Feil: ${err.message}`;
          statusEl.style.color = '#f85149';
          statusEl.classList.remove('hidden');
        }
      };

      saveBtn.addEventListener('click', () => {
        saveBookMetaChange({ title: titleInput.value.trim() }, 'Visningsnavn lagret');
      });

      resetBtn.addEventListener('click', () => {
        saveBookMetaChange({ title: '' }, 'Tilbakestilt til originalt navn');
      });

      adminOnlyCb.addEventListener('change', () => {
        saveBookMetaChange(
          { adminOnly: adminOnlyCb.checked },
          adminOnlyCb.checked ? 'Kun synlig for admin' : 'Synlig for vanlige brukere'
        );
      });

      el.adminBooksList.appendChild(row);
    });
  }

  function renderAdminUsersList(profiles, books) {
    el.adminUsersList.replaceChildren();
    const adminCount = profiles.filter((p) => p.isAdmin).length;

    profiles.forEach((prof) => {
      const card = document.createElement('div');
      card.className = 'admin-user-card';

      const top = document.createElement('div');
      top.className = 'admin-user-top';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'admin-user-title';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = prof.name;
      titleWrap.appendChild(nameSpan);

      const adminLabel = document.createElement('label');
      adminLabel.className = 'admin-checkbox-label';
      const adminCb = document.createElement('input');
      adminCb.type = 'checkbox';
      adminCb.checked = Boolean(prof.isAdmin);
      adminCb.disabled = Boolean(prof.isAdmin && adminCount <= 1);
      const adminTxt = document.createElement('span');
      adminTxt.textContent = 'Admin';
      adminLabel.append(adminCb, adminTxt);

      top.append(titleWrap, adminLabel);
      card.appendChild(top);

      const statusEl = document.createElement('span');
      statusEl.className = 'admin-inline-note hidden';

      const updateProfileAccess = async (payload, okMsg) => {
        try {
          await apiPut(`/api/admin/profiles/${encodeURIComponent(prof.id)}/access`, payload);
          statusEl.textContent = okMsg;
          statusEl.style.color = 'var(--accent)';
          statusEl.classList.remove('hidden');
          await refreshAdminOverview();
          await loadProfiles(true, true);
          if (state.activeProfileId === prof.id && el.shelfScreen.classList.contains('active')) {
            await loadLibrary();
          }
        } catch (err) {
          statusEl.textContent = `Feil: ${err.message}`;
          statusEl.style.color = '#f85149';
          statusEl.classList.remove('hidden');
          adminCb.checked = Boolean(prof.isAdmin);
        }
      };

      adminCb.addEventListener('change', () => {
        updateProfileAccess(
          { isAdmin: adminCb.checked },
          adminCb.checked ? 'Admin-tilgang aktivert' : 'Admin-tilgang fjernet'
        );
      });

      if (prof.isAdmin) {
        const pwdRow = document.createElement('div');
        pwdRow.className = 'input-row';
        const pwdInput = document.createElement('input');
        pwdInput.type = 'password';
        pwdInput.placeholder = prof.hasPersonalAdminPassword
          ? 'Endre personlig admin-passord...'
          : 'Sett personlig admin-passord (valgfritt)...';
        pwdInput.autocomplete = 'new-password';

        const setPwdBtn = document.createElement('button');
        setPwdBtn.type = 'button';
        setPwdBtn.className = 'btn btn-sm';
        setPwdBtn.textContent = 'Sett';
        setPwdBtn.addEventListener('click', () => {
          const val = pwdInput.value;
          if (!val) return;
          updateProfileAccess({ adminPassword: val }, 'Personlig admin-passord oppdatert');
          pwdInput.value = '';
        });

        pwdRow.append(pwdInput, setPwdBtn);

        if (prof.hasPersonalAdminPassword) {
          const clearPwdBtn = document.createElement('button');
          clearPwdBtn.type = 'button';
          clearPwdBtn.className = 'btn btn-sm';
          clearPwdBtn.textContent = 'Fjern';
          clearPwdBtn.addEventListener('click', () => {
            updateProfileAccess({ clearAdminPassword: true }, 'Personlig admin-passord fjernet');
          });
          pwdRow.appendChild(clearPwdBtn);
        }

        card.appendChild(pwdRow);
      }

      if (books.length > 0) {
        const hiddenWrap = document.createElement('div');
        hiddenWrap.className = 'admin-hidden-books-wrap';

        const hiddenLabel = document.createElement('span');
        hiddenLabel.className = 'admin-inline-note';
        hiddenLabel.textContent = 'Skjulte bøker for denne kontoen (huk av for å skjule):';
        hiddenWrap.appendChild(hiddenLabel);

        const grid = document.createElement('div');
        grid.className = 'admin-hidden-books-grid';
        const hiddenSet = new Set(Array.isArray(prof.hiddenBooks) ? prof.hiddenBooks : []);

        books.forEach((b) => {
          const lbl = document.createElement('label');
          lbl.className = 'admin-checkbox-label';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = hiddenSet.has(b.id);
          cb.addEventListener('change', () => {
            if (cb.checked) hiddenSet.add(b.id);
            else hiddenSet.delete(b.id);
            updateProfileAccess(
              { hiddenBooks: Array.from(hiddenSet) },
              'Synlighet oppdatert'
            );
          });
          const txt = document.createElement('span');
          txt.textContent = b.title;
          lbl.append(cb, txt);
          grid.appendChild(lbl);
        });

        hiddenWrap.appendChild(grid);
        card.appendChild(hiddenWrap);
      }

      card.appendChild(statusEl);
      el.adminUsersList.appendChild(card);
    });
  }

  function renderAdminSecurityPane(overview) {
    el.inputNewReaderPassword.disabled = Boolean(overview.passwordLockedByEnv);
    el.readerPwdEnvNote.classList.toggle('hidden', !overview.passwordLockedByEnv);
    el.inputNewGlobalAdminPassword.disabled = Boolean(overview.adminPasswordLockedByEnv);
    el.adminPwdEnvNote.classList.toggle('hidden', !overview.adminPasswordLockedByEnv);
    el.btnSaveAdminPasswords.disabled =
      Boolean(overview.passwordLockedByEnv && overview.adminPasswordLockedByEnv);

    el.lanUrlsList.replaceChildren();
    const info = overview.serverInfo;
    const port = (info && info.port) || 3000;
    const ips = (info && info.lanIps) || [];
    if (ips.length > 0) {
      ips.forEach((ip) => {
        const line = document.createElement('div');
        line.textContent = `http://${ip}:${port}`;
        el.lanUrlsList.appendChild(line);
      });
    } else {
      const line = document.createElement('div');
      line.textContent = `http://localhost:${port}`;
      el.lanUrlsList.appendChild(line);
    }
  }

  async function saveAdminPasswords() {
    const readerPassword = el.inputNewReaderPassword.value;
    const adminPassword = el.inputNewGlobalAdminPassword.value;
    if (!readerPassword && !adminPassword) {
      el.adminPasswordsStatus.textContent = 'Skriv inn minst ett nytt passord.';
      el.adminPasswordsStatus.style.color = 'var(--text-secondary)';
      el.adminPasswordsStatus.classList.remove('hidden');
      return;
    }

    try {
      await apiPost('/api/admin/passwords', {
        ...(readerPassword ? { readerPassword } : {}),
        ...(adminPassword ? { adminPassword } : {})
      });
      el.inputNewReaderPassword.value = '';
      el.inputNewGlobalAdminPassword.value = '';
      el.adminPasswordsStatus.textContent = 'Passord oppdatert!';
      el.adminPasswordsStatus.style.color = 'var(--accent)';
      el.adminPasswordsStatus.classList.remove('hidden');
    } catch (err) {
      el.adminPasswordsStatus.textContent = `Feil: ${err.message}`;
      el.adminPasswordsStatus.style.color = '#f85149';
      el.adminPasswordsStatus.classList.remove('hidden');
    }
  }

  // ======================== EVENT LISTENERS ========================
  el.btnPasswordSubmit.addEventListener('click', submitPassword);
  el.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPassword();
  });

  // Profile events
  el.btnManageProfiles.addEventListener('click', () => {
    state.manageProfilesMode = !state.manageProfilesMode;
    renderProfileSelector();
  });

  el.btnProfileAdminUnlock.addEventListener('click', () => {
    if (state.isAdmin) {
      lockAdminMode();
    } else {
      openAdminLoginModal(null);
    }
  });

  el.btnLogoutProfileScreen.addEventListener('click', logoutSession);

  // Admin Login modal events
  el.btnCloseAdminLogin.addEventListener('click', () => {
    state.pendingAdminAction = null;
    el.adminLoginModal.classList.add('hidden');
  });
  el.btnCancelAdminLogin.addEventListener('click', () => {
    state.pendingAdminAction = null;
    el.adminLoginModal.classList.add('hidden');
  });
  el.adminLoginModal.addEventListener('click', (e) => {
    if (e.target === el.adminLoginModal) {
      state.pendingAdminAction = null;
      el.adminLoginModal.classList.add('hidden');
    }
  });
  el.btnSubmitAdminLogin.addEventListener('click', submitAdminLogin);
  el.inputAdminPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAdminLogin();
  });

  el.btnSwitchProfile.addEventListener('click', () => {
    loadProfiles(true);
  });

  el.btnCloseProfileModal.addEventListener('click', () => el.profileModal.classList.add('hidden'));
  el.btnCancelProfile.addEventListener('click', () => el.profileModal.classList.add('hidden'));
  el.btnSaveProfile.addEventListener('click', saveProfileFromModal);
  el.btnDeleteProfile.addEventListener('click', deleteEditingProfile);

  el.inputProfileName.addEventListener('input', refreshProfileModalPreview);
  el.inputProfileName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveProfileFromModal();
  });

  el.inputProfileAvatar.addEventListener('change', async () => {
    const file = el.inputProfileAvatar.files && el.inputProfileAvatar.files[0];
    if (!file) return;
    try {
      state.draftProfileAvatar = await resizeImageFileToDataUrl(file, 240);
      refreshProfileModalPreview();
    } catch (err) {
      console.error('Feil ved bildeopplasting:', err);
    }
  });

  el.btnClearAvatar.addEventListener('click', () => {
    state.draftProfileAvatar = '';
    el.inputProfileAvatar.value = '';
    refreshProfileModalPreview();
  });

  el.profileColorSwatches.querySelectorAll('.color-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.draftProfileColor = btn.dataset.color;
      refreshProfileModalPreview();
    });
  });

  // Search
  el.searchInput.addEventListener('input', () => {
    state.searchQuery = el.searchInput.value;
    applyFilterAndRender();
  });

  // Shelf view mode toggle
  document.querySelectorAll('[data-shelf-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.shelfView;
      savePreferences({ shelfView: view });
      syncTopbarControls();
      applyFilterAndRender();
    });
  });

  // Grid cover type toggle
  document.querySelectorAll('[data-grid-cover]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.gridCover;
      savePreferences({ gridCoverMode: mode });
      syncTopbarControls();
      renderGridView();
    });
  });

  // Filter tabs
  document.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilterAndRender();
    });
  });

  // Rygg Carousel buttons & wheel/touch
  el.carouselPrev.addEventListener('click', () => stepCarousel(-1));
  el.carouselNext.addEventListener('click', () => stepCarousel(1));

  el.carouselOpenBtn.addEventListener('click', () => {
    const book = state.filteredBooks[state.carouselIndex];
    if (book) openBook(book.id);
  });

  el.carouselBookmarksBtn.addEventListener('click', () => {
    const book = state.filteredBooks[state.carouselIndex];
    if (book) openBook(book.id, true);
  });

  if (el.btnScaleDown) {
    el.btnScaleDown.addEventListener('click', (e) => {
      e.stopPropagation();
      const book = state.filteredBooks[state.carouselIndex];
      if (book) adjustBookSizeScale(book, -0.05);
    });
  }
  if (el.btnScaleUp) {
    el.btnScaleUp.addEventListener('click', (e) => {
      e.stopPropagation();
      const book = state.filteredBooks[state.carouselIndex];
      if (book) adjustBookSizeScale(book, 0.05);
    });
  }
  if (el.btnReaderScaleDown) {
    el.btnReaderScaleDown.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.activeBook) adjustBookSizeScale(state.activeBook, -0.05);
    });
  }
  if (el.btnReaderScaleUp) {
    el.btnReaderScaleUp.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.activeBook) adjustBookSizeScale(state.activeBook, 0.05);
    });
  }

  el.spineStage.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) > 10 || Math.abs(e.deltaX) > 10) {
        e.preventDefault();
        const delta = (e.deltaY || e.deltaX) > 0 ? 1 : -1;
        stepCarousel(delta);
      }
    },
    { passive: false }
  );

  let carouselTouchStartX = 0;
  el.spineStage.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) {
        carouselTouchStartX = e.touches[0].clientX;
      }
    },
    { passive: true }
  );

  el.spineStage.addEventListener(
    'touchend',
    (e) => {
      if (e.changedTouches.length === 1) {
        const dx = e.changedTouches[0].clientX - carouselTouchStartX;
        if (Math.abs(dx) > 36) {
          stepCarousel(dx < 0 ? 1 : -1);
        }
      }
    },
    { passive: true }
  );

  window.addEventListener('resize', () => {
    if (state.preferences.shelfView === 'spine' && !state.activeBook) {
      updateSpineCarouselSelection();
    }
  });

  // Refresh & Settings / Admin Panel
  el.btnRefresh.addEventListener('click', loadLibrary);
  el.btnSettings.addEventListener('click', openSettingsModal);
  el.btnEmptySettings.addEventListener('click', openSettingsModal);
  el.btnCloseSettings.addEventListener('click', () => el.settingsModal.classList.add('hidden'));
  el.settingsModal.addEventListener('click', (e) => {
    if (e.target === el.settingsModal) el.settingsModal.classList.add('hidden');
  });

  el.btnSettingsAdminUnlock.addEventListener('click', () => {
    openAdminLoginModal({ type: 'open-settings' });
  });
  el.btnSettingsUserLogout.addEventListener('click', logoutSession);
  el.btnSettingsAdminLogout.addEventListener('click', logoutSession);
  el.btnAdminLock.addEventListener('click', lockAdminMode);
  el.btnSaveAdminPasswords.addEventListener('click', saveAdminPasswords);

  document.querySelectorAll('[data-admin-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchAdminTab(btn.dataset.adminTab));
  });

  if (el.inputUploadEbook) {
    el.inputUploadEbook.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      el.ebookUploadStatus.textContent = `Laster opp ${files.length} fil(er)...`;
      el.ebookUploadStatus.style.color = 'var(--text-secondary)';
      el.ebookUploadStatus.classList.remove('hidden');

      let successCount = 0;
      for (const file of files) {
        try {
          const uploadFile = async (overwrite = false) => {
            const headers = {
              'Content-Type': 'application/octet-stream',
              'X-Requested-With': 'fetch',
              'X-Filename': encodeURIComponent(file.name)
            };
            if (overwrite) headers['X-Overwrite'] = 'true';
            return fetch('/api/upload-ebook', {
              method: 'POST',
              credentials: 'same-origin',
              headers,
              body: file
            });
          };

          let res = await uploadFile(false);
          if (res.status === 409) {
            if (window.confirm(`"${file.name}" finnes allerede. Vil du overskrive den?`)) {
              res = await uploadFile(true);
            } else {
              continue;
            }
          }
          const json = await parseJsonSafe(res);
          if (!res.ok) {
            throw new Error((json && json.error) || `HTTP ${res.status}`);
          }
          successCount++;
        } catch (err) {
          console.error('Upload failed:', err);
          el.ebookUploadStatus.textContent = `Feil: ${err.message}`;
          el.ebookUploadStatus.style.color = '#f85149';
        }
      }

      el.inputUploadEbook.value = '';
      if (successCount > 0) {
        el.ebookUploadStatus.textContent = `Lastet opp ${successCount} e-bok/PDF! Oppdaterer biblioteket...`;
        el.ebookUploadStatus.style.color = 'var(--accent)';
        await Promise.all([loadLibrary(), refreshAdminOverview()]);
        el.ebookUploadStatus.textContent = `Ferdig! ${successCount} bok/bøker lagt til i biblioteket.`;
      }
    });
  }

  // Export Modal events
  el.btnOpenExport.addEventListener('click', openExportModal);
  el.btnCloseExport.addEventListener('click', () => el.exportModal.classList.add('hidden'));
  el.exportModal.addEventListener('click', (e) => {
    if (e.target === el.exportModal) el.exportModal.classList.add('hidden');
  });
  el.exportFromInput.addEventListener('input', updateExportSummary);
  el.exportToInput.addEventListener('input', updateExportSummary);

  el.btnPresetCurrent.addEventListener('click', () => {
    const visibleIndices = getSpreadPageIndices(state.currentPageIndex);
    el.exportFromInput.value = String(visibleIndices[0] + 1);
    el.exportToInput.value = String(visibleIndices[visibleIndices.length - 1] + 1);
    updateExportSummary();
  });

  el.btnPresetChapter.addEventListener('click', () => {
    const book = state.activeBook;
    if (!book) return;
    const chs = book.chapters || [];
    const activeCh = getActiveChapterForPage(state.currentPageIndex);
    if (!activeCh) return;
    const chIdx = chs.findIndex((c) => c.id === activeCh.id);
    const nextCh = chIdx !== -1 && chIdx + 1 < chs.length ? chs[chIdx + 1] : null;
    const startPage = activeCh.pageIndex + 1;
    const endPage = nextCh ? Math.max(startPage, nextCh.pageIndex) : book.totalPages;
    el.exportFromInput.value = String(startPage);
    el.exportToInput.value = String(endPage);
    updateExportSummary();
  });

  el.btnPresetAll.addEventListener('click', () => {
    if (!state.activeBook) return;
    el.exportFromInput.value = '1';
    el.exportToInput.value = String(state.activeBook.totalPages);
    updateExportSummary();
  });

  el.btnExportPdf.addEventListener('click', () => triggerExportDownload('pdf'));
  el.btnExportZip.addEventListener('click', () => triggerExportDownload('zip'));

  // Reader navigation controls
  el.btnBackShelf.addEventListener('click', closeReader);
  el.zonePrev.addEventListener('click', (e) => {
    e.stopPropagation();
    stepPage(-1);
  });
  el.zoneNext.addEventListener('click', (e) => {
    e.stopPropagation();
    stepPage(1);
  });
  el.btnPrevPage.addEventListener('click', () => stepPage(-1));
  el.btnNextPage.addEventListener('click', () => stepPage(1));

  el.pageScrubber.addEventListener('input', () => {
    const idx = parseInt(el.pageScrubber.value, 10);
    goToPage(idx);
  });

  el.readerChapterBadge.addEventListener('click', () => {
    if (isDrawerOpen() && state.drawerTab === 'chapters') {
      setDrawerOpen(false);
    } else {
      setDrawerOpen(true, 'chapters');
    }
  });

  el.btnViewOptions.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = el.viewOptionsPopover.classList.toggle('hidden');
    el.btnViewOptions.classList.toggle('active', !isHidden);
  });

  document.addEventListener('click', (e) => {
    if (
      !el.viewOptionsPopover.classList.contains('hidden') &&
      !el.viewOptionsPopover.contains(e.target) &&
      !el.btnViewOptions.contains(e.target)
    ) {
      el.viewOptionsPopover.classList.add('hidden');
      el.btnViewOptions.classList.remove('active');
    }
  });

  document.querySelectorAll('[data-reader-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.readerMode;
      state.effectiveReaderMode = mode;
      savePreferences({ readerMode: mode });
      syncReaderToolbar();
      if (mode === 'vertical') {
        renderVerticalReader();
      } else {
        if (verticalObserver) verticalObserver.disconnect();
        renderPagedReader();
      }
    });
  });

  el.btnSpreadOffset.addEventListener('click', toggleBookForsatsAlene);
  el.btnZoomReset.addEventListener('click', () => resetZoom(true));
  el.readerStage.addEventListener('wheel', zoomByWheel, { passive: false });

  el.readerStage.addEventListener('pointerdown', (e) => {
    if (e.target === el.zonePrev || e.target === el.zoneNext) return;
    if (e.button !== 0) return;
    state.isDraggingPan = true;
    state.dragMoved = false;
    state.dragStartX = e.clientX - state.panX;
    state.dragStartY = e.clientY - state.panY;
    if (state.zoomScale > 1.01) {
      el.readerStage.classList.add('is-dragging');
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!state.isDraggingPan) return;
    const newPanX = e.clientX - state.dragStartX;
    const newPanY = e.clientY - state.dragStartY;
    if (Math.abs(newPanX - state.panX) > 4 || Math.abs(newPanY - state.panY) > 4) {
      state.dragMoved = true;
    }
    if (state.zoomScale > 1.01) {
      state.panX = newPanX;
      state.panY = newPanY;
      applyZoomTransform();
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (!state.isDraggingPan) return;
    state.isDraggingPan = false;
    el.readerStage.classList.remove('is-dragging');

    if (!state.dragMoved && e.target !== el.zonePrev && e.target !== el.zoneNext) {
      toggleBarsHidden();
    }
  });

  el.readerStage.addEventListener('dblclick', (e) => {
    if (e.target === el.zonePrev || e.target === el.zoneNext) return;
    if (state.zoomScale > 1.05) {
      resetZoom(true);
    } else {
      const rect = el.readerStage.getBoundingClientRect();
      const cursorX = e.clientX - (rect.left + rect.width / 2);
      const cursorY = e.clientY - (rect.top + rect.height / 2);
      state.zoomScale = 2.0;
      state.panX = -cursorX;
      state.panY = -cursorY;
      setBarsHidden(true);
      applyZoomTransform();
    }
  });

  document.querySelectorAll('[data-drawer-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.drawerTab;
      state.drawerTab = tab;
      el.tabBtnChapters.classList.toggle('active', tab === 'chapters');
      el.tabBtnBookmarks.classList.toggle('active', tab === 'bookmarks');
      el.drawerPaneChapters.classList.toggle('active', tab === 'chapters');
      el.drawerPaneBookmarks.classList.toggle('active', tab === 'bookmarks');
    });
  });

  el.btnBookmarkToggle.addEventListener('click', toggleBookmarkOnCurrentPage);
  el.btnBookmarksDrawer.addEventListener('click', () => {
    setDrawerOpen(!isDrawerOpen());
  });
  el.btnCloseDrawer.addEventListener('click', () => {
    setDrawerOpen(false);
  });
  el.btnSaveChapter.addEventListener('click', saveChapterOnCurrentPage);
  el.chapterTitleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveChapterOnCurrentPage();
  });
  el.btnSaveBookmarkNote.addEventListener('click', saveBookmarkWithNote);
  el.bookmarkNoteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBookmarkWithNote();
  });

  el.btnFullscreen.addEventListener('click', toggleFullscreen);
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  let readerTouchStartX = 0;
  let readerTouchStartY = 0;
  el.readerStage.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1 && state.zoomScale <= 1.02) {
        readerTouchStartX = e.touches[0].clientX;
        readerTouchStartY = e.touches[0].clientY;
      }
    },
    { passive: true }
  );

  el.readerStage.addEventListener(
    'touchend',
    (e) => {
      if (
        e.changedTouches.length === 1 &&
        state.effectiveReaderMode !== 'vertical' &&
        state.zoomScale <= 1.02
      ) {
        const dx = e.changedTouches[0].clientX - readerTouchStartX;
        const dy = e.changedTouches[0].clientY - readerTouchStartY;
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          stepPage(dx < 0 ? 1 : -1);
        }
      }
    },
    { passive: true }
  );

  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement ? document.activeElement.tagName : '';
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA';

    if (isInput) {
      if (e.key === 'Escape') {
        document.activeElement.blur();
      }
      return;
    }

    if (
      el.passwordScreen.classList.contains('active') ||
      el.profileScreen.classList.contains('active')
    ) {
      return;
    }

    if (!state.activeBook) {
      if (e.key === '/') {
        e.preventDefault();
        el.searchInput.focus();
      } else if (state.preferences.shelfView === 'spine') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          stepCarousel(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          stepCarousel(1);
        } else if (e.key === 'Enter') {
          const book = state.filteredBooks[state.carouselIndex];
          if (book) openBook(book.id);
        }
      }
      return;
    }

    if (e.key === 'Escape') {
      if (!el.exportModal.classList.contains('hidden')) {
        el.exportModal.classList.add('hidden');
      } else if (state.zoomScale > 1.05) {
        resetZoom(true);
      } else if (!el.viewOptionsPopover.classList.contains('hidden')) {
        el.viewOptionsPopover.classList.add('hidden');
        el.btnViewOptions.classList.remove('active');
      } else if (isDrawerOpen()) {
        setDrawerOpen(false);
      } else {
        closeReader();
      }
    } else if (e.key === '0') {
      resetZoom(true);
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D' || e.key === ' ') {
      if (state.effectiveReaderMode !== 'vertical') {
        e.preventDefault();
        stepPage(1);
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      if (state.effectiveReaderMode !== 'vertical') {
        e.preventDefault();
        stepPage(-1);
      }
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      toggleBookmarkOnCurrentPage();
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      setDrawerOpen(!isDrawerOpen());
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      toggleBarsHidden();
    } else if (e.key === '1') {
      document.querySelector('[data-reader-mode="single"]').click();
    } else if (e.key === '2') {
      document.querySelector('[data-reader-mode="spread"]').click();
    } else if (e.key === '3') {
      document.querySelector('[data-reader-mode="vertical"]').click();
    }
  });

  checkAuthAndBoot();
})();
