const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const listeners = new Map();
const emitted = [];
const documentAttributes = new Map();
const location = { origin: 'https://web.whatsapp.com' };
const document = {
  documentElement: {
    setAttribute(name, value) {
      documentAttributes.set(name, value);
    }
  },
  addEventListener() {}
};

class HTMLAnchorElement {
  constructor(href, { download = false } = {}) {
    this.href = href;
    this.download = download ? 'video.mp4' : '';
    this.clicked = 0;
  }

  getAttribute(name) {
    return name === 'href' ? this.href : null;
  }

  hasAttribute(name) {
    return name === 'download' && Boolean(this.download);
  }

  click() {
    this.clicked++;
  }
}
const window = {
  addEventListener(type, listener) {
    const handlers = listeners.get(type) || [];
    handlers.push(listener);
    listeners.set(type, handlers);
  },
  postMessage(data) {
    emitted.push(data);
    for (const listener of listeners.get('message') || []) {
      listener({ source: window, origin: location.origin, data });
    }
  }
};

let objectUrlSequence = 0;
const HookURL = {
  createObjectURL() {
    return `blob:https://web.whatsapp.com/test-${++objectUrlSequence}`;
  },
  revokeObjectURL() {}
};

let fetchCalls = 0;

const context = vm.createContext({
  Blob,
  fetch: async href => {
    fetchCalls++;
    return {
      ok: true,
      headers: { get: () => null },
      blob: async () => new Blob([Buffer.alloc(256, 3)], {
        type: href.startsWith('blob:') ? 'video/mp4' : 'text/html'
      })
    };
  },
  HTMLAnchorElement,
  URL: HookURL,
  console,
  document,
  location,
  setTimeout,
  clearTimeout,
  window
});

vm.runInContext(fs.readFileSync(require.resolve('../media-hook.js'), 'utf8'), context);
assert(emitted.some(message => message.type === 'hook-ready'), 'hook did not announce readiness');
assert.strictEqual(documentAttributes.get('data-whatsapp-ai-media-hook'), 'ready');

window.postMessage({
  source: 'whatsapp-ai-content',
  type: 'begin-video-capture',
  contextKey: 'message:test'
});

const video = new Blob([Buffer.alloc(512, 7)], { type: 'video/mp4' });
const url = HookURL.createObjectURL(video);
const available = emitted.find(message => message.type === 'video-available' && message.contextKey === 'message:test');
assert(available, 'captured video was not announced');
assert(available.blob instanceof Blob, 'video announcement did not include the retained Blob');
assert.strictEqual(available.blob.size, 512);
window.postMessage({
  source: 'whatsapp-ai-content',
  type: 'request-video-blob',
  requestId: 'request:test',
  contextKey: 'message:test',
  urls: [url],
  timeoutMs: 1000
});

const response = emitted.find(message => message.type === 'video-blob' && message.requestId === 'request:test');
assert(response, 'captured video was not returned');
assert.strictEqual(response.contextKey, 'message:test');
assert.strictEqual(response.mimeType, 'video/mp4');
assert.strictEqual(response.size, 512);
assert(response.blob instanceof Blob);
assert.strictEqual(documentAttributes.get('data-whatsapp-ai-video-blobs'), '1');

window.postMessage({
  source: 'whatsapp-ai-content',
  type: 'end-video-capture',
  contextKey: 'message:test'
});
window.postMessage({
  source: 'whatsapp-ai-content',
  type: 'begin-video-capture',
  contextKey: 'message:anchor'
});

const unrelatedLink = new HTMLAnchorElement('https://example.com/archive.zip', { download: true });
unrelatedLink.click();
assert.strictEqual(unrelatedLink.clicked, 1, 'HTTPS downloads must bypass the media hook');
assert.strictEqual(fetchCalls, 0, 'HTTPS downloads must never be fetched by the media hook');

const navigationLink = new HTMLAnchorElement('blob:https://web.whatsapp.com/navigation');
navigationLink.click();
assert.strictEqual(navigationLink.clicked, 1, 'anchors without download must bypass the media hook');

const downloadUrl = HookURL.createObjectURL(new Blob([Buffer.alloc(256, 9)], { type: 'video/mp4' }));
const videoDownload = new HTMLAnchorElement(downloadUrl, { download: true });
videoDownload.click();
assert.strictEqual(videoDownload.clicked, 0, 'captured video downloads must not start a duplicate browser download');
assert(emitted.some(message => message.type === 'video-available' && message.contextKey === 'message:anchor'),
  'anchor video was not associated with the active capture');

console.log('media hook capture and anchor-scope tests passed');
