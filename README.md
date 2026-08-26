# WhatsApp Web AI Assistant

English | [中文](README.zh-CN.md)

A Chrome extension that exports WhatsApp Web conversations and generates AI responses with Google Gemini or DeepSeek.

## Features

- 📤 **Date-range exports**: Select a start and end date, automatically load only the required history, and download an HTML ZIP with images/videos or a Word document with images
- 🤖 **AI Response Generation**: Generate contextually appropriate responses using Gemini 3.5 Flash or DeepSeek V4
- ⚙️ **Custom System Instructions**: Personalize AI behavior with custom instructions and presets
- ✨ **Smart Integration**: Insert AI-generated responses directly into WhatsApp's message input
- 📋 **Copy to Clipboard**: Easily copy generated responses for use elsewhere
- 🔒 **Privacy-Focused**: Capture, caching, and formatting happen locally; AI context is sent only when you request a response

## Installation

1. **Download or clone** this repository. The committed `dist/` directory can be loaded directly; after changing source code, run `npm install` and `npm run build` first.
2. **Open Chrome** and navigate to `chrome://extensions/`.
3. **Enable Developer Mode** (toggle in the top-right corner).
4. **Click "Load unpacked"** and select the extension folder.
5. **Pin the extension** to your toolbar for easy access.

## Setup

1. **Get an API Key** from [Google AI Studio](https://aistudio.google.com/app/apikey) or the [DeepSeek Platform](https://platform.deepseek.com/api_keys).

   For Gemini:
   - Visit [Google AI Studio](https://aistudio.google.com/app/apikey)
   - Sign in with your Google account
   - Create a new API key (free tier available)

2. **Configure the Extension**:
   - Open [WhatsApp Web](https://web.whatsapp.com)
   - Look for the green floating AI button (bottom-right corner)
   - Click the button and select "Settings"
   - Choose Gemini or DeepSeek, enter the matching API key, and save
   - Optionally customize the system instructions to personalize AI responses

## Usage

### Exporting Conversations

1. Open any WhatsApp conversation
2. Click the floating AI button
3. Select "Export Conversation"
4. Optionally select both a start and end date. The extension loads backward to the start date, caches media in range, and restores your reading position
5. Choose an export format:
   - **HTML Archive** downloads a ZIP containing `index.html` and its image/video files
   - **Word Document** downloads a `.docx` with images only; videos are excluded

### Generating AI Responses

1. Make sure your API key is configured
2. Open any WhatsApp conversation
3. Click the floating AI button
4. Select "Generate AI Response"
5. Wait for the AI to analyze and generate a response
6. Choose to copy or insert the response directly into the chat

### Customizing AI Behavior

1. Click the AI button and go to Settings
2. In the "System Instructions" field, enter custom instructions such as:
   - "Always respond in a professional manner"
   - "Keep responses brief and to the point"  
   - "Act as a customer support agent"
   - "Respond in Spanish with enthusiasm"
3. Use preset buttons for common instruction templates
4. Save your settings

The AI will use these instructions to tailor its responses to your needs.

## How It Works

The extension uses advanced DOM selectors to extract messages from WhatsApp Web:

- **Incoming messages**: Detected using `.message-in` class
- **Outgoing messages**: Detected using `.message-out` class
- **Message content**: Extracted from `.selectable-text` elements
- **Timestamps**: Retrieved from message metadata
- **Group chat senders**: Identified from message attributes

The 50 most recent extracted messages are formatted and sent to the selected AI provider only when you request a response.

## Technical Details

### Message Detection
```javascript
// Incoming messages (like your HTML example)
document.querySelectorAll('.message-in')

// Outgoing messages
document.querySelectorAll('.message-out')

// Message containers
document.querySelectorAll('[data-testid="msg-container"]')
```

### AI Integration
- **Models**: `gemini-3.5-flash`, `deepseek-v4-flash`, or `deepseek-v4-pro`
- **Temperature**: 0.7 (balanced creativity)
- **Max Tokens**: 1024
- **Context**: 50 most recent messages

### Supported Features
- ✅ Text messages
- ✅ Group chats
- ✅ Individual chats
- ✅ Message timestamps
- ✅ Sender identification
- ✅ Images in HTML ZIP and Word exports
- ✅ Videos in HTML ZIP exports
- ⚠️ Word exports intentionally exclude videos

## Privacy & Security

- Message capture, caching, and formatting happen locally in your browser
- API keys are stored on this device in Chrome local storage; browser extension storage is not encrypted, so protect access to your browser profile
- The 50-message AI context, plus up to three recent images for Gemini, is sent only when you explicitly request an AI response
- Message metadata is bounded in local storage; cached media uses a bounded IndexedDB cache and older entries may be evicted
- No data is sent to servers other than the AI provider you select
- Extension only works on `web.whatsapp.com` for security

## File Structure

```
whatsapp-web-ai/
├── manifest.json          # Extension configuration
├── content.js             # Source for WhatsApp integration and UI
├── media-hook.js          # Narrow MAIN-world bridge for decrypted video Blobs
├── dist/content.js        # Built content script loaded by the manifest
├── scripts/               # Build, package, and media-hook tests
├── src/cache-policy.mjs   # Pure cache quota and eviction policy
├── styles.css             # UI styling
├── popup.html             # Extension popup interface
├── popup.js               # Popup functionality
├── help.html              # In-extension help page (localized via _locales)
├── _locales/
│   ├── en/messages.json    # English UI strings
│   └── zh_CN/messages.json # Chinese (Simplified) UI strings
├── package.json           # Build/test/package commands
├── README.md              # This file
└── README.zh-CN.md        # Chinese version of this file
```

The extension UI (popup, floating button, notifications, settings, and the help page) is localized using Chrome's `chrome.i18n` API and automatically follows your browser's display language (currently English and Chinese are supported).

## Development

### Prerequisites
- Chrome browser
- Basic knowledge of JavaScript/HTML/CSS
- A Gemini or DeepSeek API key for AI-response testing

### Local Development
1. Clone the repository
2. Run `npm install`
3. Make changes to the source files and run `npm run build`
4. Reload the extension in `chrome://extensions/`
5. Test on WhatsApp Web

### Key Components

**content.js**: Main script that:
- Detects WhatsApp messages using CSS selectors
- Extracts conversation data
- Interfaces with Gemini and DeepSeek APIs
- Manages UI interactions

**styles.css**: Provides styling for:
- Floating action button
- Modal dialogs
- Responsive design
- Notification system

## Troubleshooting

### Extension Not Working
- Refresh WhatsApp Web page
- Check if extension is enabled in Chrome
- Verify you're on `web.whatsapp.com`

### AI Responses Not Generating
- Verify API key is correctly entered
- Check internet connection
- Ensure you haven't exceeded API limits

### Messages Not Extracting
- Make sure conversation is fully loaded
- Scroll up to load older messages
- Try refreshing the page

## API Rate Limits

Limits and pricing change over time. Check the current Gemini or DeepSeek documentation for the account and model you selected.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly on WhatsApp Web
5. Submit a pull request

## License

This project is open source and available under the MIT License.

## Disclaimer

This extension is not affiliated with WhatsApp or Meta. It's an independent tool designed to enhance the WhatsApp Web experience through AI integration.

## Support

For issues, suggestions, or questions:
- Open an issue in the GitHub repository
- Check the help.html file for detailed documentation
- Review the troubleshooting section above

---

**Note**: AI response generation requires either a Gemini or DeepSeek API key. Conversation export does not require an API key.
