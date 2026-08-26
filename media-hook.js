// Runs in WhatsApp's MAIN world before the application initializes. Content
// scripts cannot see page-owned JavaScript objects, so this small bridge keeps
// decrypted video Blobs long enough for the isolated exporter to request them.
(() => {
  'use strict';

  const HOOK_SOURCE = 'whatsapp-ai-media-hook';
  const CONTENT_SOURCE = 'whatsapp-ai-content';
  const MAX_RECORDS = 12;
  const MAX_PENDING_REQUESTS = 20;
  const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
  const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
  const RECORD_TTL_MS = 10 * 60 * 1000;
  const REQUEST_TTL_MS = 12 * 1000;

  if (window.__whatsappAIMediaHookInstalled) return;
  Object.defineProperty(window, '__whatsappAIMediaHookInstalled', {
    value: true,
    configurable: false,
    enumerable: false
  });

  const records = new Map();
  const pendingRequests = new Map();
  let activeContext = null;
  let totalBytes = 0;

  const updateDiagnostics = () => {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute('data-whatsapp-ai-media-hook', 'ready');
    root.setAttribute('data-whatsapp-ai-video-blobs', String(records.size));
  };
  if (document.documentElement) updateDiagnostics();
  else document.addEventListener('DOMContentLoaded', updateDiagnostics, { once: true });

  const post = payload => window.postMessage({ source: HOOK_SOURCE, ...payload }, location.origin);

  const cleanup = () => {
    const now = Date.now();
    for (const [url, record] of records) {
      if (now - record.createdAt > RECORD_TTL_MS) {
        records.delete(url);
        totalBytes -= record.size;
      }
    }
    for (const [requestId, request] of pendingRequests) {
      if (request.expiresAt <= now) pendingRequests.delete(requestId);
    }
    while (records.size > MAX_RECORDS || totalBytes > MAX_TOTAL_BYTES) {
      const oldestKey = records.keys().next().value;
      if (!oldestKey) break;
      const oldest = records.get(oldestKey);
      records.delete(oldestKey);
      totalBytes -= oldest?.size || 0;
    }
    updateDiagnostics();
  };

  const findRecord = request => {
    if (request.url && records.has(request.url)) return records.get(request.url);

    const candidates = Array.from(records.values()).reverse();
    if (request.contextKey) {
      const contextual = candidates.find(record => record.contextKey === request.contextKey);
      if (contextual) return contextual;
    }
    if (Array.isArray(request.urls)) {
      const byUrl = candidates.find(record => request.urls.includes(record.url));
      if (byUrl) return byUrl;
    }
    return null;
  };

  const respondWithRecord = (requestId, record) => {
    if (!record?.blob) return false;
    post({
      type: 'video-blob',
      requestId,
      contextKey: record.contextKey || '',
      url: record.url,
      mimeType: record.mimeType,
      size: record.size,
      blob: record.blob
    });
    return true;
  };

  const resolvePendingRequests = record => {
    const now = Date.now();
    for (const [requestId, request] of pendingRequests) {
      if (request.expiresAt <= now) {
        pendingRequests.delete(requestId);
        continue;
      }
      const matchesContext = request.contextKey && request.contextKey === record.contextKey;
      const matchesUrl = request.url === record.url || request.urls?.includes(record.url);
      if (matchesContext || matchesUrl) {
        respondWithRecord(requestId, record);
        pendingRequests.delete(requestId);
      }
    }
  };

  const rememberVideoBlob = (blob, url) => {
    const activeVideoRequest = activeContext?.expiresAt > Date.now();
    const mimeType = blob instanceof Blob ? blob.type || '' : '';
    const contextCompatibleType = !mimeType || /^application\/(?:octet-stream|mp4)$/i.test(mimeType);
    if (!(blob instanceof Blob) || blob.size > MAX_CAPTURE_BYTES ||
        (!/^video\//i.test(mimeType) && !(activeVideoRequest && contextCompatibleType))) return;

    cleanup();
    const record = {
      blob,
      url,
      mimeType: mimeType || 'video/mp4',
      size: blob.size,
      createdAt: Date.now(),
      contextKey: activeContext?.expiresAt > Date.now() ? activeContext.contextKey : ''
    };
    const previous = records.get(url);
    if (previous) totalBytes -= previous.size;
    records.set(url, record);
    totalBytes += record.size;
    updateDiagnostics();

    post({
      type: 'video-available',
      contextKey: record.contextKey,
      url,
      mimeType: record.mimeType,
      size: record.size,
      blob: record.blob
    });
    resolvePendingRequests(record);
    cleanup();
  };

  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function createObjectURL(object) {
    const url = originalCreateObjectURL(object);
    try {
      rememberVideoBlob(object, url);
    } catch (error) {
      console.debug('WhatsApp AI media hook could not retain a Blob', error);
    }
    return url;
  };

  // Keep the Blob reference even after WhatsApp revokes its short-lived URL.
  // The original revoke still runs, so the page's normal resource lifecycle is
  // unchanged and the retained copy is evicted by the limits above.
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function revokeObjectURL(url) {
    return originalRevokeObjectURL(url);
  };

  // WhatsApp's Download action commonly creates an anchor only for the final
  // decrypted file. During an exporter-owned capture window, consume that URL
  // into the bridge instead of starting a second, unrelated browser download.
  if (typeof HTMLAnchorElement !== 'undefined') {
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      const captureContext = activeContext?.expiresAt > Date.now() ? activeContext : null;
      const href = this.href || this.getAttribute('href') || '';
      const isCapturableUrl = /^blob:/i.test(href) || /^data:video\//i.test(href);
      const isDownload = this.hasAttribute?.('download') || Boolean(this.download);
      if (!captureContext || captureContext.anchorConsumed || !isDownload || !isCapturableUrl) {
        return originalAnchorClick.call(this);
      }

      captureContext.anchorConsumed = true;
      const anchor = this;
      const retained = records.get(href);
      if (retained?.blob && retained.size <= MAX_CAPTURE_BYTES) {
        retained.contextKey = captureContext.contextKey;
        resolvePendingRequests(retained);
        return;
      }

      fetch(href).then(response => {
        if (!response.ok) throw new Error(`Media download failed with ${response.status}`);
        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURE_BYTES) {
          throw new Error('Media download exceeds the capture limit');
        }
        return response.blob();
      }).then(blob => {
        const previousContext = activeContext;
        activeContext = captureContext;
        const acceptedType = blob.size <= MAX_CAPTURE_BYTES && (
          /^video\//i.test(blob.type || '') ||
          (!blob.type || /^application\/(?:octet-stream|mp4)$/i.test(blob.type))
        );
        if (acceptedType) rememberVideoBlob(blob, href);
        else originalAnchorClick.call(anchor);
        activeContext = previousContext;
      }).catch(() => originalAnchorClick.call(anchor));
    };
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== CONTENT_SOURCE) return;

    cleanup();
    if (message.type === 'ping-media-hook') {
      post({ type: 'hook-ready' });
      return;
    }

    if (message.type === 'begin-video-capture') {
      if (activeContext?.expiresAt > Date.now()) return;
      const contextKey = String(message.contextKey || '').slice(0, 256);
      if (!contextKey) return;
      activeContext = {
        contextKey,
        expiresAt: Date.now() + REQUEST_TTL_MS,
        anchorConsumed: false
      };
      return;
    }

    if (message.type === 'end-video-capture') {
      if (!message.contextKey || activeContext?.contextKey === message.contextKey) activeContext = null;
      return;
    }

    if (message.type === 'request-video-blob') {
      const requestId = String(message.requestId || '').slice(0, 256);
      if (!requestId) return;
      const request = {
        contextKey: String(message.contextKey || '').slice(0, 256),
        url: String(message.url || '').slice(0, 4096),
        urls: Array.isArray(message.urls)
          ? message.urls.slice(0, 20).map(url => String(url).slice(0, 4096))
          : []
      };
      const record = findRecord(request);
      if (!respondWithRecord(requestId, record)) {
        while (pendingRequests.size >= MAX_PENDING_REQUESTS) {
          pendingRequests.delete(pendingRequests.keys().next().value);
        }
        pendingRequests.set(requestId, {
          ...request,
          expiresAt: Date.now() + Math.min(Number(message.timeoutMs) || REQUEST_TTL_MS, REQUEST_TTL_MS)
        });
      }
      return;
    }

    if (message.type === 'cancel-video-request') {
      pendingRequests.delete(String(message.requestId || '').slice(0, 256));
    }
  });

  post({ type: 'hook-ready' });
})();
