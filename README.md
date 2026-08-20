# VoiceFill AI - Chrome Extension

Fill Google Forms using your voice! Just open any Google Form, click the extension, and speak your answers. VoiceFill AI automatically understands and fills in the form fields for you.

## Features

- 🎙️ **Voice-powered**: Speak naturally and VoiceFill fills the form
- 🤖 **AI-powered**: Uses Groq LLM to understand speech and extract data
- 📝 **Auto-detect**: Scans Google Forms DOM to find all questions automatically
- ✅ **Auto-fill**: Fills text, radio, checkbox, dropdown, and date fields
- 🔄 **Conversational**: AI asks follow-up questions for missing fields
- 🎨 **Beautiful UI**: Premium dark theme with micro-animations

## Setup

### 1. Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **"Load unpacked"**
4. Select the `voicefill-ai` folder
5. The VoiceFill extension icon will appear in your toolbar

### 2. Set Your API Key

1. Click the VoiceFill extension icon
2. Click the ⚙️ settings gear icon
3. Enter your **Groq API key** (get one free at [console.groq.com](https://console.groq.com))
4. Click **Save Key**

### 3. Use It

1. Open any Google Form in Chrome
2. Click the VoiceFill extension icon
3. The extension will automatically scan the form fields
4. Click **"Start Talking"** and speak your answers
5. VoiceFill will fill in the form as you speak!

## Tech Stack

- **Manifest V3** Chrome Extension
- **Groq API** with Llama 3.3 70B for AI conversation
- **Web Speech API** for voice recognition & text-to-speech
- **Vanilla HTML/CSS/JS** — no build step needed

## File Structure

```
voicefill-ai/
├── manifest.json     # Extension config
├── background.js     # Service worker
├── content.js        # Injected into Google Forms
├── popup.html        # Extension popup UI
├── popup.css         # Styling
├── popup.js          # Popup logic (voice, AI, messaging)
└── icons/            # Extension icons
```
