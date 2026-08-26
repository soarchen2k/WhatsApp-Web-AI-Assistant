import JSZip from 'jszip';
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import {
  MESSAGE_CACHE_MAX_BYTES_PER_CHAT,
  MESSAGE_CACHE_TOTAL_BUDGET_BYTES,
  MEDIA_CACHE_MAX_ASSET_BYTES,
  MEDIA_CACHE_TOTAL_BUDGET_BYTES,
  chooseOldestEvictions,
  createBoundedMessageEnvelope,
  getSerializedByteLength,
  planMediaEvictions
} from './src/cache-policy.mjs';

// Content script that runs on WhatsApp Web
// Prevent multiple injections
if (window.whatsappAILoaded) {
  console.log('WhatsApp AI already loaded');
} else {
  window.whatsappAILoaded = true;

// Shorthand for chrome.i18n.getMessage with a fallback to the key itself
function t(key, subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

// Keep the model and endpoint in one place so generation and the connection
// test cannot drift apart when Google retires a model.
const GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_GENERATE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// Versioned deliberately: earlier cache records used unstable DOM-based keys
// and could be duplicated after WhatsApp re-rendered a conversation.
const MESSAGE_CACHE_SCHEMA_VERSION = 3;
const MEDIA_HOOK_SOURCE = 'whatsapp-ai-media-hook';
const MEDIA_CONTENT_SOURCE = 'whatsapp-ai-content';
const MEDIA_DATABASE_NAME = 'whatsapp-ai-export-media';
const MEDIA_DATABASE_VERSION = 2;
const MEDIA_STORE_NAME = 'assets';
const MEDIA_METADATA_STORE_NAME = 'asset-metadata';
// Large camera originals can freeze WhatsApp while docx hashes and compresses
// every byte. Word receives optimized copies and stops adding media only after
// this bounded in-document budget; conversation text is never truncated.
const WORD_MEDIA_BUDGET_BYTES = 32 * 1024 * 1024;
const WORD_IMAGE_MAX_DIMENSION = 1280;

class WhatsAppAI {
  constructor() {
    this.messages = [];
    this.apiKey = '';
    this.systemInstructions = '';
    this.aiProvider = 'gemini';
    this.deepseekApiKey = '';
    this.deepseekModel = 'deepseek-v4-flash';
    this.messageCache = new Map(); // Local cache for messages
    this.chatId = null; // Current chat identifier
    this.chatSwitchObserver = null;
    this.chatSwitchTimer = null;
    this.chatLoadSequence = 0;
    this.pendingChatId = null;
    this.isSwitchingChat = false;
    this.scrollContainer = null;
    this.scrollHandler = null;
    this.cacheSaveTimer = null;
    this.historySync = null;
    this.historySyncSequence = 0;
    this.exportProgressNotification = null;
    this.mediaHookReady = false;
    this.pendingVideoCaptureRequests = new Map();
    this.videoCaptureSequence = 0;
    this.videoBlobCache = new Map();
    this.historyVideoCaptureAttempts = new Map();
    this.mediaDatabasePromise = null;
    this.cacheStorageWarningsShown = new Set();
    this.shortDateOrder = null;
    this.setupMediaCaptureBridge();
    this.init();
  }

  setupMediaCaptureBridge() {
    window.addEventListener('message', event => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (!message || message.source !== MEDIA_HOOK_SOURCE) return;

      if (message.type === 'hook-ready') {
        this.mediaHookReady = true;
        return;
      }

      // The MAIN-world hook sees WhatsApp's decrypted Blob before its temporary
      // object URL is revoked. Retain context-tagged videos immediately instead
      // of relying solely on a second /stream/video request, which is not
      // consistently reusable for every historical message.
      if (message.type === 'video-available') {
        if (message.contextKey && message.blob instanceof Blob && message.blob.size >= 128) {
          this.videoBlobCache.set(message.contextKey, {
            blob: message.blob,
            src: message.url || '',
            mimeType: message.mimeType || message.blob.type || 'video/mp4'
          });
        }
        return;
      }

      if (message.type !== 'video-blob' || !message.requestId) return;
      const pending = this.pendingVideoCaptureRequests.get(message.requestId);
      if (!pending) return;
      this.pendingVideoCaptureRequests.delete(message.requestId);
      clearTimeout(pending.timer);

      if (message.blob instanceof Blob && message.blob.size >= 128) {
        pending.resolve({
          blob: message.blob,
          src: message.url || '',
          mimeType: message.mimeType || message.blob.type || 'video/mp4'
        });
      } else {
        pending.resolve(null);
      }
    });

    window.postMessage({ source: MEDIA_CONTENT_SOURCE, type: 'ping-media-hook' }, location.origin);
  }

  async init() {
    // Keep API keys on this device. Older releases stored them in sync storage;
    // migrate those values once without forcing existing users to re-enter them.
    const [settings, localSecrets] = await Promise.all([
      chrome.storage.sync.get([
        'geminiApiKey', 'systemInstructions', 'aiProvider', 'deepseekApiKey', 'deepseekModel'
      ]),
      chrome.storage.local.get(['geminiApiKey', 'deepseekApiKey'])
    ]);
    this.apiKey = localSecrets.geminiApiKey || settings.geminiApiKey || '';
    this.systemInstructions = settings.systemInstructions || t('defaultSystemInstructions');
    this.aiProvider = settings.aiProvider || 'gemini';
    this.deepseekApiKey = localSecrets.deepseekApiKey || settings.deepseekApiKey || '';
    this.deepseekModel = settings.deepseekModel || 'deepseek-v4-flash';
    if (settings.geminiApiKey || settings.deepseekApiKey) {
      try {
        await chrome.storage.local.set({
          geminiApiKey: this.apiKey,
          deepseekApiKey: this.deepseekApiKey
        });
        await chrome.storage.sync.remove(['geminiApiKey', 'deepseekApiKey']);
      } catch (error) {
        console.error('Unable to migrate API keys to local storage:', error);
        this.showCacheStorageWarning('warnCacheStorageFailed');
      }
    }

    // Initialize chat tracking before scanning the conversation. This prevents a
    // late cache load from replacing messages that were just scanned.
    await this.initializeChatTracking();
    
    // Wait for WhatsApp to load
    this.waitForWhatsApp();
  }

  async initializeChatTracking() {
    await this.switchToChat(this.getCurrentChatId(), true);
    this.setupChatChangeMonitoring();
    this.setupScrollMonitoring();
  }

  getCurrentChatId() {
    // WhatsApp normally exposes a stable data-id on the selected chat-list item.
    // Prefer it over a display name so two chats with the same title never share
    // a cache. The title is only a fallback for WhatsApp DOM variants that don't
    // expose this identifier.
    const activeChatSelectors = [
      '#pane-side [aria-selected="true"]',
      '[data-testid="chat-list"] [aria-selected="true"]',
      '[role="listbox"] [aria-selected="true"]'
    ];

    for (const selector of activeChatSelectors) {
      const activeChat = document.querySelector(selector);
      if (!activeChat) continue;

      const chatElement = activeChat.closest('[data-id], [data-jid], [data-chat-id]') || activeChat;
      for (const attribute of ['data-id', 'data-jid', 'data-chat-id']) {
        const value = chatElement.getAttribute(attribute);
        if (value) return `id:${value}`;
      }
    }

    // Try to get an identifier from the active conversation header before
    // falling back to the visible title.
    const chatTitle = document.querySelector('[data-testid="conversation-info-header-chat-title"]') ||
                     document.querySelector('header span[title]') ||
                     document.querySelector('header span[dir="auto"]');
    
    if (chatTitle) {
      const headerElement = chatTitle.closest('[data-id], [data-jid], [data-chat-id]') || chatTitle;
      for (const attribute of ['data-id', 'data-jid', 'data-chat-id']) {
        const value = headerElement.getAttribute(attribute);
        if (value) return `id:${value}`;
      }

      const title = chatTitle.textContent?.trim();
      if (title) return `title:${title}`;
    }
    
    return 'no-active-chat';
  }

  getCacheKey(chatId = this.chatId) {
    return `whatsapp_messages_v${MESSAGE_CACHE_SCHEMA_VERSION}_${encodeURIComponent(chatId)}`;
  }

  showCacheStorageWarning(messageKey = 'warnCacheStorageLimit') {
    if (this.cacheStorageWarningsShown.has(messageKey)) return;
    this.cacheStorageWarningsShown.add(messageKey);
    console.warn(t(messageKey));
    if (document.body) this.showNotification(t(messageKey), 'warning');
  }

  openMediaDatabase() {
    if (this.mediaDatabasePromise) return this.mediaDatabasePromise;
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);

    this.mediaDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(MEDIA_DATABASE_NAME, MEDIA_DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(MEDIA_STORE_NAME)
          ? request.transaction.objectStore(MEDIA_STORE_NAME)
          : database.createObjectStore(MEDIA_STORE_NAME, { keyPath: 'key' });
        const metadataStore = database.objectStoreNames.contains(MEDIA_METADATA_STORE_NAME)
          ? request.transaction.objectStore(MEDIA_METADATA_STORE_NAME)
          : database.createObjectStore(MEDIA_METADATA_STORE_NAME, { keyPath: 'key' });
        if (!store.indexNames.contains('chatId')) store.createIndex('chatId', 'chatId', { unique: false });
        if (!store.indexNames.contains('messageKey')) store.createIndex('messageKey', 'messageKey', { unique: false });
        if (request.oldVersion < 2) {
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const { key, size, updatedAt } = cursor.value;
            metadataStore.put({ key, size: size || 0, updatedAt: updatedAt || 0 });
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open the media database'));
      request.onblocked = () => reject(new Error('The media database upgrade was blocked'));
    }).catch(error => {
      console.warn('Persistent media cache is unavailable:', error);
      this.mediaDatabasePromise = null;
      return null;
    });
    return this.mediaDatabasePromise;
  }

  getPersistentMediaMetadata(database) {
    return new Promise((resolve, reject) => {
      const request = database.transaction(MEDIA_METADATA_STORE_NAME, 'readonly')
        .objectStore(MEDIA_METADATA_STORE_NAME)
        .getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  getPersistentMessageKey(message, chatId = message?.chatId || this.chatId) {
    if (message?.persistentMessageKey) return message.persistentMessageKey;
    const identity = message?.messageId
      ? `id:${message.messageId}`
      : [message?.timestamp, message?.sender, String(message?.text || '').replace(/\s+/g, ' ').trim()]
          .map(value => String(value || ''))
          .join('|');
    const key = `${chatId || 'no-chat'}|${identity}`;
    if (message) message.persistentMessageKey = key;
    return key;
  }

  getPersistentMediaSlot(media, role = 'attachment', index = 0) {
    return `${role}|${media?.kind || 'unknown'}|${index}`;
  }

  async getPersistentMediaForMessage(message) {
    try {
      const database = await this.openMediaDatabase();
      if (!database) return [];
      const messageKey = this.getPersistentMessageKey(message);
      return await new Promise((resolve, reject) => {
        const request = database.transaction(MEDIA_STORE_NAME, 'readonly')
          .objectStore(MEDIA_STORE_NAME)
          .index('messageKey')
          .getAll(messageKey);
        request.onsuccess = () => resolve((request.result || []).filter(record => record.blob instanceof Blob));
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn('Unable to read persistent media:', error);
      return [];
    }
  }

  attachPersistentMediaReference(message, record) {
    const reference = {
      key: record.key,
      slot: record.slot,
      kind: record.kind,
      role: record.role,
      index: record.index,
      mimeType: record.mimeType,
      size: record.size,
      isVideoPoster: record.isVideoPoster
    };
    const attach = target => {
      if (!target) return;
      target.persistentMessageKey = record.messageKey;
      const references = Array.isArray(target.mediaRefs) ? target.mediaRefs : [];
      target.mediaRefs = [...references.filter(item => item.key !== record.key), reference];
    };

    attach(message);
    const cached = Array.from(this.messageCache.values()).find(candidate =>
      candidate === message ||
      (message.messageId && candidate.messageId === message.messageId) ||
      candidate.persistentMessageKey === record.messageKey ||
      this.areSameMessage(candidate, message)
    );
    if (cached !== message) attach(cached);
  }

  async persistMediaAsset(message, media, blob, { role = 'attachment', index = 0 } = {}) {
    if (!(blob instanceof Blob) || blob.size < 128 || !message) return null;
    if (blob.size > MEDIA_CACHE_MAX_ASSET_BYTES) {
      this.showCacheStorageWarning('warnMediaTooLarge');
      return null;
    }
    try {
      const database = await this.openMediaDatabase();
      if (!database) return null;
      const messageKey = this.getPersistentMessageKey(message);
      const slot = this.getPersistentMediaSlot(media, role, index);
      const record = {
        key: `${messageKey}|${slot}`,
        chatId: message.chatId || this.chatId || 'no-chat',
        messageKey,
        slot,
        role,
        index,
        kind: media?.kind || (/^video\//i.test(blob.type) ? 'video' : 'image'),
        mimeType: media?.mimeType || blob.type || '',
        source: media?.src || '',
        size: blob.size,
        isVideoPoster: Boolean(media?.isVideoPoster),
        updatedAt: Date.now(),
        blob
      };
      const existingRecords = await this.getPersistentMediaMetadata(database);
      const mediaPlan = planMediaEvictions(existingRecords, record, MEDIA_CACHE_TOTAL_BUDGET_BYTES);
      const evictionKeys = mediaPlan.removeKeys;
      const projectedBytes = mediaPlan.projectedBytes;
      if (projectedBytes > MEDIA_CACHE_TOTAL_BUDGET_BYTES) {
        this.showCacheStorageWarning('warnCacheStorageLimit');
        return null;
      }
      await new Promise((resolve, reject) => {
        const transaction = database.transaction([MEDIA_STORE_NAME, MEDIA_METADATA_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(MEDIA_STORE_NAME);
        const metadataStore = transaction.objectStore(MEDIA_METADATA_STORE_NAME);
        evictionKeys.forEach(key => {
          store.delete(key);
          metadataStore.delete(key);
        });
        store.put(record);
        metadataStore.put({ key: record.key, size: record.size, updatedAt: record.updatedAt });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Media cache transaction aborted'));
      });
      if (evictionKeys.length > 0) this.showCacheStorageWarning('warnMediaCacheEvicted');
      this.attachPersistentMediaReference(message, record);
      this.scheduleCacheSave();
      return record;
    } catch (error) {
      console.warn('Unable to persist media attachment:', error);
      this.showCacheStorageWarning('warnCacheStorageFailed');
      return null;
    }
  }

  async clearPersistentMediaForChat(chatId = this.chatId) {
    try {
      const database = await this.openMediaDatabase();
      if (!database) return;
      const keys = await new Promise((resolve, reject) => {
        const request = database.transaction(MEDIA_STORE_NAME, 'readonly')
          .objectStore(MEDIA_STORE_NAME)
          .index('chatId')
          .getAllKeys(chatId || 'no-chat');
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      if (keys.length === 0) return;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction([MEDIA_STORE_NAME, MEDIA_METADATA_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(MEDIA_STORE_NAME);
        const metadataStore = transaction.objectStore(MEDIA_METADATA_STORE_NAME);
        keys.forEach(key => {
          store.delete(key);
          metadataStore.delete(key);
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Media cache cleanup aborted'));
      });
    } catch (error) {
      console.warn('Unable to clear persistent media cache:', error);
    }
  }

  async loadCachedMessages(chatId) {
    try {
      const cacheKey = this.getCacheKey(chatId);
      const result = await chrome.storage.local.get([cacheKey]);
      
      if (result[cacheKey]) {
        const cachedData = typeof result[cacheKey] === 'string'
          ? JSON.parse(result[cacheKey])
          : result[cacheKey];
        if (Array.isArray(cachedData)) return new Map(cachedData);
        if (Array.isArray(cachedData?.entries)) {
          if (cachedData.truncated) this.showCacheStorageWarning('warnCacheHistoryTruncated');
          return new Map(cachedData.entries);
        }
      }
      return new Map();
    } catch (error) {
      console.error('Error loading cached messages:', error);
      this.showCacheStorageWarning('warnCacheStorageFailed');
      return new Map();
    }
  }

  async saveCachedMessages(chatId = this.chatId, cache = this.messageCache) {
    try {
      const cacheKey = this.getCacheKey(chatId);
      // DOM nodes and WhatsApp blob URLs are session-only. Persisting either
      // makes a later export use stale media references, so only retain the
      // message metadata and recapture attachments from the rendered bubble.
      const dataToStore = Array.from(cache.entries()).map(([key, message]) => [key, {
        ...message,
        element: undefined,
        media: [],
        // Blob URLs expire with the page, but WhatsApp's quoted-media preview
        // also includes a compact data:image source. Keep one bounded preview
        // so quoted images still export after a page refresh or cache reload.
        quote: message.quote ? {
          ...message.quote,
          media: this.getPersistentQuotedMedia(message.quote.media)
        } : null
      }]);
      
      const envelope = createBoundedMessageEnvelope(
        dataToStore,
        MESSAGE_CACHE_SCHEMA_VERSION,
        MESSAGE_CACHE_MAX_BYTES_PER_CHAT
      );

      const allStored = await chrome.storage.local.get(null);
      const oldItemBytes = getSerializedByteLength(allStored[cacheKey]);
      let projectedBytes = await chrome.storage.local.getBytesInUse(null);
      projectedBytes = projectedBytes - oldItemBytes + getSerializedByteLength(envelope);
      if (projectedBytes > MESSAGE_CACHE_TOTAL_BUDGET_BYTES) {
        const candidates = Object.entries(allStored)
          .filter(([key]) => key !== cacheKey && key.startsWith(`whatsapp_messages_v${MESSAGE_CACHE_SCHEMA_VERSION}_`))
          .map(([key, value]) => {
            let parsed = value;
            try {
              if (typeof value === 'string') parsed = JSON.parse(value);
            } catch {
              parsed = null;
            }
            return { key, updatedAt: parsed?.updatedAt || 0, bytes: getSerializedByteLength(value) };
          });
        const evictionPlan = chooseOldestEvictions(
          candidates,
          projectedBytes,
          MESSAGE_CACHE_TOTAL_BUDGET_BYTES
        );
        const removeKeys = evictionPlan.removeKeys;
        projectedBytes = evictionPlan.projectedBytes;
        if (removeKeys.length > 0) {
          await chrome.storage.local.remove(removeKeys);
          this.showCacheStorageWarning('warnCacheChatsEvicted');
        }
      }
      if (projectedBytes > MESSAGE_CACHE_TOTAL_BUDGET_BYTES) {
        throw new Error('Message cache storage budget exceeded');
      }

      await chrome.storage.local.set({ [cacheKey]: envelope });

      if (envelope.truncated) this.showCacheStorageWarning('warnCacheHistoryTruncated');
      
      console.log(`Saved ${envelope.entries.length} messages to persistent cache`);
    } catch (error) {
      console.error('Error saving cached messages:', error);
      this.showCacheStorageWarning('warnCacheStorageFailed');
      return false;
    }
    return true;
  }

  async switchToChat(nextChatId, force = false) {
    if (!nextChatId || (!force && (nextChatId === 'no-active-chat' || nextChatId === this.chatId || nextChatId === this.pendingChatId))) return;

    if (this.historySync?.active && nextChatId !== this.historySync.chatId) {
      this.cancelHistorySync('chat-change');
    }

    const loadSequence = ++this.chatLoadSequence;
    const previousChatId = this.chatId;
    const previousCache = this.messageCache;
    this.pendingChatId = nextChatId;
    this.isSwitchingChat = true;
    let switched = false;

    try {
      if (previousChatId && previousChatId !== nextChatId) {
        // Pass a snapshot so an asynchronous write can never persist messages
        // from the chat we are about to enter under the previous chat's key.
        await this.saveCachedMessages(previousChatId, new Map(previousCache));
      }

      const cachedMessages = await this.loadCachedMessages(nextChatId);
      if (loadSequence !== this.chatLoadSequence) return;

      this.chatId = nextChatId;
      this.messageCache = cachedMessages;
      if (previousChatId && previousChatId !== nextChatId) {
        this.videoBlobCache.clear();
        this.historyVideoCaptureAttempts.clear();
      }
      this.updateCacheIndicator();
      this.setupScrollMonitoring();
      switched = true;
      console.log(`Switched message cache to chat: ${nextChatId}`);
    } finally {
      if (loadSequence === this.chatLoadSequence) {
        this.pendingChatId = null;
        this.isSwitchingChat = false;
        if (switched) this.refreshMessageCache();
      }
    }
  }

  setupChatChangeMonitoring() {
    if (this.chatSwitchObserver || !document.body) return;

    const checkForChatChange = () => {
      clearTimeout(this.chatSwitchTimer);
      this.chatSwitchTimer = setTimeout(() => {
        const nextChatId = this.getCurrentChatId();
        if (nextChatId !== this.chatId) {
          this.switchToChat(nextChatId);
        }
      }, 250);
    };

    this.chatSwitchObserver = new MutationObserver(checkForChatChange);
    this.chatSwitchObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  setupScrollMonitoring() {
    const chatContainer = this.getChatContainer();
    if (!chatContainer) return;

    if (chatContainer === this.scrollContainer) return;

    if (this.scrollContainer && this.scrollHandler) {
      this.scrollContainer.removeEventListener('scroll', this.scrollHandler);
    }

    // Monitor scroll events to refresh message cache
    this.scrollContainer = chatContainer;
    this.scrollHandler = this.debounce(() => {
      this.refreshMessageCache();
    }, 500);
    chatContainer.addEventListener('scroll', this.scrollHandler);

    // Initial message scan
    setTimeout(() => {
      this.refreshMessageCache();
    }, 2000);
  }

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  waitForWhatsApp() {
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max wait time
    
    const checkInterval = setInterval(() => {
      attempts++;
      
      // Multiple selectors to check if WhatsApp has loaded
      const chatArea = document.querySelector('[data-testid="conversation-panel"]') || 
                      document.querySelector('#main') ||
                      document.querySelector('div[aria-label="Message list"]') ||
                      document.querySelector('[data-testid="chat-list"]') ||
                      document.querySelector('#pane-side');
      
      console.log(`WhatsApp AI: Checking for WhatsApp load... Attempt ${attempts}`);
      
      if (chatArea) {
        clearInterval(checkInterval);
        console.log('WhatsApp AI: WhatsApp loaded, setting up UI');
        this.setupUI();
        this.observeMessages();
      } else if (attempts >= maxAttempts) {
        clearInterval(checkInterval);
        console.log('WhatsApp AI: Timeout waiting for WhatsApp to load');
        // Still try to setup UI in case selectors changed
        this.setupUI();
      }
    }, 1000);
  }

  setupUI() {
    // Check if UI is already setup
    if (document.getElementById('whatsapp-ai-fab')) {
      console.log('WhatsApp AI: UI already exists');
      return;
    }

      console.log('WhatsApp AI: Setting up UI');
      
      // Create floating action button with cache status
      const cacheSize = this.messageCache.size;
      const fabTitle = cacheSize > 0 ? t('fabTitleCached', [String(cacheSize)]) : t('fabTitle');

      const fab = document.createElement('div');
      fab.id = 'whatsapp-ai-fab';
      fab.innerHTML = `
        <div class="ai-fab-button" title="${fabTitle}">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
          </svg>
          ${cacheSize > 0 ? `<div class="cache-indicator">${cacheSize}</div>` : ''}
        </div>
        <div class="ai-menu" id="ai-menu" style="display: none;">
          <div class="history-sync-status" id="history-sync-status" hidden></div>
          <button id="export-conversation">${t('menuExport')}</button>
          <button id="generate-response">${t('menuGenerate')}</button>
          <button id="load-full-history">${t('menuLoadHistory')}</button>
          <button id="clear-cache">${t('menuClearCache')}</button>
          <button id="settings">${t('menuSettings')}</button>
        </div>
      `;    document.body.appendChild(fab);

    // Add event listeners with error handling
    try {
      const fabButton = document.querySelector('.ai-fab-button');
      const exportBtn = document.getElementById('export-conversation');
      const generateBtn = document.getElementById('generate-response');
      const loadHistoryBtn = document.getElementById('load-full-history');
      const clearCacheBtn = document.getElementById('clear-cache');
      const settingsBtn = document.getElementById('settings');

      if (fabButton) fabButton.addEventListener('click', this.toggleMenu.bind(this));
      if (exportBtn) exportBtn.addEventListener('click', this.exportConversation.bind(this));
      if (generateBtn) generateBtn.addEventListener('click', this.generateResponse.bind(this));
      if (loadHistoryBtn) loadHistoryBtn.addEventListener('click', this.loadFullHistory.bind(this));
      if (clearCacheBtn) clearCacheBtn.addEventListener('click', this.clearMessageCache.bind(this));
      if (settingsBtn) settingsBtn.addEventListener('click', this.openSettings.bind(this));
      
      console.log('WhatsApp AI: UI setup complete');
      this.updateHistorySyncUI();
      this.showNotification(t('notifyActivated'), 'success');
    } catch (error) {
      console.error('WhatsApp AI: Error setting up event listeners:', error);
    }
  }

  toggleMenu() {
    const menu = document.getElementById('ai-menu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  }

  observeMessages() {
    const chatContainer = document.querySelector('[data-testid="conversation-panel"]') || 
                         document.querySelector('#main .copyable-area');
    
    if (!chatContainer) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE && this.isMessageNode(node)) {
              // New message detected - could trigger auto-response here
              console.log('New message detected');
            }
          });
        }
      });
    });

    observer.observe(chatContainer, {
      childList: true,
      subtree: true
    });
  }

  isMessageNode(node) {
    return node.classList && (
      node.classList.contains('message-in') || 
      node.classList.contains('message-out') ||
      node.matches('[data-testid="msg-container"], [data-testid^="conv-msg-"]') ||
      node.querySelector('.message-in, .message-out, [data-testid="msg-container"], [data-testid^="conv-msg-"]')
    );
  }

  async extractMessages(forExport = false) {
    // First, refresh cache with currently visible messages
    this.refreshMessageCache();
    
    // A cache can briefly contain an older fallback-key record alongside the
    // same message's stable WhatsApp id. Collapse only those legacy copies
    // before sorting; two distinct stable ids are always kept.
    const allCachedMessages = this.deduplicateMessages(Array.from(this.messageCache.values()));
    
    if (allCachedMessages.length === 0) {
      console.log('No cached messages found, scanning current view...');
      return this.sortMessages(this.deduplicateMessages(this.scanVisibleMessages()));
    }

    const sortedMessages = this.sortMessages(allCachedMessages);

    // For export, return ALL messages. For AI processing, return recent 50
    if (forExport) {
      console.log(`Exporting all ${sortedMessages.length} cached messages`);
      return sortedMessages;
    } else {
      const recentMessages = sortedMessages.slice(-50);
      console.log(`Using ${recentMessages.length} messages from cache for AI (total cached: ${allCachedMessages.length})`);
      return recentMessages;
    }
  }

  sortMessages(messages) {
    for (const message of messages) {
      const shortDate = String(message?.timestamp || '').match(/(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
      if (!shortDate) continue;
      const first = Number(shortDate[1]);
      const second = Number(shortDate[2]);
      if (first > 12 && second <= 12) {
        this.shortDateOrder = 'dmy';
        break;
      }
      if (second > 12 && first <= 12) {
        this.shortDateOrder = 'mdy';
        break;
      }
    }
    return [...messages].sort((a, b) => {
      const timeA = this.parseTimestamp(a.timestamp);
      const timeB = this.parseTimestamp(b.timestamp);
      return timeA - timeB;
    });
  }

  parseTimestamp(timestampStr) {
    try {
      const value = String(timestampStr || '').trim();
      const timeMatch = value.match(/(\d{1,2}):(\d{2})(?:\s*(:\s*\d{2}))?\s*(AM|PM|上午|下午)?/i);
      if (!timeMatch) return Number.MAX_SAFE_INTEGER;

      let hours = Number.parseInt(timeMatch[1], 10);
      const minutes = Number.parseInt(timeMatch[2], 10);
      const seconds = timeMatch[3] ? Number.parseInt(timeMatch[3].replace(':', ''), 10) : 0;
      const meridiem = (timeMatch[4] || '').toLowerCase();
      if ((meridiem === 'pm' || meridiem === '下午') && hours < 12) hours += 12;
      if ((meridiem === 'am' || meridiem === '上午') && hours === 12) hours = 0;

      let year;
      let month;
      let day;

      // e.g. "10:43, 2026年8月21日" (Chinese WhatsApp UI)
      const chineseDate = value.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
      // e.g. "10:43, 21/08/2026", "10:43 AM, 8/21/2026" or "10:43, 2026-08-21"
      const shortDate = value.match(/(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
      const ymdDate = value.match(/(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})/);

      if (chineseDate) {
        [, year, month, day] = chineseDate.map(Number);
      } else if (ymdDate) {
        [, year, month, day] = ymdDate.map(Number);
      } else if (shortDate) {
        const first = Number(shortDate[1]);
        const second = Number(shortDate[2]);
        year = Number(shortDate[3]);
        let monthFirst = first <= 12 && second > 12;
        if (first > 12 && second <= 12) this.shortDateOrder = 'dmy';
        if (second > 12 && first <= 12) this.shortDateOrder = 'mdy';
        if (first <= 12 && second <= 12 && this.shortDateOrder) {
          monthFirst = this.shortDateOrder === 'mdy';
        } else if (first <= 12 && second <= 12) {
          try {
            const order = new Intl.DateTimeFormat(undefined, {
              year: 'numeric', month: 'numeric', day: 'numeric'
            }).formatToParts(new Date(2001, 10, 22)).filter(part =>
              ['year', 'month', 'day'].includes(part.type)
            ).map(part => part.type);
            monthFirst = order.indexOf('month') < order.indexOf('day');
          } catch (error) {
            monthFirst = false;
          }
        }
        if (monthFirst) {
          month = first;
          day = second;
        } else {
          day = first;
          month = second;
        }
      } else {
        const today = new Date();
        year = today.getFullYear();
        month = today.getMonth() + 1;
        day = today.getDate();
      }

      const parsedDate = new Date(year, month - 1, day, hours, minutes, seconds);
      const result = parsedDate.getTime();
      const validDate = parsedDate.getFullYear() === year && parsedDate.getMonth() === month - 1 &&
                        parsedDate.getDate() === day && parsedDate.getHours() === hours &&
                        parsedDate.getMinutes() === minutes;
      return Number.isNaN(result) || !validDate ? Number.MAX_SAFE_INTEGER : result;
    } catch (error) {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  parseDateInput(value, { endExclusive = false } = {}) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day + (endExclusive ? 1 : 0));
    const expected = new Date(year, month - 1, day);
    if (expected.getFullYear() !== year || expected.getMonth() !== month - 1 || expected.getDate() !== day) {
      return null;
    }
    return date.getTime();
  }

  createExportDateRange(startDate, endDate) {
    if (!startDate && !endDate) return null;
    const startMs = this.parseDateInput(startDate);
    const endExclusiveMs = this.parseDateInput(endDate, { endExclusive: true });
    if (startMs === null || endExclusiveMs === null || startMs >= endExclusiveMs) return null;
    return { startDate, endDate, startMs, endExclusiveMs };
  }

  getRangeTimestamp(timestamp) {
    if (!this.getDatePart(timestamp)) return null;
    const parsed = this.parseTimestamp(timestamp);
    return parsed === Number.MAX_SAFE_INTEGER ? null : parsed;
  }

  isMessageInDateRange(message, range) {
    if (!range) return true;
    const timestamp = this.getRangeTimestamp(message?.timestamp);
    return timestamp !== null && timestamp >= range.startMs && timestamp < range.endExclusiveMs;
  }

  filterMessagesByDateRange(messages, range) {
    return range ? messages.filter(message => this.isMessageInDateRange(message, range)) : messages;
  }

  hasReachedRangeStart(snapshot, range) {
    if (!range?.startMs) return false;
    const oldestTimestamp = this.getRangeTimestamp(snapshot?.oldestTimestamp);
    return oldestTimestamp !== null && oldestTimestamp < range.startMs;
  }

  scanVisibleMessages() {
    const messages = [];
    let lastKnownDate = '';
    let lastKnownSender = '';

    // The pre-plain-text node exists for ordinary text messages, but WhatsApp
    // can omit it from photo/video-only bubbles. Scan message *bubbles* first
    // so every attachment has a chance to be exported.
    const messageRoots = new Set();
    document.querySelectorAll('.message-in, .message-out, [data-testid="msg-container"]').forEach(node => {
      // data-testid="msg-container" can be nested inside message-in/out.
      // Prefer the enclosing bubble so one WhatsApp message yields one scan.
      const root = node.closest('[data-id], [data-message-id]') ||
                   node.closest('.message-in, .message-out') ||
                   node;
      messageRoots.add(root);
    });

    Array.from(messageRoots).forEach((element, index) => {
      try {
        const preTextElement = element.matches('[data-pre-plain-text]')
          ? element
          : element.querySelector('[data-pre-plain-text]');
        const preText = preTextElement?.getAttribute('data-pre-plain-text') || '';
        const preTextMatch = preText.match(/\[([^\]]+)\]\s*(.+?):\s*$/);
        const isOutgoing = this.isOutgoingMessageElement(element);
        let timestampStr = preTextMatch?.[1] || this.extractTimestamp(element);
        let sender = preTextMatch?.[2] || this.extractSender(element, !isOutgoing);

        const messageDate = this.getDatePart(timestampStr);
        if (messageDate) {
          lastKnownDate = messageDate;
        } else if (lastKnownDate && /^\d{1,2}:\d{2}/.test(timestampStr)) {
          // Media-only bubbles sometimes expose only "13:27". In WhatsApp's
          // DOM they remain in chronological order, so inherit the date from
          // the preceding fully-labelled message on the same day.
          timestampStr = `${timestampStr}, ${lastKnownDate}`;
        }

        if (sender === 'Contact') {
          const phone = (element.textContent || '').match(/\+\d[\d\s()\-]{6,}\d/);
          sender = phone?.[0]?.replace(/\s+/g, ' ').trim() || lastKnownSender || sender;
        }
        if (sender && sender !== 'Contact') lastKnownSender = sender;

        // Extract text and media independently. A video or image message may
        // have no caption, but it still needs an entry in the export.
        const quote = this.extractQuotedMessage(element);
        const messageText = this.extractMessageText(element, { excludeQuoted: true }) ||
                            this.extractMessageTextFromElement(element, { excludeQuoted: true });
        const media = this.extractMediaFromElement(element, { excludeQuoted: true });
        const mediaHint = this.getMediaHint(element);
        if (!messageText?.trim() && media.length === 0 && !mediaHint) return;

        // Create message object
        const message = {
          id: index,
          text: messageText?.trim() || '',
          timestamp: timestampStr,
          sender: sender,
          type: isOutgoing ? 'outgoing' : 'incoming',
          chatId: this.chatId,
          media,
          mediaHint,
          quote,
          preText: preText,
          messageId: this.getStableMessageId(element),
          element: element
        };

        messages.push(message);
      } catch (error) {
        console.error('Error processing message element:', error);
      }
    });

    return messages;
  }

  getStableMessageId(element) {
    for (const node of [element, element.closest('[data-id], [data-message-id], [data-msg-id]')]) {
      if (!node) continue;
      for (const attribute of ['data-id', 'data-message-id', 'data-msg-id']) {
        const value = node.getAttribute(attribute);
        if (value) return value;
      }
    }
    return '';
  }

  getMediaHint(element) {
    if (element.querySelector('[data-testid="video-content"], [data-testid="media-play"], [data-testid="msg-video"]')) {
      return 'video';
    }
    if (element.querySelector('img, [style*="background-image"]')) return 'image';
    return '';
  }

  getDatePart(timestamp) {
    const value = String(timestamp || '');
    const chineseDate = value.match(/(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/);
    if (chineseDate) return chineseDate[1];

    const ymdDate = value.match(/(\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2})/);
    if (ymdDate) return ymdDate[1];

    const dmyDate = value.match(/(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})/);
    return dmyDate ? dmyDate[1] : '';
  }

  findQuotedMessageContainer(element) {
    const selectors = [
      '[data-testid="quoted-message"]',
      '[data-testid="quoted-message-container"]',
      '[data-testid*="quoted" i]',
      '[data-testid*="reply" i]'
    ];

    for (const selector of selectors) {
      const candidate = element.querySelector(selector);
      if (candidate && candidate !== element) return candidate;
    }
    return null;
  }

  extractQuotedMessage(element) {
    const container = this.findQuotedMessageContainer(element);
    if (!container) return null;

    const senderElement = container.querySelector('[data-testid="author"], [data-testid*="sender" i], [data-testid*="author" i]');
    const sender = senderElement?.textContent?.trim() || '';
    const media = this.extractMediaFromElement(container);
    const mediaHint = this.getMediaHint(container);
    const text = this.extractMessageText(container) || this.extractMessageTextFromElement(container);

    return { sender, text, media, mediaHint };
  }

  extractMediaFromElement(element, { excludeQuoted = false } = {}) {
    const media = [];
    const seenSources = new Set();
    const quotedContainer = excludeQuoted ? this.findQuotedMessageContainer(element) : null;

    const addMediaSource = (src, node, kind, details = {}) => {
      if (quotedContainer?.contains(node)) return;
      if (!src || seenSources.has(src)) return;

      seenSources.add(src);
      media.push({
        kind,
        src,
        ...details,
        filename: node.getAttribute('data-filename') ||
                  node.closest('[data-filename]')?.getAttribute('data-filename') ||
                  node.getAttribute('alt') ||
                  ''
      });
    };

    const addMedia = (node, kind, details = {}) => {
      const src = node.currentSrc || node.src || node.href ||
                  node.getAttribute('src') || node.getAttribute('data-src') || node.getAttribute('data-url');
      addMediaSource(src, node, kind, details);
    };

    // React may set image URLs after creating the node, so do not require a
    // literal src attribute here. Exclude profile/avatar images that can live
    // next to an incoming message bubble but are not attachments.
    element.querySelectorAll('img').forEach(image => {
      const context = [
        image.getAttribute('data-testid'),
        image.getAttribute('alt'),
        image.className,
        image.closest('[data-testid]')?.getAttribute('data-testid')
      ].filter(Boolean).join(' ');
      if (!/avatar|profile[-_ ]?picture|contact[-_ ]?photo/i.test(context)) {
        addMedia(image, 'image', {
          isVideoPoster: Boolean(image.closest('[data-testid="video-content"]'))
        });
      }
    });

    // Quoted WhatsApp media is rendered as CSS backgrounds rather than an
    // <img>. The provider usually exposes both a compact data:image preview
    // and a better blob URL; collect both and let the asset-quality filter
    // retain the best usable copy.
    element.querySelectorAll('[style*="background-image"]').forEach(backgroundNode => {
      const backgroundImage = backgroundNode.style.backgroundImage || getComputedStyle(backgroundNode).backgroundImage;
      for (const match of backgroundImage.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g)) {
        const source = match[2]?.trim();
        if (/^(?:blob:|data:image\/|https?:\/\/)/i.test(source) && !/^data:image\/svg\+xml/i.test(source)) {
          addMediaSource(source, backgroundNode, 'image', {
            isVideoPoster: Boolean(backgroundNode.closest('[data-testid="video-content"]'))
          });
        }
      }
    });

    // WhatsApp often adds the media source as a property after React creates
    // the <video>, rather than as a literal src attribute. Query every video
    // and source node so those downloaded videos are not skipped.
    element.querySelectorAll('video, video source').forEach(video => addMedia(video, 'video'));

    // Some video thumbnails expose the original media through a direct link.
    // Only accept clear video/blob URLs, avoiding contact and profile links.
    element.querySelectorAll('a[href]').forEach(link => {
      const href = link.href || link.getAttribute('href') || '';
      if (/^(blob:|data:video\/)|\.(mp4|webm|ogg|mov)(?:[?#]|$)/i.test(href)) {
        addMedia(link, 'video');
      }
    });

    return media;
  }

  getPersistentQuotedMedia(mediaItems = []) {
    const candidates = mediaItems.filter(media =>
      media?.kind === 'image' &&
      /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,/i.test(media.src || '') &&
      media.src.length <= 256 * 1024
    );
    if (candidates.length === 0) return [];

    // The longest Base64 candidate is normally WhatsApp's highest-quality
    // embedded preview. Persist only one to keep local cache size bounded.
    return [{ ...candidates.sort((a, b) => b.src.length - a.src.length)[0] }];
  }

  createMessageId(message) {
    if (message.messageId) return `id:${message.messageId}`;

    // Use the media source as part of the fallback too: media-only messages
    // frequently share the same sender and minute.
    const textPreview = String(message.text || '').substring(0, 50).replace(/\s+/g, ' ');
    const mediaPreview = (message.media || []).map(media => media.src).join('|').slice(0, 200);
    return `${message.timestamp}|${message.sender}|${textPreview}|${mediaPreview}`;
  }

  getMessageContentKey(message) {
    const timestamp = String(message.timestamp || '').trim();
    const sender = String(message.sender || '').trim();
    const text = String(message.text || '').replace(/\s+/g, ' ').trim();
    const media = (message.media || []).map(item => item.src).filter(Boolean).sort().join('|');
    return { timestamp, sender, text, media };
  }

  areSameMessage(first, second) {
    if (first.messageId && second.messageId) return first.messageId === second.messageId;

    const firstKey = this.getMessageContentKey(first);
    const secondKey = this.getMessageContentKey(second);
    if (firstKey.timestamp !== secondKey.timestamp || firstKey.sender !== secondKey.sender) return false;

    // This bridges a legacy cache entry (without a stable id) to the live
    // WhatsApp record. Do not merge two records that both have stable ids.
    if (firstKey.text && secondKey.text) return firstKey.text === secondKey.text;
    return Boolean(firstKey.media && secondKey.media && firstKey.media === secondKey.media);
  }

  mergeMessageRecords(target, source) {
    target.text = target.text || source.text || '';
    const targetHasDate = Boolean(this.getDatePart(target.timestamp));
    const sourceHasDate = Boolean(this.getDatePart(source.timestamp));
    if (source.timestamp && (sourceHasDate || !targetHasDate)) {
      target.timestamp = source.timestamp;
    }
    if (source.sender && (!target.sender || target.sender === 'Contact')) {
      target.sender = source.sender;
    }
    target.preText = target.preText || source.preText || '';
    target.messageId = target.messageId || source.messageId || '';
    target.mediaHint = target.mediaHint || source.mediaHint || '';
    target.chatId = target.chatId || source.chatId || this.chatId || '';
    target.persistentMessageKey = target.persistentMessageKey || source.persistentMessageKey || '';
    target.quote = source.quote || target.quote || null;
    target.element = source.element instanceof Element ? source.element : target.element;

    const seenSources = new Set();
    target.media = [...(target.media || []), ...(source.media || [])].filter(media => {
      if (!media?.src || seenSources.has(media.src)) return false;
      seenSources.add(media.src);
      return true;
    });
    const seenReferences = new Set();
    target.mediaRefs = [...(target.mediaRefs || []), ...(source.mediaRefs || [])].filter(reference => {
      if (!reference?.key || seenReferences.has(reference.key)) return false;
      seenReferences.add(reference.key);
      return true;
    });
    return target;
  }

  deduplicateMessages(messages) {
    const uniqueMessages = [];

    for (const message of messages) {
      const duplicate = uniqueMessages.find(candidate => this.areSameMessage(candidate, message));
      if (duplicate) {
        this.mergeMessageRecords(duplicate, message);
      } else {
        uniqueMessages.push({
          ...message,
          media: [...(message.media || [])],
          mediaRefs: [...(message.mediaRefs || [])]
        });
      }
    }

    return uniqueMessages;
  }

  extractMessageTextFromElement(element, { excludeQuoted = false } = {}) {
    // Extract text from the message element, handling multiple spans
    const textSelectors = [
      '.selectable-text span',
      '.selectable-text',
      '._ao3e span',
      '._ao3e'
    ];

    let fullText = '';
    
    for (const selector of textSelectors) {
      const textElements = element.querySelectorAll(selector);
      if (textElements.length > 0) {
        textElements.forEach(el => {
          if (excludeQuoted && this.findQuotedMessageContainer(element)?.contains(el)) return;
          const text = el.textContent?.trim();
          if (text && !this.isTimestamp(text) && !this.isSystemMessage(text, el) && !this.isUiChromeText(text)) {
            fullText += text + ' ';
          }
        });
        break; // Use the first selector that finds elements
      }
    }

    return fullText.trim();
  }

  isUiChromeText(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!value) return true;
    return /^(tail-(?:in|out)|video-pip|media-play|msg-video|ic-[\w-]+|wds-ic-[\w-]+|已转发|forwarded|照片|photo|图片|image|video)$/.test(value);
  }

  isOutgoingMessageElement(element) {
    // Check if the message is outgoing by looking at parent containers
    // The element with data-pre-plain-text is nested inside the message container
    
    // First check if the element itself has the class
    if (element.classList.contains('message-out')) {
      return true;
    }
    
    // Then check all parent elements up the tree
    let currentElement = element;
    while (currentElement && currentElement !== document.body) {
      if (currentElement.classList && currentElement.classList.contains('message-out')) {
        return true;
      }
      currentElement = currentElement.parentElement;
    }
    
    return false;
  }

  isSystemMessage(_text, element) {
    if (!(element instanceof Element)) return false;
    return Boolean(element.closest([
      '[data-testid="system-message"]',
      '[data-testid="notification-message"]',
      '[data-testid="group-notification"]',
      '[role="separator"]'
    ].join(', ')));
  }

  updateCacheIndicator() {
    const fab = document.querySelector('.ai-fab-button');
    if (!fab) return;
    
    const existingIndicator = fab.querySelector('.cache-indicator');
    const cacheSize = this.messageCache.size;
    
    if (cacheSize > 0) {
      if (existingIndicator) {
        existingIndicator.textContent = cacheSize;
      } else {
        const indicator = document.createElement('div');
        indicator.className = 'cache-indicator';
        indicator.textContent = cacheSize;
        fab.appendChild(indicator);
      }
      fab.title = t('fabTitleCachedMessages', [String(cacheSize)]);
    } else {
      if (existingIndicator) {
        existingIndicator.remove();
      }
      fab.title = t('fabTitle');
    }
  }

  refreshMessageCache() {
    if (this.isSwitchingChat || this.chatId === 'no-active-chat') {
      return { added: 0, total: this.messageCache.size };
    }

    const visibleMessages = this.scanVisibleMessages();
    let newMessagesCount = 0;
    let cacheChanged = false;

    visibleMessages.forEach(message => {
      const messageId = this.createMessageId(message);
      let existingKey = this.messageCache.has(messageId) ? messageId : null;
      let cachedMessage = existingKey ? this.messageCache.get(existingKey) : null;

      // When a live record now exposes a stable data-id, merge any matching
      // legacy cache record rather than retaining a second exported message.
      if (!cachedMessage) {
        const legacyEntry = Array.from(this.messageCache.entries()).find(([, candidate]) =>
          this.areSameMessage(candidate, message)
        );
        if (legacyEntry) {
          [existingKey, cachedMessage] = legacyEntry;
        }
      }

      if (!cachedMessage) {
        this.messageCache.set(messageId, message);
        newMessagesCount++;
        cacheChanged = true;
      } else {
        this.mergeMessageRecords(cachedMessage, message);

        // Replace the old fallback cache key with WhatsApp's stable id as soon
        // as it becomes available. This prevents future re-render duplicates.
        if (existingKey !== messageId && message.messageId) {
          this.messageCache.delete(existingKey);
          this.messageCache.set(messageId, cachedMessage);
        }
        cacheChanged = true;
      }
    });

    if (cacheChanged) {
      console.log(`Added ${newMessagesCount} new messages to cache. Total: ${this.messageCache.size}`);
      this.scheduleCacheSave();
    }
    if (newMessagesCount > 0) {
      this.updateCacheIndicator(); // Update the UI indicator
    }
    return { added: newMessagesCount, total: this.messageCache.size };
  }

  scheduleCacheSave(delay = 500) {
    clearTimeout(this.cacheSaveTimer);
    this.cacheSaveTimer = setTimeout(() => {
      this.cacheSaveTimer = null;
      this.saveCachedMessages();
    }, delay);
  }

  async flushCachedMessages() {
    clearTimeout(this.cacheSaveTimer);
    this.cacheSaveTimer = null;
    await this.saveCachedMessages();
  }

  getLiveMediaItems(message) {
    return [
      ...this.getMediaForMessage(message).map((media, index) => ({
        ...media,
        role: 'attachment',
        index
      })),
      ...this.getQuotedMediaForMessage(message).map((media, index) => ({
        ...media,
        role: 'quoted',
        index
      }))
    ];
  }

  async captureVisibleHistoryMedia(sync) {
    const visibleMessages = this.scanVisibleMessages().filter(message =>
      (!sync.range || this.isMessageInDateRange(message, sync.range)) &&
      message.element instanceof Element &&
      document.contains(message.element)
    );

    for (const message of visibleMessages) {
      if (sync.cancelled || this.chatId !== sync.chatId) break;

      // Full-history sync keeps its existing video behavior. Date-range sync
      // additionally persists visible images so they survive virtual-list
      // recycling, page refreshes, and later exports.
      if (sync.range) {
        const existingSlots = new Set((await this.getPersistentMediaForMessage(message)).map(record => record.slot));
        for (const media of this.getLiveMediaItems(message).filter(item => item.kind === 'image')) {
          if (sync.cancelled) break;
          const slot = this.getPersistentMediaSlot(media, media.role, media.index);
          if (existingSlots.has(slot)) continue;
          sync.stage = 'capturingMedia';
          this.updateHistorySyncUI();
          try {
            const blob = await this.fetchMediaBlob(media, 15000);
            const persisted = await this.persistMediaAsset(message, media, blob, media);
            if (persisted) {
              existingSlots.add(slot);
              sync.imageCaptured = (sync.imageCaptured || 0) + 1;
            }
          } catch (error) {
            console.debug('Unable to cache a visible history image:', error);
          }
        }
      }

      if (message.mediaHint === 'video') {
        const cacheKey = this.getVideoCacheKey(message);
        const attempts = this.historyVideoCaptureAttempts.get(cacheKey) || 0;
        if (this.videoBlobCache.has(cacheKey) || attempts >= 2) continue;

        this.historyVideoCaptureAttempts.set(cacheKey, attempts + 1);
        sync.stage = 'capturingMedia';
        this.updateHistorySyncUI();
        try {
          const captured = await this.captureVideoForMessage(message, message.media || []);
          if (captured) sync.videoCaptured = (sync.videoCaptured || 0) + 1;
          else sync.videoUnavailable = (sync.videoUnavailable || 0) + 1;
        } catch (error) {
          sync.videoUnavailable = (sync.videoUnavailable || 0) + 1;
          console.warn('Unable to capture a visible history video:', error);
        }
      }
    }
  }

  async loadAllMessages({ restorePosition = true, range = null } = {}) {
    if (this.historySync?.active) return this.historySync.promise;

    const chatContainer = this.getHistoryScrollContainer();
    if (!chatContainer) {
      throw new Error(t('errorHistoryContainer'));
    }

    const sync = {
      id: ++this.historySyncSequence,
      active: true,
      cancelled: false,
      cancelReason: '',
      chatId: this.chatId,
      count: this.messageCache.size,
      oldestTimestamp: '',
      range,
      imageCaptured: 0,
      videoCaptured: 0,
      videoUnavailable: 0,
      stage: 'starting',
      promise: null
    };
    this.historySync = sync;
    this.historyVideoCaptureAttempts.clear();

    sync.promise = this.runHistorySync(sync, chatContainer, { restorePosition });
    return sync.promise;
  }

  async runHistorySync(sync, initialContainer, { restorePosition }) {
    const initialScrollTop = initialContainer.scrollTop;
    const initialBottomDistance = Math.max(0, initialContainer.scrollHeight - initialContainer.clientHeight - initialScrollTop);
    const initialAnchor = this.captureHistoryScrollAnchor(initialContainer);
    let container = initialContainer;
    let previousSnapshot = this.getVisibleHistorySnapshot(container);
    let previousCount = this.messageCache.size;
    let stableTopChecks = 0;
    let cycle = 0;
    let lastCheckpointAt = Date.now();
    let lastPhoneHistoryRequestAt = 0;

    // A range export starts from the newest end of the conversation. This
    // guarantees coverage even if the user was reading an older point when
    // export began; the original reading position is restored in finally.
    if (sync.range) {
      container.scrollTop = container.scrollHeight;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      await this.sleep(650);
      const latestContainer = this.getHistoryScrollContainer();
      if (latestContainer) container = latestContainer;
      previousSnapshot = this.getVisibleHistorySnapshot(container);
    }

    this.refreshMessageCache();
    await this.captureVisibleHistoryMedia(sync);
    this.updateHistorySyncProgress(sync, previousSnapshot, 'scrolling');
    console.log(sync.range ? 'Starting date-range history synchronization...' : 'Starting continuous history synchronization...');

    try {
      let reachedRangeStart = this.hasReachedRangeStart(previousSnapshot, sync.range);
      while (!sync.cancelled && !reachedRangeStart) {
        if (this.chatId !== sync.chatId || this.getCurrentChatId() !== sync.chatId) {
          this.cancelHistorySync('chat-change');
          break;
        }

        const latestContainer = this.getHistoryScrollContainer();
        if (latestContainer) container = latestContainer;

        const beforeTop = container.scrollTop;
        const nearTopBefore = beforeTop <= Math.max(4, container.clientHeight * 0.01);
        // Range sync favors a wider overlap between virtual-list snapshots.
        // It costs a few more cycles but prevents WhatsApp height corrections
        // from skipping a sparsely populated boundary day.
        const scrollRatio = sync.range ? 0.5 : 0.78;
        const scrollStep = Math.max(320, Math.floor(container.clientHeight * scrollRatio));
        const targetTop = nearTopBefore ? 0 : Math.max(0, beforeTop - scrollStep);
        const olderMessagesButton = nearTopBefore ? this.getOlderMessagesButton(container) : null;
        const canRequestPhoneHistory = olderMessagesButton && Date.now() - lastPhoneHistoryRequestAt >= 12000;
        const waitMs = canRequestPhoneHistory
          ? 6500
          : nearTopBefore
          ? Math.min(4800, 1900 + (stableTopChecks * 700))
          : 1600;

        if (canRequestPhoneHistory) {
          lastPhoneHistoryRequestAt = Date.now();
          this.updateHistorySyncProgress(sync, previousSnapshot, 'requestingPhone');
        }
        const activity = await this.waitForHistoryAction(
          container,
          () => canRequestPhoneHistory ? olderMessagesButton.click() : (container.scrollTop = targetTop),
          waitMs,
          sync
        );
        if (sync.cancelled) break;

        const cacheResult = this.refreshMessageCache();
        await this.captureVisibleHistoryMedia(sync);
        const snapshot = this.getVisibleHistorySnapshot(container);
        const oldestChanged = Boolean(snapshot.oldestKey && snapshot.oldestKey !== previousSnapshot.oldestKey);
        const cacheGrew = cacheResult.total > previousCount;
        const nearTopAfter = container.scrollTop <= Math.max(4, container.clientHeight * 0.01);
        const loading = this.isHistoryLoading(container);
        const olderHistoryAvailable = Boolean(this.getOlderMessagesButton(container));
        const stillChanging = activity.mutations > 0 || oldestChanged || cacheGrew;

        if (nearTopAfter && !loading && !olderHistoryAvailable && !stillChanging) {
          stableTopChecks++;
        } else {
          stableTopChecks = 0;
        }

        previousSnapshot = snapshot;
        previousCount = cacheResult.total;
        reachedRangeStart = this.hasReachedRangeStart(snapshot, sync.range);
        cycle++;
        this.updateHistorySyncProgress(sync, snapshot,
          olderHistoryAvailable ? 'waitingPhone' : loading ? 'waiting' : 'scrolling');
        console.log(`History cycle ${cycle}: ${cacheResult.total} cached, top=${Math.round(container.scrollTop)}, mutations=${activity.mutations}, stable=${stableTopChecks}`);

        // Persist a checkpoint during very long conversations. This also
        // means stopping, refreshing, or a transient page failure loses at
        // most a short portion of the traversal rather than the entire run.
        if (Date.now() - lastCheckpointAt >= 15000) {
          await this.flushCachedMessages();
          lastCheckpointAt = Date.now();
        }

        // A single quiet check is not enough: WhatsApp can pause between its
        // network response and the virtual-list re-render. Four progressively
        // longer quiet checks at the real top avoid that false completion.
        if (reachedRangeStart || stableTopChecks >= 4) break;
      }

      this.refreshMessageCache();
      await this.flushCachedMessages();

      return {
        status: sync.cancelled ? 'cancelled' : 'complete',
        reason: sync.cancelReason,
        count: this.messageCache.size,
        imageCaptured: sync.imageCaptured || 0,
        videoCaptured: sync.videoCaptured || 0,
        videoUnavailable: sync.videoUnavailable || 0
      };
    } finally {
      if (restorePosition && !['chat-change', 'cache-clear'].includes(sync.cancelReason) && this.chatId === sync.chatId) {
        await this.restoreHistoryScrollPosition(container, {
          initialScrollTop,
          initialBottomDistance,
          initialAnchor
        });
        this.refreshMessageCache();
      }

      sync.active = false;
      if (this.historySync?.id === sync.id) this.historySync = null;
      this.updateCacheIndicator();
      this.updateHistorySyncUI();
    }
  }

  cancelHistorySync(reason = 'user') {
    if (!this.historySync?.active) return false;
    this.historySync.cancelled = true;
    this.historySync.cancelReason = reason;
    this.historySync.stage = 'stopping';
    this.updateHistorySyncUI();
    return true;
  }

  waitForHistoryAction(container, action, maxWaitMs, sync) {
    return new Promise(resolve => {
      let mutations = 0;
      let lastMutationAt = 0;
      const startedAt = Date.now();
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearInterval(pollTimer);
        clearTimeout(maxTimer);
        resolve({ mutations });
      };

      const observer = new MutationObserver(records => {
        mutations += records.length;
        lastMutationAt = Date.now();
      });
      observer.observe(container, { childList: true, subtree: true, characterData: true });

      const pollTimer = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        if (sync.cancelled || (mutations > 0 && elapsed >= 450 && Date.now() - lastMutationAt >= 400)) {
          finish();
        }
      }, 100);
      const maxTimer = setTimeout(finish, maxWaitMs);

      action();
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  }

  getHistoryScrollContainer() {
    const baseSelectors = [
      '[data-testid="conversation-panel-messages"]',
      '[data-testid="conversation-panel"] [data-testid="msg-list"]',
      '[data-testid="conversation-panel"] .copyable-area',
      '#main .copyable-area',
      '[data-testid="conversation-panel"]',
      '#main'
    ];
    const candidates = new Set();

    for (const selector of baseSelectors) {
      const base = document.querySelector(selector);
      if (!base) continue;
      candidates.add(base);
      base.querySelectorAll('div').forEach(node => {
        if (node.querySelector('.message-in, .message-out, [data-testid="msg-container"], [data-testid^="conv-msg-"]') ||
            node.matches('[role="application"], [aria-label], [data-testid="conversation-panel-messages"]')) {
          candidates.add(node);
        }
      });
    }

    const scrollable = Array.from(candidates).filter(node => {
      const style = getComputedStyle(node);
      const canScroll = /auto|scroll/.test(style.overflowY) || node.scrollHeight > node.clientHeight + 4;
      return canScroll && node.clientHeight > 180 &&
             node.querySelector('.message-in, .message-out, [data-testid="msg-container"], [data-testid^="conv-msg-"]');
    });

    return scrollable.sort((a, b) => {
      const aScore = (a.scrollHeight - a.clientHeight) + a.clientHeight * 2;
      const bScore = (b.scrollHeight - b.clientHeight) + b.clientHeight * 2;
      return bScore - aScore;
    })[0] || this.getChatContainer();
  }

  getVisibleHistorySnapshot(container) {
    // Reuse the same message parser as the cache. Raw [data-testid^="conv-msg-"]
    // traversal is intentionally avoided here because WhatsApp can render
    // nested reply/preview structures whose timestamp is not the timestamp of
    // the containing message. A quoted older date must never terminate a range
    // sync early.
    const visibleMessages = this.scanVisibleMessages().filter(message =>
      message.element instanceof Element && container.contains(message.element)
    );
    const datedMessages = visibleMessages.map(message => ({
      message,
      timestamp: this.getRangeTimestamp(message.timestamp)
    })).filter(entry => entry.timestamp !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
    const oldestMessage = datedMessages[0]?.message || visibleMessages[0] || null;
    return {
      oldestKey: oldestMessage?.element ? this.getHistoryElementKey(oldestMessage.element) : '',
      oldestTimestamp: oldestMessage?.timestamp || '',
      visibleCount: visibleMessages.length
    };
  }

  getHistoryElementKey(element) {
    const stableId = this.getStableMessageId(element);
    if (stableId) return `id:${stableId}`;
    const preText = element.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') || '';
    const text = this.extractMessageText(element).replace(/\s+/g, ' ').slice(0, 120);
    return `${preText}|${text}|${this.extractTimestamp(element)}`;
  }

  isHistoryLoading(container) {
    const loaders = container.querySelectorAll('[data-testid*="spinner" i], [data-testid*="loader" i], [role="progressbar"], progress');
    return Array.from(loaders).some(loader => {
      const rect = loader.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom >= containerRect.top && rect.top <= containerRect.top + containerRect.height * 0.35;
    });
  }

  getOlderMessagesButton(container) {
    const patterns = [
      /older messages/i,
      /较早的消息/,
      /mensajes (?:más )?antiguos/i,
      /mensagens mais antigas/i,
      /messages plus anciens/i,
      /ältere nachrichten/i,
      /messaggi (?:più vecchi|meno recenti)/i
    ];

    return Array.from(container.querySelectorAll('button')).find(button => {
      const label = `${button.innerText || ''} ${button.getAttribute('aria-label') || ''}`.trim();
      if (!patterns.some(pattern => pattern.test(label))) return false;
      const rect = button.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top <= containerRect.top + containerRect.height * 0.35;
    }) || null;
  }

  captureHistoryScrollAnchor(container) {
    const containerTop = container.getBoundingClientRect().top;
    const candidates = Array.from(container.querySelectorAll('[data-id], [data-message-id], [data-msg-id], [data-testid^="conv-msg-"]'))
      .filter(node => node.querySelector('.message-in, .message-out, [data-testid="msg-container"]') ||
                      node.matches('.message-in, .message-out, [data-testid^="conv-msg-"]'))
      .map(node => ({ node, distance: Math.abs(node.getBoundingClientRect().top - containerTop) }))
      .sort((a, b) => a.distance - b.distance);
    const anchor = candidates[0]?.node;
    return anchor ? {
      key: this.getStableMessageId(anchor),
      offset: anchor.getBoundingClientRect().top - containerTop
    } : null;
  }

  async restoreHistoryScrollPosition(container, state) {
    const targetTop = Math.max(0, container.scrollHeight - container.clientHeight - state.initialBottomDistance);
    container.scrollTop = targetTop;
    await this.sleep(450);

    if (!state.initialAnchor?.key) return;
    const escapedId = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(state.initialAnchor.key)
      : state.initialAnchor.key.replace(/["\\]/g, '\\$&');
    const anchor = container.querySelector(`[data-id="${escapedId}"], [data-message-id="${escapedId}"], [data-msg-id="${escapedId}"]`);
    if (!anchor) return;

    const currentOffset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += currentOffset - state.initialAnchor.offset;
  }

  updateHistorySyncProgress(sync, snapshot, stage) {
    if (!sync) return;
    sync.count = this.messageCache.size;
    sync.oldestTimestamp = snapshot?.oldestTimestamp || sync.oldestTimestamp || '';
    sync.stage = stage;
    this.updateHistorySyncUI();
  }

  updateHistorySyncUI() {
    const button = document.getElementById('load-full-history');
    const status = document.getElementById('history-sync-status');
    if (!button || !status) return;

    const sync = this.historySync;
    if (!sync?.active) {
      button.textContent = t('menuLoadHistory');
      button.classList.remove('is-syncing');
      status.hidden = true;
      status.textContent = '';
      return;
    }

    button.classList.add('is-syncing');
    button.textContent = sync.stage === 'stopping'
      ? t('historyStopping')
      : t('menuStopHistory');
    status.hidden = false;
    status.textContent = sync.stage === 'stopping'
      ? t('historyStoppingDetail')
      : t(sync.stage === 'requestingPhone'
          ? 'historySyncRequestingPhone'
          : sync.stage === 'waitingPhone'
            ? 'historySyncWaitingPhone'
            : sync.stage === 'capturingMedia'
              ? (sync.range ? 'historySyncCapturingMedia' : 'historySyncCapturingVideo')
            : sync.stage === 'waiting'
              ? 'historySyncWaiting'
              : 'historySyncProgress', [
          String(sync.count),
          sync.oldestTimestamp || t('historyDateUnknown')
        ]);
  }

  getChatContainer() {
    // Try multiple selectors to find the chat container
    const selectors = [
      '[data-testid="conversation-panel-messages"]',
      '[data-testid="conversation-panel"] [data-testid="msg-list"]',
      '[data-testid="conversation-panel"] .copyable-area',
      '#main .copyable-area',
      '[data-testid="conversation-panel"]',
      '#main',
      '.two .two-3 .two-1'
    ];

    for (const selector of selectors) {
      const container = document.querySelector(selector);
      if (container) {
        console.log(`Found chat container with selector: ${selector}`);
        return container;
      }
    }

    console.log('No chat container found');
    return null;
  }

  isIncomingMessage(container) {
    return container.classList.contains('message-in') ||
           container.querySelector('.message-in') ||
           container.closest('.message-in') ||
           !this.isOutgoingMessage(container) && container.querySelector('[data-testid="msg-container"]');
  }

  isOutgoingMessage(container) {
    return container.classList.contains('message-out') ||
           container.querySelector('.message-out') ||
           container.closest('.message-out') ||
           container.querySelector('[data-testid="msg-container"]')?.closest('.message-out');
  }

  extractMessageText(container, { excludeQuoted = false } = {}) {
    // Try multiple selectors to get message text
    const textSelectors = [
      '.selectable-text:not([data-testid="msg-meta"])',
      '[data-testid="conversation-text"]',
      '.copyable-text .selectable-text',
      '[data-testid="msg-text"]',
      '.quoted-mention',
      'span._ao3e'
    ];

    let text = '';
    
    for (const selector of textSelectors) {
      const elements = container.querySelectorAll(selector);
      elements.forEach(el => {
        if (excludeQuoted && this.findQuotedMessageContainer(container)?.contains(el)) return;
        const elementText = el.textContent?.trim();
        if (elementText && !text.includes(elementText) && !this.isTimestamp(elementText) &&
            !this.isSystemMessage(elementText, el) && !this.isUiChromeText(elementText)) {
          text += elementText + ' ';
        }
      });
    }

    return text.trim();
  }

  extractTimestamp(container) {
    const timeSelectors = [
      '[data-testid="msg-time"]',
      '.x1rg5ohu',
      '._ao3e time',
      '[aria-label*=":"]',
      '.copyable-text[data-pre-plain-text] .x1c4vz4f.x2lah0s',
      'span[title*=":"]'
    ];

    for (const selector of timeSelectors) {
      let timestamp = '';
      for (const timeElement of container.querySelectorAll(selector)) {
        const timeText = timeElement.textContent || 
                        timeElement.getAttribute('aria-label') || 
                        timeElement.getAttribute('title');
        const candidate = this.normalizeTimestampValue(timeText);
        // Video bubbles place a "msg-video" icon and the real message time
        // under the same generated class. Keep scanning to obtain the last
        // valid clock value rather than stopping at the first icon node.
        if (candidate) timestamp = candidate;
      }
      if (timestamp) return timestamp;
    }

    // Try to extract from data-pre-plain-text attribute
    const preTextElement = container.querySelector('[data-pre-plain-text]');
    if (preTextElement) {
      const preText = preTextElement.getAttribute('data-pre-plain-text');
      const timeMatch = preText?.match(/\[([^\]]+)\]/);
      const timestamp = this.normalizeTimestampValue(timeMatch?.[1]);
      if (timestamp) return timestamp;
    }

    return '';
  }

  normalizeTimestampValue(value) {
    const source = String(value || '').trim();
    if (!source) return '';

    // Nodes in forwarded/video messages can contain icon labels, the video's
    // duration and the message time in one string (e.g. "0:0311:31"). The
    // final clock value is WhatsApp's message timestamp; earlier values are
    // media durations and must not affect chronological sorting.
    const times = Array.from(source.matchAll(/\d{1,2}:\d{2}(?::\d{2})?/g));
    if (times.length === 0) return '';
    const time = times.at(-1)[0];
    const date = this.getDatePart(source);
    return date ? `${time}, ${date}` : time;
  }

  extractSender(container, isIncoming) {
    if (!isIncoming) return 'You';

    // Try to extract sender from group chat
    const senderSelectors = [
      '[data-testid="msg-meta-sender"]',
      '.copyable-text[data-pre-plain-text]',
      '[data-testid="contact-name"]'
    ];

    for (const selector of senderSelectors) {
      const senderElement = container.querySelector(selector);
      if (senderElement) {
        const preText = senderElement.getAttribute('data-pre-plain-text');
        if (preText) {
          const match = preText.match(/\] (.+?):/);
          if (match) return match[1];
        }
        
        const senderText = senderElement.textContent?.trim();
        if (senderText && !this.isTimestamp(senderText)) {
          return senderText;
        }
      }
    }

    return 'Contact';
  }

  isTimestamp(text) {
    // Check if text looks like a timestamp
    return /^\d{1,2}:\d{2}/.test(text) || 
           /\d{1,2}:\d{2}/.test(text) ||
           text.includes('AM') || 
           text.includes('PM');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async loadFullHistory() {
    if (this.historySync?.active) {
      this.cancelHistorySync('user');
      this.showNotification(t('notifyHistoryStopping'), 'info');
      return;
    }

    try {
      this.showNotification(t('notifyLoadingHistory'), 'info');
      const result = await this.loadAllMessages();

      if (result.status === 'complete') {
        this.showNotification(t('notifyLoadedHistoryDone', [String(result.count)]), 'success');
        if (result.videoCaptured > 0 || result.videoUnavailable > 0) {
          this.showNotification(t('notifyHistoryVideoCapture', [
            String(result.videoCaptured),
            String(result.videoUnavailable)
          ]), result.videoUnavailable > 0 ? 'info' : 'success');
        }
      } else if (result.reason === 'user') {
        this.showNotification(t('notifyHistoryStopped', [String(result.count)]), 'info');
      }
    } catch (error) {
      console.error('Error loading full history:', error);
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
      this.showNotification(`${t('errorLoadHistory')}${detail}`, 'error');
    }
  }

  async clearMessageCache() {
    try {
      const activeSync = this.historySync?.active ? this.historySync.promise : null;
      this.cancelHistorySync('cache-clear');
      if (activeSync) await activeSync;
      this.messageCache.clear();
      this.videoBlobCache.clear();
      this.historyVideoCaptureAttempts.clear();
      const cacheKey = this.getCacheKey();
      await Promise.all([
        chrome.storage.local.remove([cacheKey]),
        this.clearPersistentMediaForChat(this.chatId)
      ]);
      this.updateCacheIndicator(); // Update UI
      this.showNotification(t('notifyCacheCleared'), 'success');
    } catch (error) {
      console.error('Error clearing cache:', error);
      this.showNotification(t('errorClearCache'), 'error');
    }
  }

  formatConversationForAI(messages, instructionsOrIsExport = false, messageInstructions = '') {
    // Handle both old and new parameter patterns
    let isExport = false;
    let instructions = '';
    
    if (typeof instructionsOrIsExport === 'boolean') {
      // Old usage: formatConversationForAI(messages, isExport)
      isExport = instructionsOrIsExport;
      instructions = messageInstructions;
    } else {
      // New usage: formatConversationForAI(messages, messageInstructions)
      instructions = instructionsOrIsExport || '';
      isExport = false;
    }

    const messageCount = messages.length;
    let conversation = `WhatsApp Conversation Export (${messageCount} messages):\n`;
    conversation += `Generated on: ${new Date().toLocaleString()}\n\n`;
    
    if (messageCount === 0) {
      conversation += "No messages found in this conversation.\n";
      return conversation;
    }
    
    // Add conversation context
    const firstMessage = messages[0];
    const lastMessage = messages[messageCount - 1];
    conversation += `Conversation timeframe: ${firstMessage.timestamp} to ${lastMessage.timestamp}\n`;
    
    if (isExport) {
      conversation += `All messages (${messageCount} total):\n\n`;
      // For export, include ALL messages
      messages.forEach(msg => {
        conversation += `[${msg.timestamp}] ${msg.sender}: ${msg.text}\n`;
      });
    } else {
      conversation += `Recent messages (showing ${Math.min(100, messageCount)} most recent):\n\n`;
      // For AI, show most recent messages
      const messagesToShow = messages.slice(-100);
      messagesToShow.forEach(msg => {
        conversation += `[${msg.timestamp}] ${msg.sender}: ${msg.text}\n`;
      });
      
      // Add specific instructions for next message if provided
      if (instructions && instructions.trim() !== '') {
        conversation += `\n--- Instructions for next message ---\n`;
        conversation += `${instructions.trim()}\n`;
        conversation += `--- End instructions ---\n`;
      }
    }
    
    return conversation;
  }

  async exportConversation() {
    try {
      const selection = await this.showExportFormatDialog();
      if (!selection) return;

      if (selection.range) {
        const activeSync = this.historySync?.active ? this.historySync.promise : null;
        if (activeSync) {
          this.cancelHistorySync('range-export');
          await activeSync;
        }
        this.showNotification(t('notifyLoadingDateRange', [
          selection.range.startDate,
          selection.range.endDate
        ]), 'info');
        const syncResult = await this.loadAllMessages({ range: selection.range });
        if (syncResult.status !== 'complete') {
          if (syncResult.reason === 'user') {
            this.showNotification(t('notifyRangeExportStopped'), 'info');
          }
          return;
        }
      }

      this.showNotification(t('notifyCollectingMessages'), 'info');
      // A blank range uses the current cache immediately. A selected range has
      // already completed its bounded, user-requested traversal above.
      const cachedMessages = await this.extractMessages(true); // Pass true for full export
      const messages = this.filterMessagesByDateRange(cachedMessages, selection.range);
      if (messages.length === 0) {
        throw new Error(t('errorNoMessagesInRange'));
      }
      const coverage = this.getMessageCoverage(messages);
      if (selection.range && coverage) {
        this.showNotification(t('notifyRangeCoverage', [
          selection.range.startDate,
          selection.range.endDate,
          coverage.first.timestamp,
          coverage.last.timestamp
        ]), 'info');
      }

      if (selection.format === 'html') {
        await this.exportHtmlArchive(messages, selection.range);
      } else {
        await this.exportWordDocument(messages, selection.range);
      }

      this.clearExportProgress();
      this.showNotification(t('notifyExportSuccess', [String(messages.length)]), 'success');
    } catch (error) {
      console.error('Export error:', error);
      this.clearExportProgress();
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
      this.showNotification(`${t('errorExport')}${detail}`, 'error');
    }
  }

  getCachedHistorySummary() {
    this.refreshMessageCache();
    const messages = this.sortMessages(this.deduplicateMessages(Array.from(this.messageCache.values())));
    if (messages.length === 0) {
      return { count: 0, range: t('exportCacheEmpty') };
    }

    const first = messages.find(message => this.parseTimestamp(message.timestamp) !== Number.MAX_SAFE_INTEGER);
    const last = [...messages].reverse().find(message => this.parseTimestamp(message.timestamp) !== Number.MAX_SAFE_INTEGER);
    const range = first && last
      ? `${first.timestamp || t('historyDateUnknown')} → ${last.timestamp || t('historyDateUnknown')}`
      : t('historyDateUnknown');
    return { count: messages.length, range };
  }

  getMessageCoverage(messages) {
    const dated = this.sortMessages(messages).filter(message =>
      this.getRangeTimestamp(message.timestamp) !== null
    );
    return dated.length > 0 ? { first: dated[0], last: dated.at(-1) } : null;
  }

  showExportFormatDialog() {
    return new Promise(resolve => {
      const summary = this.getCachedHistorySummary();
      const modal = document.createElement('div');
      modal.className = 'ai-modal';
      modal.id = 'export-format-modal';
      modal.innerHTML = `
        <div class="ai-modal-content">
          <div class="export-format-header">
            <div class="export-format-kicker">${t('exportFormatKicker')}</div>
            <h3>${t('exportFormatTitle')}</h3>
            <p>${t('exportFormatDesc')}</p>
            <div class="export-cache-summary">${this.escapeHtml(t('exportCacheSummary', [
              String(summary.count),
              summary.range
            ]))}</div>
          </div>
          <div class="export-date-range">
            <div class="export-date-range-heading">
              <strong>${t('exportDateRangeTitle')}</strong>
              <span>${t('exportDateRangeOptional')}</span>
            </div>
            <div class="export-date-fields">
              <label>
                <span>${t('exportStartDate')}</span>
                <input id="export-start-date" type="date">
              </label>
              <span class="export-date-arrow" aria-hidden="true">→</span>
              <label>
                <span>${t('exportEndDate')}</span>
                <input id="export-end-date" type="date">
              </label>
            </div>
            <p class="export-date-hint">${t('exportDateRangeHint')}</p>
            <div id="export-date-error" class="export-date-error" hidden></div>
          </div>
          <div class="export-format-options">
            <button id="export-html" class="export-format-option export-format-option-html">
              <span class="export-format-badge">HTML</span>
              <span class="export-format-copy">
                <strong>${t('exportHtmlTitle')}</strong>
                <small>${t('exportHtmlDetail')}</small>
              </span>
              <span class="export-format-arrow" aria-hidden="true">→</span>
            </button>
            <button id="export-word" class="export-format-option export-format-option-word">
              <span class="export-format-badge">DOCX</span>
              <span class="export-format-copy">
                <strong>${t('exportWordTitle')}</strong>
                <small>${t('exportWordDetail')}</small>
              </span>
              <span class="export-format-arrow" aria-hidden="true">→</span>
            </button>
          </div>
          <div class="export-format-footer"><button id="cancel-export">${t('btnCancel')}</button></div>
        </div>
      `;

      const close = result => {
        if (document.body.contains(modal)) document.body.removeChild(modal);
        resolve(result);
      };

      const chooseFormat = format => {
        const startDate = modal.querySelector('#export-start-date').value;
        const endDate = modal.querySelector('#export-end-date').value;
        const error = modal.querySelector('#export-date-error');
        error.hidden = true;
        error.textContent = '';

        if (Boolean(startDate) !== Boolean(endDate)) {
          error.textContent = t('exportDateRangeRequired');
          error.hidden = false;
          return;
        }
        const range = this.createExportDateRange(startDate, endDate);
        if (startDate && !range) {
          error.textContent = t('exportDateRangeInvalid');
          error.hidden = false;
          return;
        }
        close({ format, range });
      };

      modal.querySelector('#export-html').addEventListener('click', () => chooseFormat('html'));
      modal.querySelector('#export-word').addEventListener('click', () => chooseFormat('docx'));
      modal.querySelector('#cancel-export').addEventListener('click', () => close(null));
      modal.addEventListener('click', event => {
        if (event.target === modal) close(null);
      });

      document.body.appendChild(modal);
    });
  }

  getExportFilePrefix(range = null) {
    const title = document.querySelector('[data-testid="conversation-info-header-chat-title"]')?.textContent?.trim() || 'conversation';
    const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80) || 'conversation';
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    const rangePart = range ? '-' + range.startDate + '-to-' + range.endDate : '';
    return 'whatsapp-' + safeTitle + rangePart + '-' + date;
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Keep large DOCX/ZIP object URLs alive long enough for Chrome's download
    // service to acquire them. Revoking after one second can cancel a large
    // local download before it has actually started.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  getMediaForMessage(message) {
    const cachedMedia = message.media || [];
    const visibleMedia = message.element instanceof Element
      ? this.extractMediaFromElement(message.element, { excludeQuoted: true })
      : [];
    const seenSources = new Set();

    return [...cachedMedia, ...visibleMedia].filter(media => {
      if (!media?.src || seenSources.has(media.src)) return false;
      seenSources.add(media.src);
      return true;
    });
  }

  getQuotedMediaForMessage(message) {
    const cachedMedia = message.quote?.media || [];
    const visibleQuote = message.element instanceof Element
      ? this.extractQuotedMessage(message.element)
      : null;
    const visibleMedia = visibleQuote?.media || [];
    const seenSources = new Set();

    if (visibleQuote && message.quote) {
      message.quote.sender = visibleQuote.sender || message.quote.sender;
      message.quote.text = visibleQuote.text || message.quote.text;
      message.quote.mediaHint = visibleQuote.mediaHint || message.quote.mediaHint;
      message.quote.media = [...cachedMedia, ...visibleMedia];
    }

    return [...cachedMedia, ...visibleMedia].filter(media => {
      if (!media?.src || seenSources.has(media.src)) return false;
      seenSources.add(media.src);
      return true;
    });
  }

  getMediaExtension(mimeType, kind) {
    const extensions = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/ogg': 'ogv'
    };
    return extensions[mimeType] || (kind === 'video' ? 'mp4' : 'jpg');
  }

  isVisibleElement(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  getVideoCacheKey(message) {
    return `${message?.chatId || this.chatId || 'no-chat'}|${this.createMessageId(message)}`;
  }

  async retainCapturedVideo(message, captured) {
    if (!captured?.blob || captured.blob.size < 128) return null;
    const record = {
      blob: captured.blob,
      src: captured.src || '',
      mimeType: captured.mimeType || captured.blob.type || 'video/mp4'
    };
    this.videoBlobCache.set(this.getVideoCacheKey(message), record);
    await this.persistMediaAsset(message, {
      kind: 'video',
      src: record.src,
      mimeType: record.mimeType
    }, record.blob, { role: 'attachment', index: 0 });
    return record;
  }

  async requestCapturedVideoBlob(contextKey, urls = [], timeoutMs = 800) {
    window.postMessage({ source: MEDIA_CONTENT_SOURCE, type: 'ping-media-hook' }, location.origin);
    if (!this.mediaHookReady) await this.sleep(80);
    if (!this.mediaHookReady) return null;

    const requestId = `video-${Date.now()}-${++this.videoCaptureSequence}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingVideoCaptureRequests.delete(requestId);
        window.postMessage({
          source: MEDIA_CONTENT_SOURCE,
          type: 'cancel-video-request',
          requestId
        }, location.origin);
        resolve(null);
      }, timeoutMs);

      this.pendingVideoCaptureRequests.set(requestId, { resolve, timer });
      window.postMessage({
        source: MEDIA_CONTENT_SOURCE,
        type: 'request-video-blob',
        requestId,
        contextKey,
        urls,
        timeoutMs
      }, location.origin);
    });
  }

  findMessageActionButton(messageElement, selectors) {
    for (const selector of selectors) {
      const match = messageElement.querySelector(selector);
      const button = match?.closest('button, [role="button"]') || match;
      if (button && this.isVisibleElement(button)) return button;
    }
    return null;
  }

  async revealMessageActions(messageElement) {
    try {
      for (const type of ['mouseenter', 'mouseover', 'pointerover']) {
        messageElement.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window
        }));
      }
    } catch (error) {
      console.debug('Unable to reveal WhatsApp message actions:', error);
    }
    await this.sleep(180);
  }

  findDownloadMenuItem(messageElement) {
    const downloadPattern = /download|下载|descargar|baixar|télécharger|herunterladen|scarica/i;
    const candidates = Array.from(document.querySelectorAll(
      '[role="menuitem"], [role="button"], button, [data-testid*="download" i], [data-icon*="download" i]'
    ));

    return candidates.find(candidate => {
      if (messageElement.contains(candidate) || !this.isVisibleElement(candidate)) return false;
      const icon = candidate.matches('[data-icon]')
        ? candidate.getAttribute('data-icon')
        : candidate.querySelector('[data-icon]')?.getAttribute('data-icon');
      const label = [
        candidate.textContent,
        candidate.getAttribute('aria-label'),
        candidate.getAttribute('title'),
        candidate.getAttribute('data-testid')
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      return /download/i.test(icon || '') || downloadPattern.test(label);
    }) || null;
  }

  async triggerVideoDownload(messageElement) {
    if (!(messageElement instanceof Element) || !document.contains(messageElement)) return false;
    const videoContainer = messageElement.querySelector('[data-testid="video-content"]');
    if (!videoContainer) return false;

    // Some undownloaded videos expose a direct download icon inside the bubble.
    // This action loads the media without invoking the central play control.
    const directDownload = this.findMessageActionButton(messageElement, [
      '[data-testid*="download" i]',
      '[data-icon="download"]',
      '[data-icon="ic-download"]'
    ]);
    if (directDownload && !directDownload.closest('[data-testid="media-play"]')) {
      directDownload.click();
      return true;
    }

    await this.revealMessageActions(messageElement);
    const menuButton = this.findMessageActionButton(messageElement, [
      '[data-testid="down-context"]',
      '[data-icon="down-context"]',
      '[data-testid="msg-menu"]',
      '[data-icon="chevron-down"]'
    ]);
    if (!menuButton) return false;

    menuButton.click();
    for (let attempt = 0; attempt < 12; attempt++) {
      await this.sleep(100);
      const downloadItem = this.findDownloadMenuItem(messageElement);
      if (!downloadItem) continue;
      downloadItem.click();
      return true;
    }
    return false;
  }

  async materializeVideoStream(messageElement, contextKey, knownUrls = []) {
    if (!(messageElement instanceof Element) || !document.contains(messageElement)) return null;
    const playControl = messageElement.querySelector('[data-testid="media-play"]');
    if (!playControl) return null;

    const previousSources = new Set(Array.from(document.querySelectorAll('video'))
      .map(video => video.currentSrc || video.src)
      .filter(Boolean));

    // Start listening before the click. WhatsApp may create and revoke the
    // decrypted Blob before the <video> source becomes observable to the
    // isolated content script.
    const hookCapture = this.requestCapturedVideoBlob(contextKey, knownUrls, 15000);

    // Target only the central media-play glyph. Clicking video-content itself
    // can hit the picture-in-picture control or a surrounding navigation area.
    playControl.click();

    const streamCapture = (async () => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 10000) {
        await this.sleep(100);
        const candidates = Array.from(document.querySelectorAll('video'));
        const video = candidates.find(candidate => {
          const source = candidate.currentSrc || candidate.src;
          return source && !previousSources.has(source);
        }) || (candidates.length === 1 ? candidates[0] : null);
        const source = video?.currentSrc || video?.src || '';
        if (!video || !source) continue;

        // WhatsApp starts inline playback as soon as the stream is materialized.
        // Stop it immediately; the same-origin stream remains fetchable for ZIP.
        try {
          video.muted = true;
          video.pause();
        } catch (error) {
          console.debug('Unable to pause the materialized WhatsApp video:', error);
        }

        try {
          const blob = await this.fetchMediaBlob({ kind: 'video', src: source }, 20000);
          return { blob, src: source, mimeType: blob.type || 'video/mp4' };
        } catch (error) {
          console.warn('Unable to fetch the materialized WhatsApp video stream:', error);
          return null;
        }
      }
      return null;
    })();

    const requireCapture = promise => promise.then(captured => {
      if (!captured?.blob) throw new Error('Video capture channel returned no Blob');
      return captured;
    });
    try {
      return await Promise.any([requireCapture(hookCapture), requireCapture(streamCapture)]);
    } catch (error) {
      console.warn('WhatsApp video was unavailable through both capture channels:', error);
      return null;
    }
  }

  async captureVideoForMessage(message, knownMedia = []) {
    const cachedVideo = this.videoBlobCache.get(this.getVideoCacheKey(message));
    if (cachedVideo) return cachedVideo;

    const persistentVideo = (await this.getPersistentMediaForMessage(message))
      .find(record => record.kind === 'video' && record.role === 'attachment');
    if (persistentVideo?.blob) {
      const restored = {
        blob: persistentVideo.blob,
        src: persistentVideo.source || '',
        mimeType: persistentVideo.mimeType || persistentVideo.blob.type || 'video/mp4'
      };
      this.videoBlobCache.set(this.getVideoCacheKey(message), restored);
      return restored;
    }

    const contextKey = this.getVideoCacheKey(message);
    const knownUrls = knownMedia.filter(media => media.kind === 'video' && media.src).map(media => media.src);
    for (const media of knownMedia.filter(item => item.kind === 'video' && item.src)) {
      try {
        const blob = await this.fetchMediaBlob(media, 8000);
        if (blob) return this.retainCapturedVideo(message, { blob, src: media.src, mimeType: blob.type });
      } catch (error) {
        console.debug('Visible WhatsApp video source was not directly fetchable:', error);
      }
    }

    // Reuse a video retained earlier in this page session before interacting
    // with WhatsApp's message menu.
    const retained = await this.requestCapturedVideoBlob(contextKey, knownUrls, 400);
    if (retained) return this.retainCapturedVideo(message, retained);

    const messageElement = message.element;
    if (!(messageElement instanceof Element) || !document.contains(messageElement) ||
        !messageElement.querySelector('[data-testid="video-content"]')) {
      return null;
    }

    window.postMessage({
      source: MEDIA_CONTENT_SOURCE,
      type: 'begin-video-capture',
      contextKey
    }, location.origin);

    try {
      const triggered = await this.triggerVideoDownload(messageElement);
      let captured = triggered
        ? await this.requestCapturedVideoBlob(contextKey, knownUrls, 8000)
        : null;
      if (!captured) captured = await this.materializeVideoStream(messageElement, contextKey, knownUrls);
      // A slow object-URL creation can land just after the materialization
      // watcher finishes. Make one short final bridge lookup before declaring
      // the historical video unavailable.
      if (!captured) captured = await this.requestCapturedVideoBlob(contextKey, knownUrls, 1500);
      return this.retainCapturedVideo(message, captured);
    } finally {
      window.postMessage({
        source: MEDIA_CONTENT_SOURCE,
        type: 'end-video-capture',
        contextKey
      }, location.origin);
    }
  }

  async getExportMediaItems(message) {
    const persistent = (await this.getPersistentMediaForMessage(message)).map(record => ({
      kind: record.kind,
      src: record.source || `persistent:${record.key}`,
      blob: record.blob,
      mimeType: record.mimeType,
      role: record.role || 'attachment',
      index: Number.isInteger(record.index) ? record.index : 0,
      isVideoPoster: Boolean(record.isVideoPoster),
      persistentKey: record.key
    }));
    const persistentSlots = new Set(persistent.map(media =>
      this.getPersistentMediaSlot(media, media.role, media.index)
    ));
    const live = this.getLiveMediaItems(message).filter(media =>
      !persistentSlots.has(this.getPersistentMediaSlot(media, media.role, media.index))
    );
    return [...persistent, ...live];
  }

  async collectMediaAssets(messages, includeVideos) {
    const assets = [];
    const mediaByMessage = new Map();
    let assetIndex = 0;
    let videoIndex = 0;
    let unavailableVideos = 0;
    const videoMessages = includeVideos
      ? messages.filter(message => message.mediaHint === 'video')
      : [];

    for (const message of messages) {
      const fetchedAssets = [];
      const mediaItems = await this.getExportMediaItems(message);

      if (includeVideos && message.mediaHint === 'video' && !mediaItems.some(media => media.kind === 'video')) {
        videoIndex++;
        this.showExportProgress(t('htmlVideoProgress', [String(videoIndex), String(videoMessages.length)]));
        const captured = await this.captureVideoForMessage(message, mediaItems);
        if (captured?.blob) {
          mediaItems.unshift({
            kind: 'video',
            src: captured.src || `captured:${this.createMessageId(message)}`,
            blob: captured.blob,
            mimeType: captured.mimeType,
            role: 'attachment',
            index: 0
          });
        }
      }

      for (const media of mediaItems) {
        if (media.kind !== 'image' && (media.kind !== 'video' || !includeVideos)) continue;

        try {
          const blob = await this.fetchMediaBlob(media, media.kind === 'video' ? 20000 : 15000);
          // WhatsApp inserts a transparent 42-byte GIF while lazy media is
          // loading. It is not an attachment and must not be archived.
          if (blob.size < 128) continue;

          const mimeType = media.mimeType || blob.type || (media.kind === 'video' ? 'video/mp4' : 'image/jpeg');
          if (!media.persistentKey) {
            await this.persistMediaAsset(message, { ...media, mimeType }, blob, media);
          }
          fetchedAssets.push({
            blob,
            kind: media.kind,
            mimeType,
            source: media.src,
            role: media.role,
            isVideoPoster: Boolean(media.isVideoPoster)
          });
        } catch (error) {
          console.warn('Unable to export media attachment:', error);
        }
      }

      if (includeVideos && message.mediaHint === 'video' &&
          !fetchedAssets.some(asset => asset.kind === 'video' && asset.role === 'attachment')) {
        unavailableVideos++;
      }

      // A message bubble can contain both WhatsApp's tiny preview and the
      // original image. Keep the original, while preserving genuine albums.
      const largestImageSizeByRole = new Map();
      fetchedAssets.filter(asset => asset.kind === 'image').forEach(asset => {
        largestImageSizeByRole.set(asset.role, Math.max(largestImageSizeByRole.get(asset.role) || 0, asset.blob.size));
      });
      const messageAssets = fetchedAssets.filter(asset => {
        const largestImageSize = largestImageSizeByRole.get(asset.role) || 0;
        if (asset.kind !== 'image' || largestImageSize < 16 * 1024) return true;
        return asset.blob.size >= Math.max(4 * 1024, largestImageSize * 0.15);
      }).map(asset => ({
        ...asset,
        filename: `${String(++assetIndex).padStart(4, '0')}-${asset.isVideoPoster ? 'video-poster' : asset.kind}.${this.getMediaExtension(asset.mimeType, asset.kind)}`
      }));

      assets.push(...messageAssets);
      mediaByMessage.set(this.createMessageId(message), messageAssets);
    }

    return { assets, mediaByMessage, unavailableVideos };
  }

  escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    })[character]);
  }

  createConversationHtml(messages, mediaByMessage, range = null) {
    const title = document.querySelector('[data-testid="conversation-info-header-chat-title"]')?.textContent?.trim() || 'WhatsApp Conversation';
    const coverage = this.getMessageCoverage(messages);
    const rangeSummary = range
      ? '<section class="export-range-summary"><div><strong>' + this.escapeHtml(t('exportSelectedRange')) +
        ':</strong> ' + this.escapeHtml(range.startDate) + ' → ' + this.escapeHtml(range.endDate) +
        '</div><div><strong>' + this.escapeHtml(t('exportActualCoverage')) + ':</strong> ' +
        this.escapeHtml(coverage?.first.timestamp || t('historyDateUnknown')) + ' → ' +
        this.escapeHtml(coverage?.last.timestamp || t('historyDateUnknown')) + '</div></section>'
      : '';
    const messageHtml = rangeSummary + messages.map(message => {
      const assets = mediaByMessage.get(this.createMessageId(message)) || [];
      const getAssetSource = asset => `media/${encodeURIComponent(asset.filename)}`;
      const renderMediaGroup = (role, videoExpected) => {
        const group = assets.filter(asset => asset.role === role);
        const videos = group.filter(asset => asset.kind === 'video');
        const posters = group.filter(asset => asset.kind === 'image' && asset.isVideoPoster)
          .sort((a, b) => b.blob.size - a.blob.size);
        const images = group.filter(asset => asset.kind === 'image' && !asset.isVideoPoster);
        const poster = posters[0];

        const videoHtml = videos.map(asset => {
          const posterAttribute = poster ? ` poster="${getAssetSource(poster)}"` : '';
          return `<video controls preload="metadata"${posterAttribute} src="${getAssetSource(asset)}"></video>`;
        }).join('');
        const imageHtml = images.map(asset =>
          `<img src="${getAssetSource(asset)}" alt="${this.escapeHtml(t('exportImageAlt'))}">`
        ).join('');

        if (videoHtml) return `${videoHtml}${imageHtml}`;
        if (videoExpected && poster) {
          return `<figure class="video-unavailable"><img src="${getAssetSource(poster)}" alt="${this.escapeHtml(t('exportVideoPosterAlt'))}"><figcaption>${this.escapeHtml(t('exportVideoUnavailable'))}</figcaption></figure>${imageHtml}`;
        }
        if (videoExpected && !imageHtml) {
          return `<div class="media-warning">${this.escapeHtml(t('exportVideoUnavailable'))}</div>`;
        }
        return `${posters.map(asset => `<img src="${getAssetSource(asset)}" alt="${this.escapeHtml(t('exportImageAlt'))}">`).join('')}${imageHtml}`;
      };
      const mediaHtml = renderMediaGroup('attachment', message.mediaHint === 'video');
      const quoteAssetsHtml = renderMediaGroup('quoted', message.quote?.mediaHint === 'video');
      const quoteHtml = message.quote ? `<aside class="quoted-message">
        <div class="quoted-label">↩ ${this.escapeHtml(message.quote.sender || t('exportQuotedMessage'))}</div>
        ${message.quote.text ? `<div class="quoted-text">${this.escapeHtml(message.quote.text).replace(/\n/g, '<br>')}</div>` : ''}
        ${quoteAssetsHtml ? `<div class="quoted-media">${quoteAssetsHtml}</div>` : (message.quote.mediaHint ? `<div class="quoted-text">${this.escapeHtml(t('exportMediaAttachment'))}</div>` : '')}
      </aside>` : '';

      return `<article class="message ${message.type === 'outgoing' ? 'outgoing' : 'incoming'}">
        <div class="meta">${this.escapeHtml(message.sender)} · ${this.escapeHtml(message.timestamp)}</div>
        ${quoteHtml}
        <div class="text">${this.escapeHtml(message.text).replace(/\n/g, '<br>')}</div>
        <div class="media">${mediaHtml}</div>
      </article>`;
    }).join('\n');

    return `<!doctype html>
<html lang="${document.documentElement.lang || 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${this.escapeHtml(title)}</title>
  <style>
    body { background:#e5ddd5; color:#111; font:14px/1.45 Arial,sans-serif; margin:0; }
    main { max-width:900px; margin:0 auto; padding:24px; }
    header { background:#fff; border-radius:8px; margin-bottom:16px; padding:18px; }
    .export-range-summary { background:#f4fff7; border:1px solid #bfe8cc; border-radius:8px; color:#315b40; margin-bottom:16px; padding:12px 14px; }
    .message { background:#fff; border-radius:8px; margin:8px 0; max-width:78%; padding:10px 12px; word-break:break-word; }
    .outgoing { background:#d9fdd3; margin-left:auto; } .incoming { margin-right:auto; }
    .meta { color:#667781; font-size:12px; margin-bottom:5px; } .media { display:grid; gap:8px; margin-top:8px; }
    .quoted-message { border-left:4px solid #00a884; background:rgba(0,0,0,.045); border-radius:4px; margin:0 0 8px; padding:7px 9px; }
    .quoted-label { color:#008069; font-size:12px; font-weight:700; } .quoted-text { color:#3b4a54; font-size:13px; margin-top:3px; }
    .quoted-media { display:flex; gap:6px; margin-top:6px; } .quoted-media img, .quoted-media video { max-height:100px; max-width:180px; }
    img, video { border-radius:6px; max-height:480px; max-width:100%; } video { background:#000; }
    .video-unavailable { margin:0; position:relative; } .video-unavailable figcaption, .media-warning { background:#fff3cd; border-radius:4px; color:#664d03; font-size:12px; margin-top:5px; padding:6px 8px; }
    @media print { body { background:#fff; } main { max-width:none; padding:0; } .message { break-inside:avoid; } }
  </style>
</head>
<body><main><header><h1>${this.escapeHtml(title)}</h1><div>${this.escapeHtml(t('exportGeneratedOn'))}: ${this.escapeHtml(new Date().toLocaleString())}</div></header>${messageHtml}</main></body>
</html>`;
  }

  async exportHtmlArchive(messages, range = null) {
    this.showNotification(t('notifyPreparingMedia'), 'info');
    const { assets, mediaByMessage, unavailableVideos } = await this.collectMediaAssets(messages, true);
    const zip = new JSZip();

    zip.file('index.html', this.createConversationHtml(messages, mediaByMessage, range));
    assets.forEach(asset => zip.file(`media/${asset.filename}`, asset.blob));

    const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    this.downloadBlob(archive, this.getExportFilePrefix(range) + '.zip');
    if (unavailableVideos > 0) {
      this.showNotification(t('htmlVideoUnavailableSummary', [String(unavailableVideos)]), 'info');
    }
  }

  sanitizeWordText(value) {
    // XML 1.0 rejects these control characters. One invisible character in a
    // WhatsApp message must not invalidate the entire DOCX package.
    return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  }

  async getWordImageCandidates(message) {
    const items = (await this.getExportMediaItems(message))
      .filter(media => media.kind === 'image' && (media.src || media.blob instanceof Blob));
    const seenSources = new Set();
    return items.filter(media => {
      if (seenSources.has(media.src)) return false;
      seenSources.add(media.src);
      return true;
    });
  }

  async fetchMediaBlob(media, timeoutMs = 15000) {
    if (media.blob instanceof Blob) return media.blob;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const streamVideo = media.kind === 'video' && /\/stream\/video(?:[/?]|$)/i.test(media.src || '');
      const response = await fetch(media.src, {
        signal: controller.signal,
        headers: streamVideo ? { Range: 'bytes=0-' } : undefined,
        credentials: streamVideo ? 'include' : 'same-origin'
      });
      if (!response.ok) throw new Error(`Media request failed with ${response.status}`);
      const blob = await response.blob();
      if (blob.size < 128) throw new Error('Media response was an empty placeholder');
      return blob;
    } finally {
      clearTimeout(timeout);
    }
  }

  async mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        try {
          results[index] = await mapper(items[index], index);
        } catch (error) {
          results[index] = { error };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async fetchBestWordImages(mediaItems) {
    const fetched = await this.mapWithConcurrency(mediaItems, 3, async media => ({
      media,
      blob: await this.fetchMediaBlob(media)
    }));
    const valid = fetched.filter(result => result?.blob instanceof Blob);
    fetched.filter(result => result?.error).forEach(result => {
      console.warn('Unable to fetch image for Word export:', result.error);
    });

    // WhatsApp exposes a tiny preview and a full image for the same attachment.
    // Compare within each role so a quoted thumbnail never removes the message's
    // own attachment (or vice versa).
    const largestByRole = new Map();
    valid.forEach(result => {
      const role = result.media.role || 'attachment';
      largestByRole.set(role, Math.max(largestByRole.get(role) || 0, result.blob.size));
    });
    return valid.filter(result => {
      const largest = largestByRole.get(result.media.role || 'attachment') || 0;
      if (largest < 16 * 1024) return true;
      return result.blob.size >= Math.max(4 * 1024, largest * 0.15);
    });
  }

  async prepareWordImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('The image could not be decoded'));
        element.src = url;
      });
      const sourceWidth = Math.max(1, image.naturalWidth);
      const sourceHeight = Math.max(1, image.naturalHeight);
      const sourceType = this.getMediaExtension(blob.type, 'image');
      const supported = ['jpg', 'png', 'gif', 'bmp'].includes(sourceType);
      const mustOptimize = !supported || blob.size > 350 * 1024 ||
                           sourceWidth > 1600 || sourceHeight > 1600;
      let outputBlob = blob;
      let outputType = sourceType;
      let outputWidth = sourceWidth;
      let outputHeight = sourceHeight;

      if (mustOptimize) {
        const scale = Math.min(1, WORD_IMAGE_MAX_DIMENSION / sourceWidth, WORD_IMAGE_MAX_DIMENSION / sourceHeight);
        outputWidth = Math.max(1, Math.round(sourceWidth * scale));
        outputHeight = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = outputWidth;
        canvas.height = outputHeight;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Image canvas is unavailable');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, outputWidth, outputHeight);
        context.drawImage(image, 0, 0, outputWidth, outputHeight);
        outputBlob = await new Promise((resolve, reject) => {
          canvas.toBlob(result => result ? resolve(result) : reject(new Error('Image compression failed')), 'image/jpeg', 0.72);
        });
        outputType = 'jpg';
        canvas.width = 1;
        canvas.height = 1;
      }

      const displayScale = Math.min(1, 520 / outputWidth, 520 / outputHeight);
      return {
        blob: outputBlob,
        type: outputType,
        transformation: {
          width: Math.max(1, Math.round(outputWidth * displayScale)),
          height: Math.max(1, Math.round(outputHeight * displayScale))
        }
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async createWordImageRun(asset) {
    const prepared = await this.prepareWordImage(asset.blob);
    return {
      run: new ImageRun({
        data: await prepared.blob.arrayBuffer(),
        type: prepared.type,
        transformation: prepared.transformation
      }),
      bytes: prepared.blob.size
    };
  }

  async exportWordDocument(messages, range = null) {
    this.showExportProgress(t('wordExportPreparing'));
    const title = document.querySelector('[data-testid="conversation-info-header-chat-title"]')?.textContent?.trim() || 'WhatsApp Conversation';
    const children = [
      new Paragraph({ text: this.sanitizeWordText(title), heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: `${t('exportGeneratedOn')}: ${new Date().toLocaleString()}` })
    ];
    if (range) {
      const coverage = this.getMessageCoverage(messages);
      children.push(
        new Paragraph({ text: t('exportSelectedRange') + ': ' + range.startDate + ' → ' + range.endDate }),
        new Paragraph({
          text: t('exportActualCoverage') + ': ' +
            (coverage?.first.timestamp || t('historyDateUnknown')) + ' → ' +
            (coverage?.last.timestamp || t('historyDateUnknown'))
        })
      );
    }
    const candidatesByMessage = await Promise.all(messages.map(async message => ({
      message,
      media: await this.getWordImageCandidates(message)
    })));
    const totalImages = candidatesByMessage.reduce((total, entry) => total + entry.media.length, 0);
    let processedImages = 0;
    let embeddedImages = 0;
    let skippedImages = 0;
    let embeddedBytes = 0;

    for (const { message, media } of candidatesByMessage) {
      children.push(new Paragraph({
        children: [new TextRun({
          text: this.sanitizeWordText(`[${message.timestamp}] ${message.sender}: ${message.text}`)
        })],
        spacing: { before: 160 }
      }));

      const bestImages = await this.fetchBestWordImages(media);
      await Promise.all(bestImages.map(asset => asset.media.persistentKey
        ? Promise.resolve()
        : this.persistMediaAsset(message, asset.media, asset.blob, asset.media)));
      let quotedLabelAdded = false;
      for (const asset of bestImages) {
        processedImages++;
        this.showExportProgress(t('wordExportImageProgress', [
          String(Math.min(processedImages, totalImages)),
          String(totalImages)
        ]));
        try {
          const prepared = await this.createWordImageRun(asset);
          if (embeddedBytes + prepared.bytes > WORD_MEDIA_BUDGET_BYTES) {
            skippedImages++;
            continue;
          }

          if (asset.media.role === 'quoted' && !quotedLabelAdded) {
            children.push(new Paragraph({
              children: [new TextRun({ text: `↩ ${t('exportQuotedMessage')}`, italics: true })],
              spacing: { before: 80 }
            }));
            quotedLabelAdded = true;
          }
          children.push(new Paragraph({ children: [prepared.run] }));
          embeddedBytes += prepared.bytes;
          embeddedImages++;
        } catch (error) {
          skippedImages++;
          console.warn('Unable to embed image in Word export:', error);
        }
        // Yield between images so WhatsApp remains responsive and progress can
        // repaint even for large conversations.
        await this.sleep(0);
      }
      processedImages += Math.max(0, media.length - bestImages.length);
    }

    if (skippedImages > 0) {
      children.push(new Paragraph({
        children: [new TextRun({
          text: t('wordExportSkippedImages', [String(skippedImages)]),
          italics: true,
          color: '777777'
        })],
        spacing: { before: 200 }
      }));
    }

    this.showExportProgress(t('wordExportBuilding', [String(embeddedImages)]));
    await this.sleep(50);
    const wordDocument = new Document({ sections: [{ children }] });
    // toBlob is docx's browser-native path and avoids holding both a large
    // ArrayBuffer and a second Blob copy at the peak of the export.
    const file = await Packer.toBlob(wordDocument);
    if (!(file instanceof Blob) || file.size === 0) {
      throw new Error(t('wordExportEmptyError'));
    }
    this.downloadBlob(file, this.getExportFilePrefix(range) + '.docx');
  }

  showInstructionsDialog() {
    return new Promise((resolve) => {
      // Create modal for instructions input
      const modal = document.createElement('div');
      modal.className = 'ai-modal';
      modal.id = 'instructions-modal';
      modal.innerHTML = `
        <div class="ai-modal-content">
          <h3>${t('instructionsTitle')}</h3>
          <p>${t('instructionsDesc')}</p>
          <textarea id="message-instructions" placeholder="${t('instructionsPlaceholder')}" rows="4"></textarea>
          <div class="ai-modal-buttons">
            <button id="skip-instructions" class="ai-button secondary">${t('btnSkip')}</button>
            <button id="apply-instructions" class="ai-button primary">${t('btnApplyInstructions')}</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Focus on textarea
      const textarea = modal.querySelector('#message-instructions');
      textarea.focus();

      // Handle skip button
      modal.querySelector('#skip-instructions').addEventListener('click', () => {
        document.body.removeChild(modal);
        resolve(''); // Return empty string if skipped
      });

      // Handle apply button
      modal.querySelector('#apply-instructions').addEventListener('click', () => {
        const instructions = textarea.value.trim();
        document.body.removeChild(modal);
        resolve(instructions);
      });

      // Handle enter key in textarea (Ctrl+Enter to apply)
      textarea.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
          const instructions = textarea.value.trim();
          document.body.removeChild(modal);
          resolve(instructions);
        } else if (e.key === 'Escape') {
          document.body.removeChild(modal);
          resolve('');
        }
      });

      // Handle backdrop click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          document.body.removeChild(modal);
          resolve('');
        }
      });
    });
  }

  async generateResponse() {
    if (this.aiProvider === 'deepseek') {
      if (!this.deepseekApiKey || this.deepseekApiKey.trim() === '') {
        this.showNotification(t('errorNoDeepSeekApiKey'), 'error');
        this.openSettings();
        return;
      }
      if (!this.deepseekApiKey.startsWith('sk-')) {
        this.showNotification(t('errorInvalidDeepSeekApiKeyFormat'), 'error');
        this.openSettings();
        return;
      }
    } else {
      if (!this.apiKey || this.apiKey.trim() === '') {
        this.showNotification(t('errorNoApiKey'), 'error');
        this.openSettings();
        return;
      }

      // Basic API key format validation
      if (!this.apiKey.startsWith('AIza')) {
        this.showNotification(t('errorInvalidApiKeyFormat'), 'error');
        this.openSettings();
        return;
      }
    }

    try {
      // Show instructions dialog first
      const messageInstructions = await this.showInstructionsDialog();

      this.showNotification(t('notifyAnalyzing'), 'info');

      const messages = await this.extractMessages();

      if (messages.length === 0) {
        this.showNotification(t('warnNoMessages'), 'warning');
        return;
      }

      const images = await this.extractRecentImages();
      if (images.length > 0) {
        if (this.aiProvider === 'deepseek') {
          this.showNotification(t('warnImagesNotSupportedDeepSeek'), 'warning');
        } else {
          this.showNotification(t('notifyImagesAttached', [String(images.length)]), 'info');
        }
      }

      this.showNotification(t('notifyGenerating'), 'info');

      const conversationText = this.formatConversationForAI(messages, messageInstructions);
      const response = await this.callAI(conversationText, images);

      if (response) {
        this.displayAIResponse(response);
        this.showNotification(t('notifyGenerateSuccess'), 'success');
      }
    } catch (error) {
      console.error('AI generation error:', error);

      let errorMessage = t('errorGenerateDefault');

      if (error.message.includes('404')) {
        errorMessage = t('errorApiNotFound');
      } else if (error.message.includes('403')) {
        errorMessage = t('errorApiForbidden');
      } else if (error.message.includes('429')) {
        errorMessage = t('errorRateLimit');
      } else if (error.message.includes('API Error')) {
        errorMessage = error.message;
      }

      this.showNotification(errorMessage, 'error');
    }
  }

  async callAI(conversationText, images = []) {
    if (this.aiProvider === 'deepseek') {
      // DeepSeek's API doesn't support image input yet, so images are ignored here
      return this.callDeepSeekAPI(conversationText);
    }
    return this.callGeminiAPI(conversationText, images);
  }

  buildUserPrompt(conversationText, imageCount = 0) {
    const imageNote = imageCount > 0
      ? `\n\n(${imageCount} image(s) from the recent conversation are attached below — use them as visual context if relevant.)`
      : '';

    return `I'm providing you with a WhatsApp conversation. Please analyze the context and generate an appropriate response that would fit naturally as the next message in this conversation.

${conversationText}${imageNote}

Based on the conversation context above, generate a natural and appropriate response. Consider:
- The tone and style of the conversation
- The most recent messages and their context
- The relationship between the participants
- Any questions or topics that need addressing

Your response:`;
  }

  async extractRecentImages(maxImages = 3) {
    const chatContainer = this.getChatContainer();
    if (!chatContainer) return [];

    // Try selectors from most to least specific, matching the same fallback style
    // used elsewhere in this file since WhatsApp's DOM structure is undocumented
    const selectors = [
      '[data-testid="image-thumb"] img[src^="blob:"]',
      'img[data-testid="image-thumb"][src^="blob:"]',
      'img[src^="blob:"]'
    ];

    let imgElements = [];
    for (const selector of selectors) {
      imgElements = Array.from(chatContainer.querySelectorAll(selector));
      if (imgElements.length > 0) break;
    }

    const recentImages = imgElements.slice(-maxImages);
    const attachments = [];

    for (const img of recentImages) {
      try {
        const response = await fetch(img.src);
        const blob = await response.blob();
        const data = await this.blobToBase64(blob);
        attachments.push({ mimeType: blob.type || 'image/jpeg', data });
      } catch (error) {
        console.error('Failed to read image for AI attachment:', error);
      }
    }

    return attachments;
  }

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async callDeepSeekAPI(conversationText) {
    const systemPrompt = this.systemInstructions || t('defaultSystemInstructions');
    const userPrompt = this.buildUserPrompt(conversationText);

    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.deepseekApiKey}`
        },
        body: JSON.stringify({
          model: this.deepseekModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 1024
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('API Error Details:', errorData);
        throw new Error(`API Error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
      }

      const data = await response.json();
      const generatedText = data.choices?.[0]?.message?.content;

      if (!generatedText || generatedText.trim() === '') {
        console.error('No text found in response structure:', JSON.stringify(data, null, 2));
        throw new Error('No text generated by AI');
      }

      return generatedText.trim();
    } catch (error) {
      console.error('DeepSeek API error:', error);
      throw error;
    }
  }

  async callGeminiAPI(conversationText, images = []) {
    const systemPrompt = this.systemInstructions || t('defaultSystemInstructions');
    const prompt = `${systemPrompt}\n\n${this.buildUserPrompt(conversationText, images.length)}`;

    const parts = [
      { text: prompt },
      ...images.map(image => ({
        inline_data: { mime_type: image.mimeType, data: image.data }
      }))
    ];

    try {
      const response = await fetch(GEMINI_GENERATE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey
        },
        body: JSON.stringify({
          contents: [{
            parts: parts
          }],
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 1024,
          },
          safetySettings: [
            {
              category: "HARM_CATEGORY_HARASSMENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              category: "HARM_CATEGORY_HATE_SPEECH",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            }
          ]
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('API Error Details:', errorData);
        throw new Error(`API Error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
      }

      const data = await response.json();
      // Check if response was truncated due to max tokens
      const finishReason = data.candidates?.[0]?.finishReason;
      if (finishReason === 'MAX_TOKENS') {
        console.warn('Response was truncated due to max tokens limit');
      }
      
      // Try different possible response structures
      let generatedText = null;
      
      // Gemini 3.5 may return reasoning parts before its visible answer. Only
      // show non-thought text to the user, while retaining compatibility with
      // the older single-part response structure.
      const responseParts = data.candidates?.[0]?.content?.parts || [];
      const visibleTextParts = responseParts.filter(part => part.text && !part.thought);
      if (visibleTextParts.length > 0) {
        generatedText = visibleTextParts.map(part => part.text).join('\n');
      }
      // Standard Gemini response structure
      else if (responseParts[0]?.text) {
        generatedText = responseParts[0].text;
      }
      // Alternative structure - sometimes content is directly text
      else if (data.candidates?.[0]?.content && typeof data.candidates[0].content === 'string') {
        generatedText = data.candidates[0].content;
      }
      // Another possible structure
      else if (data.candidates?.[0]?.text) {
        generatedText = data.candidates[0].text;
      }
      // Check if response contains the text at root level
      else if (data.text) {
        generatedText = data.text;
      }
      
      if (!generatedText || generatedText.trim() === '') {
        console.error('No text found in response structure:', JSON.stringify(data, null, 2));
        
        // If MAX_TOKENS, show a more helpful error
        if (finishReason === 'MAX_TOKENS') {
          throw new Error('Response was truncated due to length limits. Try using fewer messages or shorter instructions.');
        }
        
        throw new Error('No text generated by AI');
      }
      
      return generatedText.trim();
    } catch (error) {
      console.error('Gemini API error:', error);
      throw error;
    }
  }

  displayAIResponse(response) {
    // Create modal to display AI response
    const modal = document.createElement('div');
    modal.id = 'ai-response-modal';
    modal.innerHTML = `
      <div class="ai-modal-content">
        <div class="ai-modal-header">
          <h3>${t('aiResponseTitle')}</h3>
          <button class="ai-modal-close">&times;</button>
        </div>
        <div class="ai-modal-body">
          <textarea id="ai-response-text" readonly></textarea>
          <div class="ai-modal-actions">
            <button id="copy-response">${t('btnCopyClipboard')}</button>
            <button id="insert-response">${t('btnInsertChat')}</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Set via .value (not innerHTML) so AI-generated text can never be parsed as markup
    modal.querySelector('#ai-response-text').value = response;

    // Add event listeners
    modal.querySelector('.ai-modal-close').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    document.getElementById('copy-response').addEventListener('click', () => {
      navigator.clipboard.writeText(response);
      this.showNotification(t('notifyCopied'), 'success');
    });
    
    document.getElementById('insert-response').addEventListener('click', () => {
      this.insertResponseIntoChat(response);
      document.body.removeChild(modal);
    });
  }

  insertResponseIntoChat(response) {
    const messageInput = document.querySelector('[data-testid="message-input"]') ||
                        document.querySelector('#main footer div[contenteditable="true"]') ||
                        document.querySelector('div[data-tab="10"]');
    
    if (messageInput) {
      messageInput.focus();

      // Use different methods depending on the input type
      if (messageInput.contentEditable === 'true') {
        // Insert as text nodes (never parsed as HTML) so AI output can't inject markup/scripts
        messageInput.innerHTML = '';
        const lines = response.split('\n');
        lines.forEach((line, index) => {
          messageInput.appendChild(document.createTextNode(line));
          if (index < lines.length - 1) {
            messageInput.appendChild(document.createElement('br'));
          }
        });

        // Move cursor to the end so the agent can keep typing/editing
        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(messageInput);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);

        // Trigger input event
        const event = new Event('input', { bubbles: true });
        messageInput.dispatchEvent(event);
      } else {
        messageInput.value = response;
        
        // Trigger change event
        const event = new Event('change', { bubbles: true });
        messageInput.dispatchEvent(event);
      }
      
      this.showNotification(t('notifyInserted'), 'success');
    } else {
      this.showNotification(t('errorNoInputField'), 'error');
    }
  }

  openSettings() {
    // Create settings modal
    const modal = document.createElement('div');
    modal.id = 'ai-settings-modal';
    modal.innerHTML = `
      <div class="ai-modal-content">
        <div class="ai-modal-header">
          <h3>${t('settingsTitle')}</h3>
          <button class="ai-modal-close">&times;</button>
        </div>
        <div class="ai-modal-body">
          <div class="setting-group">
            <label for="ai-provider">${t('labelProvider')}</label>
            <select id="ai-provider">
              <option value="gemini">${t('providerGemini')}</option>
              <option value="deepseek">${t('providerDeepSeek')}</option>
            </select>
          </div>

          <div class="setting-group" id="gemini-settings-group">
            <label for="gemini-api-key">${t('labelApiKey')}</label>
            <input type="password" id="gemini-api-key" placeholder="${t('placeholderApiKey')}">
            <small>
              ${t('apiKeyStep1')}<br>
              ${t('apiKeyStep2')}<br>
              ${t('apiKeyStep3')}<br>
              ${t('apiKeyStep4')}
            </small>
          </div>

          <div class="setting-group" id="deepseek-settings-group">
            <label for="deepseek-api-key">${t('labelDeepSeekApiKey')}</label>
            <input type="password" id="deepseek-api-key" placeholder="${t('placeholderDeepSeekApiKey')}">
            <small>
              ${t('deepSeekApiKeyStep1')}<br>
              ${t('deepSeekApiKeyStep2')}<br>
              ${t('deepSeekApiKeyStep3')}<br>
              ${t('deepSeekApiKeyStep4')}
            </small>
            <label for="deepseek-model" style="margin-top: 10px;">${t('labelDeepSeekModel')}</label>
            <select id="deepseek-model">
              <option value="deepseek-v4-flash">${t('modelDeepSeekFlash')}</option>
              <option value="deepseek-v4-pro">${t('modelDeepSeekPro')}</option>
            </select>
          </div>

          <div class="setting-group">
            <label for="system-instructions">${t('labelSystemInstructions')}</label>
            <textarea id="system-instructions" placeholder="${t('placeholderSystemInstructions')}" rows="6"></textarea>
            <small>
              <strong>${t('systemInstructionsHelpTitle')}</strong> ${t('systemInstructionsHelpDesc')}<br>
              <strong>${t('examplesTitle')}</strong><br>
              • ${t('example1')}<br>
              • ${t('example2')}<br>
              • ${t('example3')}<br>
              • ${t('example4')}
            </small>
          </div>

          <div class="setting-group">
            <details>
              <summary style="cursor: pointer; margin-bottom: 10px; font-weight: 500;">${t('presetSectionTitle')}</summary>
              <div class="preset-buttons">
                <button type="button" class="preset-btn" data-preset="professional">${t('presetProfessional')}</button>
                <button type="button" class="preset-btn" data-preset="friendly">${t('presetFriendly')}</button>
                <button type="button" class="preset-btn" data-preset="brief">${t('presetBrief')}</button>
                <button type="button" class="preset-btn" data-preset="creative">${t('presetCreative')}</button>
                <button type="button" class="preset-btn" data-preset="support">${t('presetSupport')}</button>
                <button type="button" class="preset-btn" data-preset="translator">${t('presetTranslator')}</button>
              </div>
            </details>
          </div>

          <div class="setting-group">
            <label>${t('labelTestConnection')}</label>
            <button id="test-api" type="button" style="padding: 8px 16px; background: #17a2b8; color: white; border: none; border-radius: 4px; cursor: pointer;">${t('btnTestConnection')}</button>
          </div>
          <div class="ai-modal-actions">
            <button id="save-settings">${t('btnSaveSettings')}</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);

    // Set the provider/model dropdowns to the currently saved values and
    // show only the API key group that matches the selected provider
    const providerSelect = modal.querySelector('#ai-provider');
    const geminiApiKeyInput = modal.querySelector('#gemini-api-key');
    const deepSeekApiKeyInput = modal.querySelector('#deepseek-api-key');
    const systemInstructionsInput = modal.querySelector('#system-instructions');
    const geminiGroup = modal.querySelector('#gemini-settings-group');
    const deepseekGroup = modal.querySelector('#deepseek-settings-group');
    providerSelect.value = this.aiProvider;
    geminiApiKeyInput.value = this.apiKey;
    deepSeekApiKeyInput.value = this.deepseekApiKey;
    systemInstructionsInput.value = this.systemInstructions;
    modal.querySelector('#deepseek-model').value = this.deepseekModel;

    const toggleProviderGroups = () => {
      const isDeepSeek = providerSelect.value === 'deepseek';
      geminiGroup.style.display = isDeepSeek ? 'none' : 'block';
      deepseekGroup.style.display = isDeepSeek ? 'block' : 'none';
    };
    toggleProviderGroups();
    providerSelect.addEventListener('change', toggleProviderGroups);

    // Preset instructions
    const presets = {
      professional: t('presetProfessionalText'),
      friendly: t('presetFriendlyText'),
      brief: t('presetBriefText'),
      creative: t('presetCreativeText'),
      support: t('presetSupportText'),
      translator: t('presetTranslatorText')
    };
    
    // Add event listeners for preset buttons
    modal.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.getAttribute('data-preset');
        const textarea = document.getElementById('system-instructions');
        textarea.value = presets[preset];
        
        // Visual feedback
        btn.style.background = '#25d366';
        btn.style.color = 'white';
        setTimeout(() => {
          btn.style.background = '';
          btn.style.color = '';
        }, 500);
      });
    });
    
    // Add event listeners
    modal.querySelector('.ai-modal-close').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    document.getElementById('test-api').addEventListener('click', async () => {
      const isDeepSeek = providerSelect.value === 'deepseek';
      const apiKey = isDeepSeek
        ? document.getElementById('deepseek-api-key').value
        : document.getElementById('gemini-api-key').value;

      if (!apiKey) {
        this.showNotification(t('warnEnterApiKeyFirst'), 'warning');
        return;
      }

      this.showNotification(t('notifyTestingConnection'), 'info');

      try {
        const testResponse = isDeepSeek
          ? await fetch('https://api.deepseek.com/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
              },
              body: JSON.stringify({
                model: document.getElementById('deepseek-model').value,
                messages: [{ role: 'user', content: 'Hello, this is a test.' }],
                max_tokens: 20
              })
            })
          : await fetch(GEMINI_GENERATE_ENDPOINT, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
              },
              body: JSON.stringify({
                contents: [{ parts: [{ text: 'Hello, this is a test.' }] }]
              })
            });

        if (testResponse.ok) {
          this.showNotification(t('notifyApiConnectionSuccess'), 'success');
        } else {
          const errorData = await testResponse.json().catch(() => ({}));
          this.showNotification(t('errorApiTestFailed', [errorData.error?.message || t('errorInvalidApiKeyGeneric')]), 'error');
        }
      } catch (error) {
        this.showNotification(t('errorApiTestNetwork'), 'error');
      }
    });

    document.getElementById('save-settings').addEventListener('click', async () => {
      const apiKey = document.getElementById('gemini-api-key').value.trim();
      const deepseekApiKey = document.getElementById('deepseek-api-key').value.trim();
      const deepseekModel = document.getElementById('deepseek-model').value;
      const systemInstructions = document.getElementById('system-instructions').value.trim();

      if (apiKey && !apiKey.startsWith('AIza')) {
        this.showNotification(t('errorInvalidApiKeyFormatSave'), 'error');
        return;
      }
      if (deepseekApiKey && !deepseekApiKey.startsWith('sk-')) {
        this.showNotification(t('errorInvalidDeepSeekApiKeyFormatSave'), 'error');
        return;
      }

      this.apiKey = apiKey;
      this.deepseekApiKey = deepseekApiKey;
      this.deepseekModel = deepseekModel;
      this.aiProvider = providerSelect.value;
      this.systemInstructions = systemInstructions || t('defaultSystemInstructions');

      try {
        await chrome.storage.local.set({
          geminiApiKey: apiKey,
          deepseekApiKey: deepseekApiKey
        });
        await chrome.storage.sync.set({
          deepseekModel: deepseekModel,
          aiProvider: this.aiProvider,
          systemInstructions: this.systemInstructions
        });
      } catch (error) {
        console.error('Unable to save settings:', error);
        this.showNotification(t('errorSettingsSaveFailed'), 'error');
        return;
      }

      this.showNotification(t('notifySettingsSaved'), 'success');
      document.body.removeChild(modal);
    });
  }

  showExportProgress(message) {
    let notification = this.exportProgressNotification;
    if (!notification || !document.body.contains(notification)) {
      notification = document.createElement('div');
      notification.className = 'ai-notification ai-notification-info ai-export-progress';
      document.body.appendChild(notification);
      this.exportProgressNotification = notification;
      requestAnimationFrame(() => notification.classList.add('show'));
    }
    notification.textContent = message;
  }

  clearExportProgress() {
    const notification = this.exportProgressNotification;
    this.exportProgressNotification = null;
    if (!notification) return;
    notification.classList.remove('show');
    setTimeout(() => notification.remove(), 300);
  }

  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `ai-notification ai-notification-${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.classList.add('show');
    }, 100);
    
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => {
        if (document.body.contains(notification)) {
          document.body.removeChild(notification);
        }
      }, 300);
    }, 3000);
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openSettings' && window.whatsappAI) {
    window.whatsappAI.openSettings();
    sendResponse({ success: true });
  }
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.whatsappAI = new WhatsAppAI();
  });
} else {
  window.whatsappAI = new WhatsAppAI();
}

} // Close the whatsappAILoaded check
