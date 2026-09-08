const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
const classStart = source.indexOf('class WhatsAppAI');
const classEnd = source.indexOf('// Listen for messages from popup');
assert(classStart >= 0 && classEnd > classStart, 'Unable to locate WhatsAppAI class');

const context = vm.createContext({ console });
vm.runInContext(`${source.slice(classStart, classEnd)}; globalThis.WhatsAppAI = WhatsAppAI;`, context);

const messages = Array.from({ length: 101 }, (_, index) => ({
  timestamp: `2026-08-${String(index + 1).padStart(2, '0')}`,
  sender: `sender-${index}`,
  text: `message-${index}`
}));
const formatter = context.WhatsAppAI.prototype.formatConversationForAI;
const output = formatter.call({}, messages, '  Reply briefly.  ');

assert(output.includes('Recent messages (showing 100 most recent):'));
assert(!output.includes('message-0'));
assert(output.includes('message-1'));
assert(output.includes('message-100'));
assert(output.includes('--- Instructions for next message ---\nReply briefly.\n--- End instructions ---'));

console.log('content formatter tests passed');
