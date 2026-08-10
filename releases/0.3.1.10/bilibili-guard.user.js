// ==UserScript==
// @name         B站大航海详情
// @namespace    https://github.com/EchoXiaoze/bilibili-guard-extension
// @version      0.3.1.10
// @description  在B站视频页和个人空间按需显示当前创作者的大航海详情。
// @match        https://www.bilibili.com/video/*
// @match        https://space.bilibili.com/*
// @connect      api.bilibili.com
// @connect      api.live.bilibili.com
// @connect      127.0.0.1
// @connect      echoxiaoze.github.io
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_getResourceURL
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @resource     guardFrameCaptain https://echoxiaoze.github.io/bilibili-guard-extension-dist/assets/frames/captain.png#sha256=adc6dfa31e752bcb12c792d5bdeac67f822ce854b899806c5bab4dbd3b433c34
// @resource     guardFrameAdmiral https://echoxiaoze.github.io/bilibili-guard-extension-dist/assets/frames/admiral.png#sha256=54237824da6540cdf77c8df1ecf373f9440c83ad7d457388134d2de67303407f
// @resource     guardFrameGovernor https://echoxiaoze.github.io/bilibili-guard-extension-dist/assets/frames/governor.png#sha256=240d61edc2a17b7909c488b69a497ad4437699d1a86539bfb5c7838bf25e7a39
// @updateURL    https://echoxiaoze.github.io/bilibili-guard-extension-dist/userscript/bilibili-guard.meta.js
// @downloadURL  https://echoxiaoze.github.io/bilibili-guard-extension-dist/userscript/bilibili-guard.user.js
// @run-at       document-idle
// ==/UserScript==

// Source: src/shared/namespace.js
(() => {
  if (globalThis.__BILIBILI_GUARD__) return;

  Object.defineProperty(globalThis, '__BILIBILI_GUARD__', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.create(null),
  });
})();

// Source: src/shared/contracts.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime) throw new Error('Bilibili guard namespace is not initialized');

  const ERROR_CODES = new Set([
    'unsupported_page',
    'invalid_identity',
    'creator_lookup_failed',
    'no_live_room',
    'guard_lookup_failed',
    'risk_controlled',
    'request_timeout',
    'details_incomplete',
    'details_too_large',
    'cooldown',
    'update_manifest_invalid',
  ]);
  const MESSAGE_TYPES = new Set([
    'guard.summary.get',
    'guard.details.get',
    'guard.refresh',
  ]);
  const MAX_SAFE_ID = BigInt(Number.MAX_SAFE_INTEGER);

  function createError(code, properties = {}) {
    const safeCode = ERROR_CODES.has(code) ? code : 'guard_lookup_failed';
    const error = new Error(safeCode);
    error.code = safeCode;
    if (Number.isSafeInteger(properties.retryAfterMs) && properties.retryAfterMs > 0) {
      error.retryAfterMs = properties.retryAfterMs;
    }
    return error;
  }

  function normalizeUid(value) {
    const text = typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : value;
    if (typeof text !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(text)) return null;
    try {
      return BigInt(text) <= MAX_SAFE_ID ? text : null;
    } catch {
      return null;
    }
  }

  function normalizePositiveInteger(value, {allowZero = false} = {}) {
    const number = typeof value === 'string' && /^[0-9]+$/u.test(value)
      ? Number(value)
      : value;
    if (!Number.isSafeInteger(number)) return null;
    if (allowZero ? number < 0 : number <= 0) return null;
    return number;
  }

  function normalizeHttpsUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function normalizeBvid(value) {
    return typeof value === 'string' && /^BV[0-9A-Za-z]{10}$/u.test(value)
      ? value
      : null;
  }

  function parsePageUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }

    if (url.origin === 'https://www.bilibili.com') {
      const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/u);
      if (!match) return null;
      return {kind: 'video', bvid: match[1], key: `video:${match[1]}`};
    }

    if (url.origin === 'https://space.bilibili.com') {
      const match = url.pathname.match(/^\/([1-9][0-9]{0,19})(?:\/|$)/u);
      const uid = match ? normalizeUid(match[1]) : null;
      if (!uid) return null;
      return {kind: 'space', uid, key: `space:${uid}`};
    }

    return null;
  }

  function normalizeContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw createError('invalid_identity');
    }
    if (value.kind === 'video') {
      const bvid = normalizeBvid(value.bvid);
      const key = bvid ? `video:${bvid}` : null;
      if (!bvid || value.key !== key) throw createError('invalid_identity');
      return {kind: 'video', bvid, key};
    }
    if (value.kind === 'space') {
      const uid = normalizeUid(value.uid);
      const key = uid ? `space:${uid}` : null;
      if (!uid || value.key !== key) throw createError('invalid_identity');
      return {kind: 'space', uid, key};
    }
    throw createError('invalid_identity');
  }

  function normalizeRequest(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw createError('invalid_identity');
    }
    if (!MESSAGE_TYPES.has(message.type)) throw createError('invalid_identity');
    if (
      typeof message.requestId !== 'string'
      || message.requestId.length < 1
      || message.requestId.length > 128
      || /[\u0000-\u001f\u007f]/u.test(message.requestId)
    ) {
      throw createError('invalid_identity');
    }
    if (!Number.isSafeInteger(message.pageGeneration) || message.pageGeneration < 0) {
      throw createError('invalid_identity');
    }
    if (typeof message.force !== 'boolean') throw createError('invalid_identity');
    if (message.type === 'guard.refresh' && typeof message.detailsOpen !== 'boolean') {
      throw createError('invalid_identity');
    }

    const normalized = {
      type: message.type,
      requestId: message.requestId,
      pageGeneration: message.pageGeneration,
      context: normalizeContext(message.context),
      force: message.force,
    };
    if (message.type === 'guard.refresh') normalized.detailsOpen = message.detailsOpen;
    return normalized;
  }

  function safeError(error, request = {}) {
    const code = ERROR_CODES.has(error?.code) ? error.code : 'guard_lookup_failed';
    const requestId = typeof request.requestId === 'string' && request.requestId.length > 0
      ? request.requestId
      : null;
    const pageGeneration = Number.isSafeInteger(request.pageGeneration) && request.pageGeneration >= 0
      ? request.pageGeneration
      : 0;
    const payload = {
      ok: false,
      requestId,
      pageGeneration,
      error: {code},
    };
    if (code === 'cooldown' && Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs > 0) {
      payload.error.retryAfterMs = error.retryAfterMs;
    }
    return payload;
  }

  runtime.contracts = Object.freeze({
    ERROR_CODES,
    createError,
    normalizeUid,
    normalizePositiveInteger,
    normalizeHttpsUrl,
    normalizeBvid,
    parsePageUrl,
    normalizeContext,
    normalizeRequest,
    safeError,
  });
})();

// Source: src/shared/guard-data.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime?.contracts) throw new Error('Bilibili guard contracts are not initialized');

  const {createError, normalizeHttpsUrl, normalizePositiveInteger, normalizeUid} = runtime.contracts;
  const TIERS = Object.freeze({
    1: Object.freeze({name: '总督', frame: 'governor.png', level: 1}),
    2: Object.freeze({name: '提督', frame: 'admiral.png', level: 2}),
    3: Object.freeze({name: '舰长', frame: 'captain.png', level: 3}),
  });

  function guardTier(value) {
    const level = normalizePositiveInteger(value, {allowZero: true});
    return TIERS[level] ?? {name: '未知等级', frame: null, level};
  }

  function boundedText(value, maximum, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const text = value.trim();
    return text ? text.slice(0, maximum) : fallback;
  }

  function optionalInteger(value, {positive = false} = {}) {
    if (value === null || value === undefined || value === '') return null;
    return normalizePositiveInteger(value, {allowZero: !positive});
  }

  function normalizeMember(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const uid = normalizeUid(raw.uid);
    if (!uid) return null;
    const medal = raw.medal_info && typeof raw.medal_info === 'object'
      ? raw.medal_info
      : {};
    return {
      uid,
      nickname: boundedText(raw.username, 120, `UID ${uid}`),
      avatar: normalizeHttpsUrl(raw.face),
      rank: optionalInteger(raw.rank, {positive: true}),
      guardLevel: optionalInteger(raw.guard_level) ?? 0,
      guardSubLevel: optionalInteger(raw.guard_sub_level) ?? 0,
      medalName: boundedText(medal.medal_name, 60),
      medalLevel: optionalInteger(medal.medal_level) ?? 0,
    };
  }

  function normalizeGuardPage(payload, pageNumber) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw createError('guard_lookup_failed');
    }
    const info = payload.info;
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      throw createError('guard_lookup_failed');
    }
    const total = normalizePositiveInteger(info.num, {allowZero: true});
    const pageCount = normalizePositiveInteger(info.page, {allowZero: true});
    const normalizedPageNumber = normalizePositiveInteger(pageNumber);
    if (
      total === null
      || pageCount === null
      || normalizedPageNumber === null
      || (total > 0 && pageCount === 0)
      || (pageCount > 0 && normalizedPageNumber > pageCount)
      || !Array.isArray(payload.top3)
      || !Array.isArray(payload.list)
    ) {
      throw createError('guard_lookup_failed');
    }
    return {
      total,
      pageCount,
      pageNumber: normalizedPageNumber,
      top3: payload.top3.map(normalizeMember).filter(Boolean),
      members: payload.list.map(normalizeMember).filter(Boolean),
    };
  }

  function memberScore(member) {
    return (member.rank === null ? 0 : 8)
      + (member.avatar ? 4 : 0)
      + (member.medalName ? 2 : 0)
      + (member.medalLevel > 0 ? 1 : 0);
  }

  function compareMembers(left, right) {
    const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftUid = BigInt(left.uid);
    const rightUid = BigInt(right.uid);
    return leftUid < rightUid ? -1 : leftUid > rightUid ? 1 : 0;
  }

  function mergeGuardPages(firstPage, remainingPages = []) {
    if (!firstPage || typeof firstPage !== 'object' || !Array.isArray(remainingPages)) {
      throw createError('details_incomplete');
    }
    if (firstPage.pageCount > 500) throw createError('details_too_large');
    if (firstPage.pageNumber !== 1) throw createError('details_incomplete');

    const pages = [firstPage, ...remainingPages];
    const expectedPageCount = Math.max(1, firstPage.pageCount);
    const seenPages = new Set();
    for (const page of pages) {
      if (
        !page
        || page.total !== firstPage.total
        || page.pageCount !== firstPage.pageCount
        || !Number.isSafeInteger(page.pageNumber)
        || page.pageNumber < 1
        || page.pageNumber > expectedPageCount
        || seenPages.has(page.pageNumber)
      ) {
        throw createError('details_incomplete');
      }
      seenPages.add(page.pageNumber);
    }
    if (seenPages.size !== expectedPageCount) throw createError('details_incomplete');

    const candidates = [
      ...firstPage.top3,
      ...firstPage.members,
      ...remainingPages.flatMap(page => page.members),
    ];
    const byUid = new Map();
    for (const member of candidates) {
      const current = byUid.get(member.uid);
      if (!current || memberScore(member) > memberScore(current)) byUid.set(member.uid, member);
    }
    const members = [...byUid.values()].sort(compareMembers);
    if (members.length !== firstPage.total) throw createError('details_incomplete');

    return {
      total: firstPage.total,
      pageCount: firstPage.pageCount,
      members,
    };
  }

  runtime.guardData = Object.freeze({
    guardTier,
    normalizeMember,
    normalizeGuardPage,
    mergeGuardPages,
  });
})();

// Source: src/shared/version.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime) throw new Error('Bilibili guard namespace is not initialized');

  const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,3}$/u;

  function parse(value) {
    if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) return null;
    const parts = value.split('.').map(Number);
    if (parts.some(part => !Number.isSafeInteger(part) || part < 0 || part > 65535)) return null;
    while (parts.length < 4) parts.push(0);
    return Object.freeze(parts);
  }

  function compare(leftValue, rightValue) {
    const left = parse(leftValue);
    const right = parse(rightValue);
    if (!left || !right) throw new TypeError('Versions must contain one to four bounded numeric segments');
    for (let index = 0; index < 4; index += 1) {
      if (left[index] > right[index]) return 1;
      if (left[index] < right[index]) return -1;
    }
    return 0;
  }

  function isNewer(candidate, current) {
    return compare(candidate, current) > 0;
  }

  runtime.version = Object.freeze({parse, compare, isNewer});
})();

// Source: src/shared/update-manifest.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime?.contracts || !runtime.version) {
    throw new Error('Bilibili guard update dependencies are not initialized');
  }

  const {createError} = runtime.contracts;
  const TOP_LEVEL_KEYS = new Set([
    'schemaVersion',
    'version',
    'sourceCommit',
    'publishedAt',
    'userscriptUrl',
    'extensionUrl',
    'sha256',
  ]);
  const HASH_KEYS = new Set(['userscript', 'extension']);
  const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
  const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
  const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

  function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.size && actual.every(key => keys.has(key));
  }

  function fail() {
    throw createError('update_manifest_invalid');
  }

  function normalize(value, allowedBaseUrl) {
    if (!exactKeys(value, TOP_LEVEL_KEYS) || value.schemaVersion !== 1) fail();
    if (!runtime.version.parse(value.version)) fail();
    if (typeof value.sourceCommit !== 'string' || !COMMIT_PATTERN.test(value.sourceCommit)) fail();
    if (typeof value.publishedAt !== 'string' || !UTC_PATTERN.test(value.publishedAt)) fail();
    const parsedTime = new Date(value.publishedAt);
    if (Number.isNaN(parsedTime.valueOf()) || parsedTime.toISOString() !== value.publishedAt.replace(/Z$/u, '.000Z')) fail();
    if (typeof allowedBaseUrl !== 'string' || !allowedBaseUrl.endsWith('/')) fail();
    let base;
    try {
      base = new URL(allowedBaseUrl);
    } catch {
      fail();
    }
    if (base.protocol !== 'https:' || base.href !== allowedBaseUrl) fail();
    const expectedUserscript = `${allowedBaseUrl}userscript/bilibili-guard.user.js`;
    const expectedExtension = `${allowedBaseUrl}extension/bilibili-guard-extension.zip`;
    if (value.userscriptUrl !== expectedUserscript || value.extensionUrl !== expectedExtension) fail();
    if (!exactKeys(value.sha256, HASH_KEYS)) fail();
    if (!SHA256_PATTERN.test(value.sha256.userscript) || !SHA256_PATTERN.test(value.sha256.extension)) fail();

    return Object.freeze({
      schemaVersion: 1,
      version: value.version,
      sourceCommit: value.sourceCommit,
      publishedAt: value.publishedAt,
      userscriptUrl: value.userscriptUrl,
      extensionUrl: value.extensionUrl,
      sha256: Object.freeze({
        userscript: value.sha256.userscript,
        extension: value.sha256.extension,
      }),
    });
  }

  runtime.updateManifest = Object.freeze({normalize});
})();

// Source: src/background/cache.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime) throw new Error('Bilibili guard namespace is not initialized');

  function createSessionCache({storageArea, now}) {
    if (!storageArea?.get || !storageArea?.set || typeof now !== 'function') {
      throw new TypeError('Session cache dependencies are invalid');
    }

    async function read(key) {
      const entry = (await storageArea.get(key))?.[key];
      if (
        !entry
        || typeof entry !== 'object'
        || !Object.prototype.hasOwnProperty.call(entry, 'value')
        || !Number.isSafeInteger(entry.fetchedAt)
        || !Number.isSafeInteger(entry.expiresAt)
        || entry.expiresAt < entry.fetchedAt
      ) {
        return {state: 'missing', value: null};
      }
      return {
        state: entry.expiresAt > now() ? 'fresh' : 'stale',
        value: entry.value,
        fetchedAt: entry.fetchedAt,
        expiresAt: entry.expiresAt,
      };
    }

    async function write(key, value, ttlMs) {
      if (typeof key !== 'string' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
        throw new TypeError('Session cache write is invalid');
      }
      const fetchedAt = now();
      const expiresAt = fetchedAt + ttlMs;
      if (!Number.isSafeInteger(fetchedAt) || !Number.isSafeInteger(expiresAt)) {
        throw new TypeError('Session cache clock is invalid');
      }
      await storageArea.set({[key]: {value, fetchedAt, expiresAt}});
      return {value, fetchedAt, expiresAt};
    }

    return Object.freeze({read, write});
  }

  function coalesce(inFlight, key, operation) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  }

  runtime.cache = Object.freeze({createSessionCache, coalesce});
})();

// Source: src/background/api.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime?.contracts) throw new Error('Bilibili guard contracts are not initialized');

  const {
    createError,
    normalizeBvid,
    normalizeHttpsUrl,
    normalizePositiveInteger,
    normalizeUid,
  } = runtime.contracts;
  const ENDPOINTS = Object.freeze({
    view: 'https://api.bilibili.com/x/web-interface/view',
    room: 'https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids',
    guard: 'https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList',
    ipLocation: 'http://127.0.0.1:8787/api/bilibili/ip-location',
  });
  const MAX_BODY_BYTES = 2 * 1024 * 1024;
  const MAX_IP_LOCATION_BODY_BYTES = 16 * 1024;
  const IP_LOCATION_TIMEOUT_MS = 2500;
  const IP_LOCATION_STATUSES = new Set([
    'found',
    'no_location',
    'auth_required',
    'risk_control',
  ]);
  const IP_LOCATION_SOURCES = new Set(['space_tag', 'space_tag_bottom']);

  function displayName(value, uid) {
    if (typeof value !== 'string') return `UID ${uid}`;
    const text = value.trim();
    return text ? text.slice(0, 120) : `UID ${uid}`;
  }

  function retryDelay(response) {
    if (response.status !== 429) return 1000;
    const raw = response.headers?.get?.('Retry-After');
    if (typeof raw !== 'string' || !/^[1-5]$/u.test(raw.trim())) return 1000;
    return Number(raw.trim()) * 1000;
  }

  function createBilibiliApi({fetchImpl, sleep, timeoutMs = 8000}) {
    if (
      typeof fetchImpl !== 'function'
      || typeof sleep !== 'function'
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs <= 0
    ) {
      throw new TypeError('Bilibili API dependencies are invalid');
    }

    async function requestJson(url, failureCode) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(url.href, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
          });

          if (response.status === 429 || response.status >= 500) {
            if (attempt === 0) {
              await sleep(retryDelay(response));
              continue;
            }
            throw createError(failureCode);
          }
          if (!response.ok) throw createError(failureCode);

          const contentLength = response.headers?.get?.('content-length');
          if (contentLength !== null && contentLength !== undefined) {
            const size = Number(contentLength);
            if (!Number.isFinite(size) || size < 0 || size > MAX_BODY_BYTES) {
              throw createError(failureCode);
            }
          }
          const text = await response.text();
          if (typeof text !== 'string' || text.length > MAX_BODY_BYTES) {
            throw createError(failureCode);
          }
          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            throw createError(failureCode);
          }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw createError(failureCode);
          }
          if (payload.code === -352 || payload.code === -412) {
            throw createError('risk_controlled');
          }
          if (payload.code !== 0) throw createError(failureCode);
          return payload;
        } catch (error) {
          if (controller.signal.aborted) throw createError('request_timeout');
          if (error?.code) throw error;
          if (attempt === 0) {
            await sleep(1000);
            continue;
          }
          throw createError(failureCode);
        } finally {
          clearTimeout(timeout);
        }
      }
      throw createError(failureCode);
    }

    async function resolveVideo(bvidValue) {
      const bvid = normalizeBvid(bvidValue);
      if (!bvid) throw createError('creator_lookup_failed');
      const url = new URL(ENDPOINTS.view);
      url.searchParams.set('bvid', bvid);
      const payload = await requestJson(url, 'creator_lookup_failed');
      const owner = payload.data?.owner;
      const uid = normalizeUid(owner?.mid);
      if (!uid) throw createError('creator_lookup_failed');
      return {
        uid,
        name: displayName(owner.name, uid),
        avatar: normalizeHttpsUrl(owner.face),
      };
    }

    async function resolveRoom(uidValue) {
      const uid = normalizeUid(uidValue);
      if (!uid) throw createError('invalid_identity');
      const url = new URL(ENDPOINTS.room);
      url.searchParams.append('uids[]', uid);
      const payload = await requestJson(url, 'creator_lookup_failed');
      const room = payload.data?.[uid];
      const roomId = normalizeUid(room?.room_id);
      if (!room || !roomId) throw createError('no_live_room');
      return {
        uid,
        roomId,
        name: displayName(room.uname, uid),
        avatar: normalizeHttpsUrl(room.face),
      };
    }

    async function fetchGuardPage({roomId: roomValue, creatorUid: uidValue, page: pageValue}) {
      const roomId = normalizeUid(roomValue);
      const creatorUid = normalizeUid(uidValue);
      const page = normalizePositiveInteger(pageValue);
      if (!roomId || !creatorUid || !page) throw createError('invalid_identity');
      const url = new URL(ENDPOINTS.guard);
      url.searchParams.set('roomid', roomId);
      url.searchParams.set('ruid', creatorUid);
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', '10');
      const payload = await requestJson(url, 'guard_lookup_failed');
      if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
        throw createError('guard_lookup_failed');
      }
      return payload.data;
    }

    async function fetchIpLocation(uidValue) {
      const unavailable = Object.freeze({status: 'unavailable', location: ''});
      const uid = normalizeUid(uidValue);
      if (!uid) return unavailable;
      const url = new URL(ENDPOINTS.ipLocation);
      url.searchParams.set('uid', uid);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(timeoutMs, IP_LOCATION_TIMEOUT_MS),
      );
      try {
        const response = await fetchImpl(url.href, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response?.ok) return unavailable;
        const contentLength = response.headers?.get?.('content-length');
        if (contentLength !== null && contentLength !== undefined) {
          const size = Number(contentLength);
          if (!Number.isFinite(size) || size < 0 || size > MAX_IP_LOCATION_BODY_BYTES) {
            return unavailable;
          }
        }
        const text = await response.text();
        if (typeof text !== 'string' || text.length > MAX_IP_LOCATION_BODY_BYTES) {
          return unavailable;
        }
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          return unavailable;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return unavailable;
        const status = IP_LOCATION_STATUSES.has(payload.status)
          ? payload.status
          : 'unavailable';
        if (status !== 'found') return Object.freeze({status, location: ''});
        if (typeof payload.location !== 'string') return unavailable;
        const location = payload.location.trim().slice(0, 60);
        if (!location) return unavailable;
        const result = {status, location};
        if (IP_LOCATION_SOURCES.has(payload.source)) result.source = payload.source;
        return Object.freeze(result);
      } catch {
        return unavailable;
      } finally {
        clearTimeout(timeout);
      }
    }

    return Object.freeze({resolveVideo, resolveRoom, fetchGuardPage, fetchIpLocation});
  }

  runtime.api = Object.freeze({ENDPOINTS, createBilibiliApi});
})();

// Source: src/background/broker.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime?.contracts || !runtime.cache || !runtime.guardData) {
    throw new Error('Bilibili guard broker dependencies are not initialized');
  }

  const {createError, normalizeRequest} = runtime.contracts;
  const {coalesce, createSessionCache} = runtime.cache;
  const {mergeGuardPages, normalizeGuardPage} = runtime.guardData;
  const SUMMARY_TTL_MS = 60_000;
  const DETAILS_TTL_MS = 300_000;
  const REFRESH_COOLDOWN_MS = 60_000;

  function createGuardBroker({api, storageArea, now}) {
    if (!api?.resolveVideo || !api?.resolveRoom || !api?.fetchGuardPage || !api?.fetchIpLocation) {
      throw new TypeError('Guard broker API is invalid');
    }
    if (!storageArea?.get || !storageArea?.set || typeof now !== 'function') {
      throw new TypeError('Guard broker storage dependencies are invalid');
    }

    const sessionCache = createSessionCache({storageArea, now});
    const inFlight = new Map();

    async function identityUid(context) {
      if (context.kind === 'space') return context.uid;
      const owner = await coalesce(
        inFlight,
        `identity:${context.bvid}`,
        () => api.resolveVideo(context.bvid),
      );
      return owner.uid;
    }

    async function fetchGuardPage(creator, page) {
      await storageArea.set({[`lastNetwork:${creator.uid}`]: now()});
      const payload = await api.fetchGuardPage({
        roomId: creator.roomId,
        creatorUid: creator.uid,
        page,
      });
      return normalizeGuardPage(payload, page);
    }

    async function fetchIpLocation(uid) {
      try {
        const value = await api.fetchIpLocation(uid);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return {status: 'unavailable', location: ''};
        }
        if (value.status === 'found' && typeof value.location === 'string' && value.location.trim()) {
          const result = {status: 'found', location: value.location.trim().slice(0, 60)};
          if (value.source === 'space_tag' || value.source === 'space_tag_bottom') {
            result.source = value.source;
          }
          return result;
        }
        if (['no_location', 'auth_required', 'risk_control'].includes(value.status)) {
          return {status: value.status, location: ''};
        }
      } catch {
        // IP location is optional and must never block guard data.
      }
      return {status: 'unavailable', location: ''};
    }

    function summaryValue(creator, firstPage, ipLocation, fetchedAt) {
      return {
        creator,
        total: firstPage.total,
        pageCount: firstPage.pageCount,
        fetchedAt,
        ipLocation,
      };
    }

    async function writeSummary(creator, firstPage, ipLocation) {
      const summary = summaryValue(creator, firstPage, ipLocation, now());
      await sessionCache.write(`summary:${creator.uid}`, summary, SUMMARY_TTL_MS);
      return summary;
    }

    async function getSummary(context, {force = false} = {}) {
      const uid = await identityUid(context);
      const key = `summary:${uid}`;
      const cached = await sessionCache.read(key);
      if (!force && cached.state === 'fresh') {
        return {...cached.value, cacheState: 'fresh'};
      }

      return coalesce(inFlight, `summary-network:${uid}`, async () => {
        if (!force) {
          const shared = await sessionCache.read(key);
          if (shared.state === 'fresh') return {...shared.value, cacheState: 'fresh'};
        }
        const creator = await api.resolveRoom(uid);
        const [firstPage, ipLocation] = await Promise.all([
          fetchGuardPage(creator, 1),
          fetchIpLocation(creator.uid),
        ]);
        const summary = await writeSummary(creator, firstPage, ipLocation);
        return {...summary, cacheState: 'network'};
      });
    }

    async function fetchRemainingPages(creator, pageCount) {
      if (pageCount <= 1) return [];
      let nextPage = 2;
      let failed = false;
      const pages = [];
      async function worker() {
        while (!failed) {
          const page = nextPage;
          nextPage += 1;
          if (page > pageCount) return;
          try {
            pages.push(await fetchGuardPage(creator, page));
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      }
      const workerCount = Math.min(2, pageCount - 1);
      await Promise.all(Array.from({length: workerCount}, () => worker()));
      return pages.sort((left, right) => left.pageNumber - right.pageNumber);
    }

    async function fetchDetails(uid) {
      const creator = await api.resolveRoom(uid);
      const [firstPage, ipLocation] = await Promise.all([
        fetchGuardPage(creator, 1),
        fetchIpLocation(creator.uid),
      ]);
      const summary = await writeSummary(creator, firstPage, ipLocation);
      if (firstPage.pageCount > 500) throw createError('details_too_large');
      const remainingPages = await fetchRemainingPages(creator, firstPage.pageCount);
      const merged = mergeGuardPages(firstPage, remainingPages);
      const details = {
        creator,
        total: merged.total,
        members: merged.members,
        fetchedAt: now(),
      };
      await sessionCache.write(`details:${uid}`, details, DETAILS_TTL_MS);
      return {
        summary: {...summary, cacheState: 'network'},
        details: {...details, cacheState: 'network'},
      };
    }

    async function getDetails(context, {force = false} = {}) {
      const uid = await identityUid(context);
      const key = `details:${uid}`;
      const cached = await sessionCache.read(key);
      if (!force && cached.state === 'fresh') {
        return {details: {...cached.value, cacheState: 'fresh'}};
      }

      try {
        return await coalesce(inFlight, `details-network:${uid}`, async () => {
          if (!force) {
            const shared = await sessionCache.read(key);
            if (shared.state === 'fresh') {
              return {details: {...shared.value, cacheState: 'fresh'}};
            }
          }
          return fetchDetails(uid);
        });
      } catch (error) {
        if (cached.state === 'stale') {
          return {details: {...cached.value, cacheState: 'stale'}};
        }
        throw error;
      }
    }

    async function checkRefreshCooldown(uid) {
      const value = (await storageArea.get(`lastNetwork:${uid}`))?.[`lastNetwork:${uid}`];
      if (!Number.isSafeInteger(value)) return;
      const elapsed = now() - value;
      if (elapsed >= REFRESH_COOLDOWN_MS) return;
      throw createError('cooldown', {
        retryAfterMs: Math.max(1, REFRESH_COOLDOWN_MS - Math.max(0, elapsed)),
      });
    }

    async function refresh(request) {
      const uid = request.context.kind === 'space'
        ? request.context.uid
        : await identityUid(request.context);
      await checkRefreshCooldown(uid);
      if (!request.detailsOpen) {
        return {summary: await getSummary(request.context, {force: true})};
      }
      const result = await getDetails(request.context, {force: true});
      if (!result.summary) {
        const cachedSummary = await sessionCache.read(`summary:${uid}`);
        if (cachedSummary.state !== 'missing') {
          result.summary = {...cachedSummary.value, cacheState: cachedSummary.state};
        }
      }
      return result;
    }

    async function handle(message) {
      const request = normalizeRequest(message);
      let payload;
      if (request.type === 'guard.summary.get') {
        payload = {summary: await getSummary(request.context, {force: request.force})};
      } else if (request.type === 'guard.details.get') {
        payload = await getDetails(request.context, {force: request.force});
      } else if (request.type === 'guard.refresh') {
        payload = await refresh(request);
      } else {
        throw createError('invalid_identity');
      }
      return {
        ok: true,
        requestId: request.requestId,
        pageGeneration: request.pageGeneration,
        ...payload,
      };
    }

    return Object.freeze({handle});
  }

  runtime.broker = Object.freeze({createGuardBroker});
})();

// Source: src/content/page-context.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime) throw new Error('Bilibili guard namespace is not initialized');

  function watchLocation({
    location,
    addEventListener,
    removeEventListener,
    setInterval,
    clearInterval,
    onChange,
  }) {
    if (!location || typeof onChange !== 'function') {
      throw new TypeError('Location watcher dependencies are invalid');
    }
    let lastHref = location.href;
    const check = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      onChange(lastHref);
    };
    addEventListener('popstate', check);
    addEventListener('pageshow', check);
    const timer = setInterval(check, 500);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      removeEventListener('popstate', check);
      removeEventListener('pageshow', check);
      clearInterval(timer);
    };
  }

  runtime.pageContext = Object.freeze({watchLocation});
})();

// Source: src/content/panel-state.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime) throw new Error('Bilibili guard namespace is not initialized');

  const STORAGE_KEY = 'bilibiliGuardPanelUi';
  const VERSION = 1;
  const MARGIN = 8;
  const DEFAULT_TOP = 96;
  const DEFAULT_RIGHT = 16;
  const fallback = () => ({version: VERSION, left: null, top: null, minimized: false});

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function normalizeStoredState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION) {
      return fallback();
    }
    return {
      version: VERSION,
      left: finite(value.left),
      top: finite(value.top),
      minimized: typeof value.minimized === 'boolean' ? value.minimized : false,
    };
  }

  function clampPosition(position, geometry) {
    const visibleHeight = Math.min(
      geometry.panelHeight,
      Math.max(geometry.headerHeight, geometry.viewportHeight - (MARGIN * 2)),
    );
    const maxLeft = Math.max(MARGIN, geometry.viewportWidth - geometry.panelWidth - MARGIN);
    const maxTop = Math.max(MARGIN, geometry.viewportHeight - visibleHeight - MARGIN);
    return {
      left: Math.min(maxLeft, Math.max(MARGIN, finite(position.left) ?? MARGIN)),
      top: Math.min(maxTop, Math.max(MARGIN, finite(position.top) ?? MARGIN)),
    };
  }

  function resolveState(value, geometry) {
    const state = normalizeStoredState(value);
    const initial = {
      left: state.left ?? Math.max(MARGIN, geometry.viewportWidth - geometry.panelWidth - DEFAULT_RIGHT),
      top: state.top ?? DEFAULT_TOP,
    };
    return {version: VERSION, ...clampPosition(initial, geometry), minimized: state.minimized};
  }

  function createStore({storageArea}) {
    if (!storageArea?.get || !storageArea?.set) throw new TypeError('Storage area is invalid');
    return Object.freeze({
      async load() {
        try {
          const record = await storageArea.get(STORAGE_KEY);
          return normalizeStoredState(record?.[STORAGE_KEY]);
        } catch {
          return fallback();
        }
      },
      async save(value) {
        try {
          const state = normalizeStoredState(value);
          if (state.left === null || state.top === null) return false;
          await storageArea.set({[STORAGE_KEY]: state});
          return true;
        } catch {
          return false;
        }
      },
    });
  }

  runtime.panelState = Object.freeze({
    STORAGE_KEY, normalizeStoredState, clampPosition, resolveState, createStore,
  });
})();

// Source: src/content/panel-style.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime) throw new Error('Bilibili guard namespace is not initialized');

  runtime.panelStyle = Object.freeze({
    css: String.raw`
:host {
  all: initial;
  position: fixed;
  top: 96px;
  right: 16px;
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100vh - 16px);
  z-index: 2147483000;
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}

:host(.is-minimized) {
  width: min(320px, calc(100vw - 16px));
}

*, *::before, *::after {
  box-sizing: border-box;
}

.guard-panel {
  display: flex;
  max-height: calc(100vh - 16px);
  flex-direction: column;
  overflow: hidden;
  color: #2f3138;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(251, 114, 153, 0.24);
  border-radius: 16px;
  box-shadow: 0 14px 36px rgba(28, 31, 38, 0.18);
  backdrop-filter: blur(14px);
}

.guard-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 12px;
  flex: 0 0 auto;
  background: linear-gradient(135deg, rgba(251, 114, 153, 0.13), rgba(0, 174, 236, 0.08));
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.guard-header:active {
  cursor: grabbing;
}

.guard-header .guard-creator-name {
  cursor: pointer;
  user-select: text;
}

.guard-heading-group {
  min-width: 0;
  flex: 1 1 auto;
}

.guard-heading,
.guard-count,
.guard-member-name,
.guard-creator-name {
  margin: 0;
}

.guard-heading {
  color: #18191c;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.4;
}

.guard-creator {
  min-width: 0;
  color: #61666d;
  font-size: 12px;
  line-height: 1.5;
}

.guard-creator-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 5px;
}

.guard-creator-avatar-link {
  display: block;
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  overflow: hidden;
  border-radius: 50%;
  cursor: zoom-in;
}

.guard-creator-avatar-link[hidden] {
  display: none;
}

.guard-creator-avatar-link:focus-visible {
  outline: 3px solid rgba(0, 174, 236, 0.28);
  outline-offset: 2px;
}

.guard-creator-avatar {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.guard-creator-location {
  margin-top: 1px;
  color: #9499a0;
  font-size: 11px;
  line-height: 1.4;
}

.guard-creator-location[hidden] {
  display: none;
}

.guard-creator-location.is-found {
  color: #61666d;
}

.guard-creator-name,
.guard-member-name {
  color: #18191c;
  text-decoration: none;
  overflow-wrap: anywhere;
}

.guard-creator-name:hover,
.guard-member-name:hover {
  color: #fb7299;
}

.guard-count-wrap {
  flex: 0 0 auto;
  min-width: 84px;
  text-align: right;
}

.guard-count {
  color: #fb7299;
  font-size: 26px;
  font-weight: 750;
  line-height: 1;
}

.guard-count-label {
  display: block;
  margin-top: 5px;
  color: #9499a0;
  font-size: 11px;
}

.guard-toggle {
  appearance: none;
  flex: 0 0 auto;
  min-height: 30px;
  padding: 5px 8px;
  color: #61666d;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid #dfe2e5;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  user-select: text;
}

.guard-toggle:focus-visible {
  outline: 3px solid rgba(0, 174, 236, 0.28);
  outline-offset: 2px;
}

.guard-status {
  min-height: 35px;
  padding: 10px 16px;
  color: #61666d;
  background: #f6f7f8;
  border-top: 1px solid #eef0f2;
  border-bottom: 1px solid #eef0f2;
  font-size: 12px;
  line-height: 1.3;
}

.guard-status.is-error {
  color: #d54941;
  background: #fff5f5;
}

.guard-status.is-stale,
.guard-status.is-cooldown {
  color: #8a5a00;
  background: #fff9e8;
}

.guard-update {
  padding: 9px 16px;
  color: #005a85;
  background: #eef9ff;
  border-bottom: 1px solid #d8f0fb;
  font-size: 12px;
  line-height: 1.35;
}

.guard-update[hidden] {
  display: none;
}

.guard-update-link {
  color: inherit;
  font-weight: 650;
  text-decoration: none;
}

.guard-update-link:hover {
  text-decoration: underline;
}

.guard-actions {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
}

.guard-button {
  appearance: none;
  min-height: 34px;
  padding: 7px 14px;
  color: #fff;
  background: #fb7299;
  border: 1px solid #fb7299;
  border-radius: 9px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
}

.guard-button.is-secondary {
  color: #61666d;
  background: #fff;
  border-color: #dfe2e5;
}

.guard-button:hover:not(:disabled) {
  transform: translateY(-1px);
}

.guard-button:focus-visible,
.guard-member-name:focus-visible,
.guard-creator-name:focus-visible {
  outline: 3px solid rgba(0, 174, 236, 0.28);
  outline-offset: 2px;
}

.guard-button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.guard-list {
  min-height: 0;
  flex: 1 1 auto;
  max-height: 70vh;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 12px 14px;
  scrollbar-width: thin;
}

:host(.is-minimized) .guard-status,
:host(.is-minimized) .guard-update,
:host(.is-minimized) .guard-actions,
:host(.is-minimized) .guard-list {
  display: none;
}

.guard-empty {
  padding: 24px 12px 28px;
  color: #9499a0;
  font-size: 13px;
  text-align: center;
}

.guard-member {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
  padding: 12px 4px;
  border-top: 1px solid #eef0f2;
}

.guard-avatar-shell {
  display: block;
  position: relative;
  width: 76px;
  height: 76px;
  overflow: visible;
}

.guard-avatar-link {
  border-radius: 50%;
  cursor: zoom-in;
  text-decoration: none;
}

.guard-avatar-link:focus-visible {
  outline: 3px solid rgba(0, 174, 236, 0.28);
  outline-offset: 2px;
}

.guard-avatar-base,
.guard-avatar {
  position: absolute;
  top: 6px;
  left: 5px;
  width: 66px;
  height: 66px;
}

.guard-avatar-base {
  display: grid;
  place-items: center;
  overflow: hidden;
  color: #9499a0;
  background: linear-gradient(135deg, #f1f2f3, #e3e5e7);
  border-radius: 50%;
  font-size: 25px;
}

.guard-avatar {
  z-index: 1;
  object-fit: cover;
  border-radius: 50%;
}

.guard-avatar-shell.is-placeholder .guard-avatar {
  display: none;
}

.guard-frame {
  position: absolute;
  inset: 0;
  width: 76px;
  height: 76px;
  z-index: 2;
  object-fit: contain;
  pointer-events: none;
}

.guard-member-body {
  min-width: 0;
  padding: 2px 0;
}

.guard-member-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.guard-member-name {
  min-width: 0;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
}

.guard-rank {
  flex: 0 0 auto;
  color: #9499a0;
  font-size: 11px;
}

.guard-member-meta,
.guard-medal {
  margin-top: 5px;
  color: #61666d;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.guard-tier {
  display: inline-block;
  margin-right: 7px;
  padding: 2px 7px;
  color: #a64b6a;
  background: #fff0f5;
  border-radius: 999px;
  font-weight: 650;
}

.guard-medal {
  color: #8a5a00;
}

@media (max-width: 460px) {
  :host {
    top: 72px;
    right: 16px;
  }

  .guard-header,
  .guard-actions {
    padding-right: 12px;
    padding-left: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .guard-button {
    transition: none;
  }
}
`,
  });
})();

// Source: src/content/panel-view.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime?.panelStyle || !runtime?.panelState || !runtime.guardData) {
    throw new Error('Bilibili guard panel dependencies are not initialized');
  }

  const {guardTier} = runtime.guardData;
  const ERROR_TEXT = Object.freeze({
    unsupported_page: '当前页面不受支持。',
    invalid_identity: '无法识别当前创作者。',
    creator_lookup_failed: '读取创作者信息失败，请稍后重试。',
    no_live_room: '该创作者没有可用的直播间。',
    guard_lookup_failed: '读取大航海数据失败，请稍后重试。',
    risk_controlled: 'B站接口访问受限，请稍后再试。',
    request_timeout: '请求超时，请检查网络后重试。',
    details_incomplete: '名单数据不完整，未展示部分结果。',
    details_too_large: '名单规模超过安全上限。',
  });
  const AVATAR_IMAGE_HOSTS = new Set([
    'i0.hdslb.com',
    'i1.hdslb.com',
    'i2.hdslb.com',
  ]);
  const IP_LOCATION_TEXT = Object.freeze({
    auth_required: 'IP属地：需配置授权',
    no_location: 'IP属地：未展示',
    risk_control: 'IP属地：访问受限',
    unavailable: 'IP属地：接口未连接',
  });

  function textElement(document, tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = String(text ?? '');
    return element;
  }

  function profileLink(document, uid, className, text) {
    const link = textElement(document, 'a', className, text);
    link.href = `https://space.bilibili.com/${uid}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function originalAvatarUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:'
        || url.username
        || url.password
        || url.port
        || !AVATAR_IMAGE_HOSTS.has(url.hostname)
      ) return null;
      const transformIndex = url.pathname.indexOf('@');
      const pathname = transformIndex === -1
        ? url.pathname
        : url.pathname.slice(0, transformIndex);
      if (!pathname.startsWith('/bfs/face/') || !/\.(?:jpe?g|png)$/iu.test(pathname)) return null;
      url.pathname = pathname;
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  function createPanel({
    document,
    viewport = globalThis,
    getURL,
    initialState,
    onDetails,
    onRefresh,
    onMinimize,
    onShow,
    onPositionChange,
  }) {
    if (!document?.createElement || !viewport || typeof getURL !== 'function') {
      throw new TypeError('Panel dependencies are invalid');
    }
    const host = document.createElement('div');
    host.id = 'bilibili-guard-extension-host';
    const root = host.attachShadow({mode: 'open'});

    const style = document.createElement('style');
    style.textContent = runtime.panelStyle.css;
    const section = document.createElement('section');
    section.className = 'guard-panel';
    section.setAttribute('role', 'region');
    section.setAttribute('aria-label', 'B站大航海详情');

    const header = document.createElement('header');
    header.className = 'guard-header';
    const headingGroup = document.createElement('div');
    headingGroup.className = 'guard-heading-group';
    const heading = textElement(document, 'h2', 'guard-heading', '大航海');
    const creatorRow = document.createElement('div');
    creatorRow.className = 'guard-creator-row';
    const creatorAvatarLink = document.createElement('a');
    creatorAvatarLink.className = 'guard-creator-avatar-link';
    creatorAvatarLink.hidden = true;
    const creatorAvatar = document.createElement('img');
    creatorAvatar.className = 'guard-creator-avatar';
    creatorAvatar.loading = 'lazy';
    creatorAvatar.referrerPolicy = 'no-referrer';
    creatorAvatarLink.append(creatorAvatar);
    const creator = document.createElement('div');
    creator.className = 'guard-creator';
    const creatorName = profileLink(document, '1', 'guard-creator-name', '正在识别创作者');
    creatorName.removeAttribute('href');
    const creatorUid = textElement(document, 'span', 'guard-creator-uid', ' · UID --');
    const creatorLocation = textElement(document, 'div', 'guard-creator-location', '');
    creatorLocation.hidden = true;
    creator.append(creatorName, creatorUid, creatorLocation);
    creatorRow.append(creatorAvatarLink, creator);
    headingGroup.append(heading, creatorRow);

    const countWrap = document.createElement('div');
    countWrap.className = 'guard-count-wrap';
    const count = textElement(document, 'div', 'guard-count', '--');
    const countLabel = textElement(document, 'span', 'guard-count-label', '大航海');
    countWrap.append(count, countLabel);
    const toggle = textElement(document, 'button', 'guard-toggle', '最小化');
    toggle.type = 'button';
    header.append(headingGroup, countWrap, toggle);

    const status = textElement(document, 'div', 'guard-status', '等待页面识别');
    status.setAttribute('aria-live', 'polite');
    const update = document.createElement('div');
    update.className = 'guard-update';
    update.hidden = true;
    const updateLink = textElement(document, 'a', 'guard-update-link', '');
    updateLink.target = '_blank';
    updateLink.rel = 'noopener noreferrer';
    update.append(updateLink);
    const actions = document.createElement('div');
    actions.className = 'guard-actions';
    const detailsButton = textElement(document, 'button', 'guard-button', '查看详情');
    detailsButton.type = 'button';
    detailsButton.setAttribute('aria-label', '查看大航海详情');
    const refreshButton = textElement(document, 'button', 'guard-button is-secondary', '刷新');
    refreshButton.type = 'button';
    refreshButton.setAttribute('aria-label', '刷新大航海数据');
    detailsButton.addEventListener('click', () => onDetails?.());
    refreshButton.addEventListener('click', () => onRefresh?.());
    actions.append(detailsButton, refreshButton);
    const list = document.createElement('div');
    list.className = 'guard-list';
    list.setAttribute('aria-label', '大航海成员列表');

    section.append(header, status, update, actions, list);
    root.append(style, section);
    (document.documentElement ?? document.body).append(host);

    let destroyed = false;
    let activeDrag = null;

    function geometry() {
      const panelBox = section.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      return {
        viewportWidth: viewport.innerWidth,
        viewportHeight: viewport.innerHeight,
        panelWidth: panelBox.width,
        panelHeight: panelBox.height,
        headerHeight: headerBox.height,
      };
    }

    const normalizedInitialState = runtime.panelState.normalizeStoredState(initialState);
    setMinimized(normalizedInitialState.minimized);
    const resolvedState = runtime.panelState.resolveState(normalizedInitialState, geometry());
    let position = {left: resolvedState.left, top: resolvedState.top};

    function applyPosition(next) {
      position = {left: next.left, top: next.top};
      host.style.left = `${position.left}px`;
      host.style.top = `${position.top}px`;
      host.style.right = 'auto';
    }

    function currentPosition() {
      return {left: position.left, top: position.top};
    }

    function clampPosition() {
      return runtime.panelState.clampPosition(position, geometry());
    }

    function clampPositionAndNotify() {
      const next = clampPosition();
      if (next.left === position.left && next.top === position.top) return false;
      applyPosition(next);
      onPositionChange?.(currentPosition());
      return true;
    }

    function setMinimized(minimized) {
      host.classList.toggle('is-minimized', minimized);
      toggle.textContent = minimized ? '显示' : '最小化';
      toggle.setAttribute('aria-label', minimized ? '显示大航海详情' : '最小化大航海详情');
      toggle.setAttribute('aria-pressed', String(minimized));
    }

    function isInteractiveHeaderTarget(target) {
      for (let node = target; node && node !== header; node = node.parentNode) {
        if (
          ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)
          || node.getAttribute?.('role') === 'button'
        ) return true;
      }
      return false;
    }

    function finishDrag(pointerId) {
      if (!activeDrag || activeDrag.pointerId !== pointerId) return;
      header.releasePointerCapture(pointerId);
      activeDrag = null;
      onPositionChange?.(currentPosition());
    }

    function onPointerDown(event) {
      if (
        destroyed
        || event.button !== 0
        || event.isPrimary !== true
        || isInteractiveHeaderTarget(event.target)
      ) return;
      activeDrag = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        position: currentPosition(),
      };
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
      applyPosition(runtime.panelState.clampPosition({
        left: activeDrag.position.left + (event.clientX - activeDrag.clientX),
        top: activeDrag.position.top + (event.clientY - activeDrag.clientY),
      }, geometry()));
      event.preventDefault();
    }

    function onPointerUp(event) {
      finishDrag(event.pointerId);
    }

    function onPointerCancel(event) {
      finishDrag(event.pointerId);
    }

    function onResize() {
      if (destroyed) return;
      clampPositionAndNotify();
    }

    header.addEventListener('pointerdown', onPointerDown);
    header.addEventListener('pointermove', onPointerMove);
    header.addEventListener('pointerup', onPointerUp);
    header.addEventListener('pointercancel', onPointerCancel);
    viewport.addEventListener('resize', onResize);
    applyPosition(position);

    toggle.addEventListener('click', () => {
      if (destroyed) return;
      const minimized = !host.classList.contains('is-minimized');
      setMinimized(minimized);
      const next = clampPosition();
      if (next.left !== position.left || next.top !== position.top) applyPosition(next);
      if (minimized) onMinimize?.(currentPosition());
      else onShow?.(currentPosition());
    });

    function setBusy(busy) {
      detailsButton.disabled = busy;
      refreshButton.disabled = busy;
    }

    function setStatus(text, state = '') {
      status.className = state ? `guard-status is-${state}` : 'guard-status';
      status.textContent = text;
    }

    function clearCreatorAvatar() {
      creatorAvatarLink.hidden = true;
      creatorAvatarLink.removeAttribute('href');
      creatorAvatarLink.removeAttribute('target');
      creatorAvatarLink.removeAttribute('rel');
      creatorAvatarLink.removeAttribute('referrerpolicy');
      creatorAvatarLink.removeAttribute('aria-label');
      creatorAvatarLink.removeAttribute('title');
      creatorAvatar.removeAttribute('src');
      creatorAvatar.removeAttribute('alt');
    }

    creatorAvatar.addEventListener('error', clearCreatorAvatar);

    function renderCreator(value) {
      creatorName.textContent = value.name;
      creatorName.href = `https://space.bilibili.com/${value.uid}`;
      creatorUid.textContent = ` · UID ${value.uid}`;
      clearCreatorAvatar();
      const avatarUrl = originalAvatarUrl(value.avatar);
      if (avatarUrl) {
        creatorAvatarLink.href = avatarUrl;
        creatorAvatarLink.target = '_blank';
        creatorAvatarLink.rel = 'noopener noreferrer';
        creatorAvatarLink.setAttribute('referrerpolicy', 'no-referrer');
        creatorAvatarLink.setAttribute('aria-label', `打开${value.name}头像原图`);
        creatorAvatarLink.setAttribute('title', '打开UP主头像原图');
        creatorAvatar.src = value.avatar;
        creatorAvatar.alt = `${value.name}头像`;
        creatorAvatarLink.hidden = false;
      }
    }

    function clearCreatorLocation() {
      creatorLocation.hidden = true;
      creatorLocation.className = 'guard-creator-location';
      creatorLocation.textContent = '';
    }

    function renderCreatorLocation(value) {
      clearCreatorLocation();
      if (value?.status === 'found' && typeof value.location === 'string') {
        const location = value.location.trim().slice(0, 60);
        if (location) {
          creatorLocation.textContent = `IP属地：${location}`;
          creatorLocation.className = 'guard-creator-location is-found';
          creatorLocation.hidden = false;
          return;
        }
      }
      const status = Object.hasOwn(IP_LOCATION_TEXT, value?.status)
        ? value.status
        : 'unavailable';
      creatorLocation.textContent = IP_LOCATION_TEXT[status];
      creatorLocation.className = `guard-creator-location is-${status.replaceAll('_', '-')}`;
      creatorLocation.hidden = false;
    }

    function resetCreator() {
      clearCreatorAvatar();
      clearCreatorLocation();
      creatorName.textContent = '正在识别创作者';
      creatorName.removeAttribute('href');
      creatorUid.textContent = ' · UID --';
      count.textContent = '--';
      list.replaceChildren();
    }

    function renderLoading() {
      if (destroyed) return;
      setBusy(true);
      setStatus('正在读取大航海数据…');
      clampPositionAndNotify();
    }

    function renderNavigationLoading() {
      if (destroyed) return;
      resetCreator();
      renderLoading();
    }

    function renderSummary(summary) {
      if (destroyed) return;
      renderCreator(summary.creator);
      renderCreatorLocation(summary.ipLocation);
      count.textContent = String(summary.total);
      list.replaceChildren();
      setBusy(false);
      if (summary.cacheState === 'stale') setStatus('当前显示缓存数据，可稍后重试。', 'stale');
      else setStatus('概要已更新，点击“查看详情”加载完整名单。');
      clampPositionAndNotify();
    }

    function avatarStack(member, tier) {
      const avatarUrl = originalAvatarUrl(member.avatar);
      const shell = document.createElement(avatarUrl ? 'a' : 'div');
      shell.className = member.avatar ? 'guard-avatar-shell' : 'guard-avatar-shell is-placeholder';
      if (avatarUrl) {
        shell.classList.add('guard-avatar-link');
        shell.href = avatarUrl;
        shell.target = '_blank';
        shell.rel = 'noopener noreferrer';
        shell.setAttribute('referrerpolicy', 'no-referrer');
        shell.setAttribute('aria-label', `打开${member.nickname}头像原图`);
        shell.setAttribute('title', '打开头像原图');
      }
      const base = textElement(document, 'span', 'guard-avatar-base', '👤');
      shell.append(base);
      if (member.avatar) {
        const avatar = document.createElement('img');
        avatar.className = 'guard-avatar';
        avatar.src = member.avatar;
        avatar.alt = `${member.nickname}头像`;
        avatar.loading = 'lazy';
        avatar.referrerPolicy = 'no-referrer';
        avatar.addEventListener('error', () => {
          avatar.removeAttribute('src');
          shell.classList.add('is-placeholder');
          shell.classList.remove('guard-avatar-link');
          shell.removeAttribute('href');
          shell.removeAttribute('target');
          shell.removeAttribute('rel');
          shell.removeAttribute('referrerpolicy');
          shell.removeAttribute('aria-label');
          shell.removeAttribute('title');
        });
        shell.append(avatar);
      }
      if (tier.frame) {
        const frame = document.createElement('img');
        frame.className = 'guard-frame';
        frame.src = getURL(`assets/frames/${tier.frame}`);
        frame.alt = `${tier.name}官方头像框`;
        frame.addEventListener('error', () => frame.remove());
        shell.append(frame);
      }
      return shell;
    }

    function memberRow(member) {
      const tier = guardTier(member.guardLevel);
      const row = document.createElement('article');
      row.className = 'guard-member';
      const body = document.createElement('div');
      body.className = 'guard-member-body';
      const top = document.createElement('div');
      top.className = 'guard-member-top';
      const name = profileLink(document, member.uid, 'guard-member-name', member.nickname);
      const rank = textElement(
        document,
        'span',
        'guard-rank',
        member.rank === null ? '排名 --' : `#${member.rank}`,
      );
      top.append(name, rank);
      const meta = document.createElement('div');
      meta.className = 'guard-member-meta';
      const tierText = tier.frame ? tier.name : `${tier.name} ${member.guardLevel}`;
      const tierBadge = textElement(document, 'span', 'guard-tier', tierText);
      const uid = textElement(document, 'span', 'guard-member-uid', `UID ${member.uid}`);
      meta.append(tierBadge, uid);
      const medalText = member.medalName
        ? `${member.medalName} · Lv.${member.medalLevel}`
        : `未显示粉丝牌 · Lv.${member.medalLevel}`;
      const medal = textElement(document, 'div', 'guard-medal', medalText);
      body.append(top, meta, medal);
      row.append(avatarStack(member, tier), body);
      return row;
    }

    function renderDetails(details) {
      if (destroyed) return;
      renderCreator(details.creator);
      count.textContent = String(details.total);
      list.replaceChildren();
      if (details.members.length === 0) {
        list.append(textElement(document, 'div', 'guard-empty', '暂无大航海成员'));
      } else {
        list.append(...details.members.map(memberRow));
      }
      setBusy(false);
      if (details.cacheState === 'stale') setStatus('详情请求失败，当前显示缓存数据。', 'stale');
      else setStatus(`已加载 ${details.total} 名大航海成员。`);
      clampPositionAndNotify();
    }

    function renderError(code) {
      if (destroyed) return;
      setBusy(false);
      setStatus(ERROR_TEXT[code] ?? ERROR_TEXT.guard_lookup_failed, 'error');
      clampPositionAndNotify();
    }

    function renderCooldown(retryAfterMs) {
      if (destroyed) return;
      setBusy(false);
      const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      setStatus(`刷新过于频繁，请在 ${seconds} 秒后重试。`, 'cooldown');
      clampPositionAndNotify();
    }

    function renderSettingsError() {
      if (destroyed) return;
      setBusy(false);
      setStatus('面板设置暂时无法保存。', 'error');
      clampPositionAndNotify();
    }

    function clearUpdate() {
      update.hidden = true;
      updateLink.textContent = '';
      updateLink.removeAttribute('href');
    }

    function renderUpdate(value) {
      if (destroyed) return;
      const version = typeof value?.version === 'string' && /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,3}$/u.test(value.version)
        ? value.version
        : null;
      const expectedUrl = 'https://echoxiaoze.github.io/bilibili-guard-extension-dist/extension/bilibili-guard-extension.zip';
      if (!version || value?.extensionUrl !== expectedUrl) {
        clearUpdate();
        return;
      }
      updateLink.textContent = `发现新版本 ${version}，点击下载`;
      updateLink.href = expectedUrl;
      update.hidden = false;
      clampPositionAndNotify();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      viewport.removeEventListener('resize', onResize);
      if (activeDrag) header.releasePointerCapture(activeDrag.pointerId);
      activeDrag = null;
      host.remove();
    }

    return Object.freeze({
      host,
      root,
      renderLoading,
      renderNavigationLoading,
      renderSummary,
      renderDetails,
      renderError,
      renderCooldown,
      renderSettingsError,
      renderUpdate,
      clearUpdate,
      destroy,
    });
  }

  runtime.panelView = Object.freeze({createPanel});
})();

// Source: src/content/content-script.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime?.contracts || !runtime.pageContext) {
    throw new Error('Bilibili guard content dependencies are not initialized');
  }

  const {
    createError,
    ERROR_CODES,
    normalizeHttpsUrl,
    normalizePositiveInteger,
    normalizeUid,
    parsePageUrl,
  } = runtime.contracts;
  const CACHE_STATES = new Set(['network', 'fresh', 'stale']);
  const IP_LOCATION_STATUSES = new Set([
    'no_location',
    'auth_required',
    'risk_control',
    'unavailable',
  ]);

  function boundedText(value, maximum, fallback) {
    if (typeof value !== 'string') return fallback;
    const text = value.trim();
    return text ? text.slice(0, maximum) : fallback;
  }

  function normalizeCreator(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw createError('guard_lookup_failed');
    }
    const uid = normalizeUid(value.uid);
    const roomId = normalizeUid(value.roomId);
    if (!uid || !roomId) throw createError('guard_lookup_failed');
    return {
      uid,
      roomId,
      name: boundedText(value.name, 120, `UID ${uid}`),
      avatar: normalizeHttpsUrl(value.avatar),
    };
  }

  function normalizeCacheState(value) {
    if (!CACHE_STATES.has(value)) throw createError('guard_lookup_failed');
    return value;
  }

  function normalizeIpLocation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {status: 'unavailable', location: ''};
    }
    if (value.status === 'found') {
      const location = boundedText(value.location, 60, '');
      if (!location) return {status: 'unavailable', location: ''};
      const result = {status: 'found', location};
      if (value.source === 'space_tag' || value.source === 'space_tag_bottom') {
        result.source = value.source;
      }
      return result;
    }
    if (IP_LOCATION_STATUSES.has(value.status)) {
      return {status: value.status, location: ''};
    }
    return {status: 'unavailable', location: ''};
  }

  function normalizeSummary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw createError('guard_lookup_failed');
    }
    const total = normalizePositiveInteger(value.total, {allowZero: true});
    const pageCount = normalizePositiveInteger(value.pageCount, {allowZero: true});
    const fetchedAt = normalizePositiveInteger(value.fetchedAt, {allowZero: true});
    if (total === null || pageCount === null || fetchedAt === null) {
      throw createError('guard_lookup_failed');
    }
    return {
      creator: normalizeCreator(value.creator),
      total,
      pageCount,
      fetchedAt,
      cacheState: normalizeCacheState(value.cacheState),
      ipLocation: normalizeIpLocation(value.ipLocation),
    };
  }

  function optionalInteger(value, {positive = false} = {}) {
    if (value === null || value === undefined) return null;
    return normalizePositiveInteger(value, {allowZero: !positive});
  }

  function normalizeMember(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const uid = normalizeUid(value.uid);
    const rank = optionalInteger(value.rank, {positive: true});
    const guardLevel = optionalInteger(value.guardLevel);
    const guardSubLevel = optionalInteger(value.guardSubLevel);
    const medalLevel = optionalInteger(value.medalLevel);
    if (
      !uid
      || (value.rank !== null && value.rank !== undefined && rank === null)
      || guardLevel === null
      || guardSubLevel === null
      || medalLevel === null
    ) return null;
    return {
      uid,
      nickname: boundedText(value.nickname, 120, `UID ${uid}`),
      avatar: normalizeHttpsUrl(value.avatar),
      rank,
      guardLevel,
      guardSubLevel,
      medalName: boundedText(value.medalName, 60, ''),
      medalLevel,
    };
  }

  function normalizeDetails(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.members)) {
      throw createError('guard_lookup_failed');
    }
    const total = normalizePositiveInteger(value.total, {allowZero: true});
    const fetchedAt = normalizePositiveInteger(value.fetchedAt, {allowZero: true});
    const members = value.members.map(normalizeMember).filter(Boolean);
    if (total === null || fetchedAt === null || members.length !== total) {
      throw createError('details_incomplete');
    }
    return {
      creator: normalizeCreator(value.creator),
      total,
      members,
      fetchedAt,
      cacheState: normalizeCacheState(value.cacheState),
    };
  }

  function createController({
    location,
    addEventListener,
    removeEventListener,
    setInterval,
    clearInterval,
    sendMessage,
    createPanel,
    randomId,
    getUpdateStatus = async () => null,
    subscribeUpdateStatus = () => () => {},
    initialUiState = {version: 1, left: null, top: null, minimized: false},
    saveUiState = async () => true,
  }) {
    if (
      !location
      || typeof sendMessage !== 'function'
      || typeof createPanel !== 'function'
      || typeof randomId !== 'function'
      || typeof subscribeUpdateStatus !== 'function'
    ) {
      throw new TypeError('Content controller dependencies are invalid');
    }

    let currentContext = null;
    let currentKey = null;
    let currentCreatorUid = null;
    let generation = 0;
    let panel = null;
    let stopWatching = null;
    let started = false;
    let destroyed = false;
    let detailsOpen = false;
    let uiState = {...initialUiState};
    let autoDetailsPendingGeneration = null;
    let updateStatusRequested = false;
    let stopWatchingUpdateStatus = null;

    function renderUpdateStatus(response) {
      if (destroyed || !panel || response?.ok !== true) return;
      if (response.update?.available === true) panel.renderUpdate?.(response.update);
      else panel.clearUpdate?.();
    }

    function activeContext() {
      if (!currentCreatorUid) return currentContext;
      return {
        kind: 'space',
        uid: currentCreatorUid,
        key: `space:${currentCreatorUid}`,
      };
    }

    function renderFailure(error, expectedGeneration) {
      if (destroyed || expectedGeneration !== generation || !panel) return;
      const code = ERROR_CODES.has(error?.code) ? error.code : 'guard_lookup_failed';
      if (code === 'cooldown') {
        const retryAfterMs = normalizePositiveInteger(error?.retryAfterMs) ?? 1000;
        panel.renderCooldown(retryAfterMs);
        return;
      }
      panel.renderError(code);
    }

    async function request(type) {
      if (!currentContext || !panel || destroyed) return null;
      const expectedGeneration = generation;
      const requestId = randomId();
      const message = {
        type,
        requestId,
        pageGeneration: expectedGeneration,
        context: type === 'guard.summary.get' ? currentContext : activeContext(),
        force: type === 'guard.refresh',
      };
      if (type === 'guard.refresh') message.detailsOpen = detailsOpen;

      let response;
      try {
        response = await sendMessage(message);
      } catch {
        renderFailure({code: 'guard_lookup_failed'}, expectedGeneration);
        return null;
      }
      if (
        destroyed
        || expectedGeneration !== generation
        || !panel
        || !response
        || response.requestId !== requestId
        || response.pageGeneration !== expectedGeneration
      ) {
        return null;
      }
      if (response.ok !== true) {
        renderFailure(response.error, expectedGeneration);
        return response;
      }

      try {
        if (response.summary) {
          const summary = normalizeSummary(response.summary);
          currentCreatorUid = summary.creator.uid;
          panel.renderSummary(summary);
          if (autoDetailsPendingGeneration === expectedGeneration) {
            autoDetailsPendingGeneration = null;
            if (response.details === undefined) {
              panel.renderLoading();
              void request('guard.details.get');
            }
          }
        }
        if (response.details) {
          const details = normalizeDetails(response.details);
          currentCreatorUid = details.creator.uid;
          panel.renderDetails(details);
        }
      } catch (error) {
        renderFailure(error, expectedGeneration);
      }
      return response;
    }

    async function onDetails() {
      detailsOpen = true;
      panel?.renderLoading();
      return request('guard.details.get');
    }

    async function onRefresh() {
      panel?.renderLoading();
      return request('guard.refresh');
    }

    async function persistUiState(patch) {
      uiState = {...uiState, ...patch, version: 1};
      const saved = await saveUiState(uiState);
      if (!saved && !destroyed) panel?.renderSettingsError();
      return saved;
    }

    function onMinimize(position) {
      return persistUiState({...position, minimized: true});
    }

    function onPositionChange(position) {
      return persistUiState(position);
    }

    function onShow(position) {
      if (!uiState.minimized) return null;
      const persistence = persistUiState({...position, minimized: false});
      detailsOpen = true;
      if (currentCreatorUid) {
        panel?.renderLoading();
        return request('guard.details.get');
      }
      autoDetailsPendingGeneration = generation;
      return persistence;
    }

    function ensurePanel() {
      if (panel) return;
      panel = createPanel({
        initialState: uiState,
        onDetails,
        onRefresh,
        onMinimize,
        onShow,
        onPositionChange,
      });
      if (!updateStatusRequested) {
        updateStatusRequested = true;
        Promise.resolve(getUpdateStatus()).then(renderUpdateStatus).catch(() => {});
      }
    }

    function navigate(href) {
      if (destroyed) return;
      const context = parsePageUrl(href);
      const nextKey = context?.key ?? null;
      if (nextKey === currentKey) return;
      autoDetailsPendingGeneration = null;
      generation += 1;
      currentContext = context;
      currentKey = nextKey;
      currentCreatorUid = null;
      detailsOpen = false;

      if (!context) {
        panel?.destroy();
        panel = null;
        return;
      }
      ensurePanel();
      panel.renderNavigationLoading();
      void request('guard.summary.get');
    }

    function start() {
      if (started || destroyed) return;
      started = true;
      stopWatchingUpdateStatus = subscribeUpdateStatus(renderUpdateStatus);
      stopWatching = runtime.pageContext.watchLocation({
        location,
        addEventListener,
        removeEventListener,
        setInterval,
        clearInterval,
        onChange: navigate,
      });
      navigate(location.href);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      autoDetailsPendingGeneration = null;
      generation += 1;
      stopWatching?.();
      stopWatching = null;
      stopWatchingUpdateStatus?.();
      stopWatchingUpdateStatus = null;
      panel?.destroy();
      panel = null;
    }

    return Object.freeze({start, destroy});
  }

  async function bootstrap({storageArea, controllerOptions}) {
    const store = runtime.panelState.createStore({storageArea});
    const initialUiState = await store.load();
    const controller = createController({
      ...controllerOptions,
      initialUiState,
      saveUiState: state => store.save(state),
    });
    controller.start();
    return controller;
  }

  runtime.content = Object.freeze({
    bootstrap,
    createController,
    normalizeIpLocation,
    normalizeSummary,
    normalizeDetails,
  });

  if (globalThis.chrome?.runtime?.sendMessage && globalThis.document && runtime.panelView) {
    void bootstrap({
      storageArea: globalThis.chrome.storage.local,
      controllerOptions: {
        location: globalThis.location,
        addEventListener: globalThis.addEventListener.bind(globalThis),
        removeEventListener: globalThis.removeEventListener.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        sendMessage: message => globalThis.chrome.runtime.sendMessage(message),
        createPanel: options => runtime.panelView.createPanel({
          document: globalThis.document,
          getURL: path => globalThis.chrome.runtime.getURL(path),
          ...options,
        }),
        randomId: () => globalThis.crypto.randomUUID(),
        getUpdateStatus: () => globalThis.chrome.runtime.sendMessage({type: 'update.status.get'}),
        subscribeUpdateStatus: listener => {
          const onChanged = (changes, areaName) => {
            const state = changes?.bilibiliGuardUpdateState?.newValue;
            if (areaName === 'local' && state) listener({ok: true, update: state});
          };
          globalThis.chrome.storage.onChanged.addListener(onChanged);
          return () => globalThis.chrome.storage.onChanged.removeListener(onChanged);
        },
      },
    }).catch(() => {});
  }
})();

// Source: src/userscript/http.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime) throw new Error('Bilibili guard namespace is not initialized');

  function requestError() {
    const error = new Error('userscript_request_failed');
    error.code = 'userscript_request_failed';
    return error;
  }

  function parseHeaders(raw) {
    const values = new Map();
    if (typeof raw === 'string') {
      for (const line of raw.split(/\r?\n/u)) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        const key = line.slice(0, separator).trim().toLowerCase();
        if (!key || values.has(key)) continue;
        values.set(key, line.slice(separator + 1).trim());
      }
    }
    return Object.freeze({
      get(name) {
        return typeof name === 'string' ? values.get(name.toLowerCase()) ?? null : null;
      },
    });
  }

  function createFetch({request, allowedHosts}) {
    if (typeof request !== 'function' || !Array.isArray(allowedHosts) || allowedHosts.length === 0) {
      throw new TypeError('Userscript HTTP dependencies are invalid');
    }
    const hosts = new Set(allowedHosts);
    if (hosts.size !== allowedHosts.length || [...hosts].some(host => typeof host !== 'string' || !host)) {
      throw new TypeError('Userscript HTTP hosts are invalid');
    }

    function isAllowedUrl(url) {
      if (
        !url
        || url.username
        || url.password
        || !hosts.has(url.hostname)
      ) return false;
      if (url.protocol === 'https:') return url.port === '';
      return url.protocol === 'http:'
        && url.hostname === '127.0.0.1'
        && url.port === '8787'
        && url.pathname === '/api/bilibili/ip-location';
    }

    return async function fetchImpl(input, options = {}) {
      let requested;
      try {
        requested = new URL(typeof input === 'string' ? input : input?.href);
      } catch {
        throw requestError();
      }
      if (!isAllowedUrl(requested)) throw requestError();
      if (options.method !== undefined && options.method !== 'GET') throw requestError();

      return new Promise((resolve, reject) => {
        let settled = false;
        let handle = null;
        const finish = callback => value => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener?.('abort', abort);
          callback(value);
        };
        const succeed = finish(response => {
          let finalUrl;
          try {
            finalUrl = new URL(response?.finalUrl || requested.href);
          } catch {
            reject(requestError());
            return;
          }
          if (!isAllowedUrl(finalUrl)) {
            reject(requestError());
            return;
          }
          const status = Number(response?.status);
          const text = typeof response?.responseText === 'string' ? response.responseText : '';
          resolve(Object.freeze({
            status,
            ok: Number.isInteger(status) && status >= 200 && status < 300,
            headers: parseHeaders(response?.responseHeaders),
            async text() { return text; },
          }));
        });
        const fail = finish(() => reject(requestError()));
        function abort() {
          try { handle?.abort?.(); } catch { /* ignore platform abort errors */ }
          fail();
        }
        if (options.signal?.aborted) {
          fail();
          return;
        }
        options.signal?.addEventListener?.('abort', abort, {once: true});
        try {
          handle = request({
            method: 'GET',
            url: requested.href,
            headers: {'Cache-Control': 'no-cache'},
            onload: succeed,
            onerror: fail,
            ontimeout: fail,
            onabort: fail,
          });
        } catch {
          fail();
        }
      });
    };
  }

  runtime.userscriptHttp = Object.freeze({createFetch});
})();

// Source: src/userscript/storage.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime) throw new Error('Bilibili guard namespace is not initialized');

  const UI_KEY = 'bilibiliGuardPanelUi';
  const clone = value => value === undefined ? undefined : globalThis.structuredClone(value);

  function createMemoryArea() {
    const values = new Map();
    return Object.freeze({
      async get(key) {
        if (key === null) return Object.fromEntries([...values].map(([name, value]) => [name, clone(value)]));
        return {[key]: clone(values.get(key))};
      },
      async set(update) {
        if (!update || typeof update !== 'object' || Array.isArray(update)) throw new TypeError('Memory update is invalid');
        for (const [key, value] of Object.entries(update)) values.set(key, clone(value));
      },
      async remove(key) {
        values.delete(key);
      },
    });
  }

  function createPreferenceArea({getValue, setValue}) {
    if (typeof getValue !== 'function' || typeof setValue !== 'function') {
      throw new TypeError('Userscript preference dependencies are invalid');
    }
    return Object.freeze({
      async get(key) {
        if (key !== UI_KEY) throw new TypeError('Only panel UI preferences may persist');
        return {[key]: clone(await getValue(key, undefined))};
      },
      async set(update) {
        if (!update || typeof update !== 'object' || Array.isArray(update)) throw new TypeError('Preference update is invalid');
        const entries = Object.entries(update);
        if (entries.length !== 1 || entries[0][0] !== UI_KEY) {
          throw new TypeError('Only panel UI preferences may persist');
        }
        await setValue(UI_KEY, clone(entries[0][1]));
      },
    });
  }

  runtime.userscriptStorage = Object.freeze({UI_KEY, createMemoryArea, createPreferenceArea});
})();

// Source: src/userscript/updater.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime?.version || !runtime.updateManifest) {
    throw new Error('Bilibili guard userscript update dependencies are not initialized');
  }

  function create({requestJson, currentVersion, openInTab, registerMenuCommand, publicBaseUrl, notify = () => {}}) {
    if (
      typeof requestJson !== 'function'
      || !runtime.version.parse(currentVersion)
      || typeof openInTab !== 'function'
      || typeof registerMenuCommand !== 'function'
      || typeof publicBaseUrl !== 'string'
      || typeof notify !== 'function'
    ) {
      throw new TypeError('Userscript updater dependencies are invalid');
    }

    async function check({open = true} = {}) {
      try {
        const manifest = runtime.updateManifest.normalize(
          await requestJson(`${publicBaseUrl}latest.json`),
          publicBaseUrl,
        );
        const available = runtime.version.isNewer(manifest.version, currentVersion);
        if (available && open) openInTab(manifest.userscriptUrl);
        const result = Object.freeze({available, version: manifest.version, url: manifest.userscriptUrl});
        notify(available
          ? 'A newer userscript version is available.'
          : 'This userscript is already up to date.');
        return result;
      } catch {
        notify('Unable to check for a userscript update.');
        return Object.freeze({available: false, version: currentVersion, url: null, error: 'update_check_failed'});
      }
    }

    function initialize() {
      registerMenuCommand('检查大航海脚本更新', () => check({open: true}));
    }

    return Object.freeze({initialize, check});
  }

  runtime.userscriptUpdater = Object.freeze({create});
})();

// Source: src/userscript/bootstrap.js
(() => {
  const runtime = globalThis.__BILIBILI_GUARD__;
  if (!runtime?.api || !runtime.broker || !runtime.content || !runtime.panelView) {
    throw new Error('Bilibili guard userscript runtime is not initialized');
  }

  const PUBLIC_BASE = 'https://echoxiaoze.github.io/bilibili-guard-extension-dist/';
  const FRAME_RESOURCES = Object.freeze({
    'assets/frames/captain.png': 'guardFrameCaptain',
    'assets/frames/admiral.png': 'guardFrameAdmiral',
    'assets/frames/governor.png': 'guardFrameGovernor',
  });

  async function start(dependencies) {
    const sleep = milliseconds => new Promise(resolve => dependencies.setTimeout(resolve, milliseconds));
    const apiFetch = runtime.userscriptHttp.createFetch({
      request: dependencies.request,
      allowedHosts: ['api.bilibili.com', 'api.live.bilibili.com', '127.0.0.1'],
    });
    const updateFetch = runtime.userscriptHttp.createFetch({
      request: dependencies.request,
      allowedHosts: ['echoxiaoze.github.io'],
    });
    const apiClient = runtime.api.createBilibiliApi({fetchImpl: apiFetch, sleep, timeoutMs: 8000});
    const sessionArea = runtime.userscriptStorage.createMemoryArea();
    const preferenceArea = runtime.userscriptStorage.createPreferenceArea({
      getValue: dependencies.getValue,
      setValue: dependencies.setValue,
    });
    const broker = runtime.broker.createGuardBroker({api: apiClient, storageArea: sessionArea, now: Date.now});
    const updater = runtime.userscriptUpdater.create({
      requestJson: async url => {
        const response = await updateFetch(url, {method: 'GET'});
        if (!response.ok) throw new Error('Update request failed');
        const text = await response.text();
        if (text.length > 64 * 1024) throw new Error('Update manifest too large');
        return JSON.parse(text);
      },
      currentVersion: dependencies.currentVersion,
      openInTab: url => dependencies.openInTab(url, {active: true, insert: true}),
      registerMenuCommand: dependencies.registerMenuCommand,
      publicBaseUrl: PUBLIC_BASE,
      notify: dependencies.notify,
    });
    updater.initialize();

    const controller = await runtime.content.bootstrap({
      storageArea: preferenceArea,
      controllerOptions: {
        location: dependencies.location,
        addEventListener: dependencies.addEventListener,
        removeEventListener: dependencies.removeEventListener,
        setInterval: dependencies.setInterval,
        clearInterval: dependencies.clearInterval,
        sendMessage: message => broker.handle(message),
        createPanel: options => runtime.panelView.createPanel({
          document: dependencies.document,
          getURL: path => dependencies.getResourceUrl(FRAME_RESOURCES[path]),
          ...options,
        }),
        randomId: dependencies.randomId,
      },
    });
    return Object.freeze({controller, updater});
  }

  runtime.userscriptBootstrap = Object.freeze({PUBLIC_BASE, FRAME_RESOURCES, start});

  if (
    globalThis.document
    && typeof globalThis.GM_xmlhttpRequest === 'function'
    && typeof globalThis.GM_getValue === 'function'
    && typeof globalThis.GM_setValue === 'function'
    && typeof globalThis.GM_getResourceURL === 'function'
    && typeof globalThis.GM_registerMenuCommand === 'function'
    && typeof globalThis.GM_openInTab === 'function'
  ) {
    void start({
      request: globalThis.GM_xmlhttpRequest,
      getValue: globalThis.GM_getValue,
      setValue: globalThis.GM_setValue,
      getResourceUrl: globalThis.GM_getResourceURL,
      registerMenuCommand: globalThis.GM_registerMenuCommand,
      openInTab: globalThis.GM_openInTab,
      currentVersion: '0.3.1.10',
      location: globalThis.location,
      document: globalThis.document,
      addEventListener: globalThis.addEventListener.bind(globalThis),
      removeEventListener: globalThis.removeEventListener.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      randomId: () => globalThis.crypto.randomUUID(),
      notify: message => globalThis.alert(message),
    }).catch(() => {});
  }
})();
