/**
 * VoiceFill AI - Popup Script
 * Handles voice recognition, AI conversation, and communication with content script.
 */

(() => {
  'use strict';

  // ─── Config ───
  const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
  // Groq retires model IDs over time — resolve an available model at runtime.
  const MODEL_PREFS = [
    'llama-3.3-70b-versatile',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'openai/gpt-oss-120b',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-20b',
  ];
  let TEXT_MODEL = MODEL_PREFS[0];
  let modelResolved = false;

  // ─── State ───
  let apiKey = '';
  let fields = [];
  let formValues = {};
  let isListening = false;
  let isProcessing = false;
  let recognition = null;
  let currentTranscript = '';
  let silenceTimeout = null;
  let activeTabId = null;

  // ─── DOM Elements ───
  const $ = (sel) => document.querySelector(sel);
  const settingsBtn = $('#settingsBtn');
  const resetBtn = $('#resetBtn');
  const settingsPanel = $('#settingsPanel');
  const apiKeyInput = $('#apiKeyInput');
  const saveKeyBtn = $('#saveKeyBtn');
  const notOnForm = $('#notOnForm');
  const mainContent = $('#mainContent');
  const aiMessage = $('#aiMessage');
  const aiThinking = $('#aiThinking');
  const aiAvatar = $('#aiAvatar');
  const progressSection = $('#progressSection');
  const progressLabel = $('#progressLabel');
  const progressPercent = $('#progressPercent');
  const progressFill = $('#progressFill');
  const fieldsList = $('#fieldsList');
  const transcriptBox = $('#transcriptBox');
  const transcriptText = $('#transcriptText');
  const waveform = $('#waveform');
  const micBtn = $('#micBtn');
  const micIcon = $('#micIcon');
  const micOffIcon = $('#micOffIcon');
  const micLabel = $('#micLabel');
  const toast = $('#toast');
  const toastText = $('#toastText');
  const micWarning = $('#micWarning');

  // ─── Init ───
  async function init() {
    // Load API key
    const stored = await chrome.storage.local.get(['groqApiKey']);
    if (stored.groqApiKey) {
      apiKey = stored.groqApiKey;
      apiKeyInput.value = '••••••••••••••••';
    }

    // Check if we're on a Google Form
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      activeTabId = tab?.id;

      if (tab?.url?.includes('docs.google.com/forms')) {
        notOnForm.classList.add('hidden');
        mainContent.classList.remove('hidden');
        
        // Make sure content script is injected
        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            files: ['content.js']
          });
        } catch (e) {
          // Already injected or permissions issue
          console.log('[VoiceFill] Content script injection:', e.message);
        }

        // Short delay for content script to initialize
        setTimeout(() => scanForm(), 500);
      } else {
        notOnForm.classList.remove('hidden');
        mainContent.classList.add('hidden');
      }
    });

    // Event listeners
    settingsBtn.addEventListener('click', toggleSettings);
    resetBtn.addEventListener('click', resetAll);
    saveKeyBtn.addEventListener('click', saveApiKey);
    micBtn.addEventListener('click', toggleListening);
    micWarning.addEventListener('click', openGrantPage);

    // Mic blocked proactively? Show the fix banner.
    checkMicPermission();
  }

  async function checkMicPermission() {
    try {
      const st = await navigator.permissions.query({ name: 'microphone' });
      if (st.state === 'denied') {
        micWarning.classList.remove('hidden');
        micBtn.disabled = true;
      } else if (st.state === 'granted') {
        micWarning.classList.add('hidden');
      }
    } catch (e) { /* permissions API unavailable — onerror path handles it */ }
  }

  function openGrantPage() {
    chrome.tabs.create({ url: chrome.runtime.getURL('grant.html'), active: true });
  }

  // ─── Settings ───
  function toggleSettings() {
    settingsPanel.classList.toggle('hidden');
    if (!settingsPanel.classList.contains('hidden')) {
      apiKeyInput.focus();
    }
  }

  async function saveApiKey() {
    const key = apiKeyInput.value.trim();
    if (!key || key === '••••••••••••••••') {
      showToast('Please enter a valid API key', 'error');
      return;
    }
    apiKey = key;
    await chrome.storage.local.set({ groqApiKey: key });
    apiKeyInput.value = '••••••••••••••••';
    settingsPanel.classList.add('hidden');
    showToast('API key saved!', 'success');

    // If we have fields but haven't started, enable mic
    if (fields.length > 0) {
      micBtn.disabled = false;
    }
  }

  // ─── Form Scanning ───
  async function scanForm() {
    setAiMessage('Scanning your Google Form...');
    setThinking(true);

    try {
      const response = await sendToContentScript({ type: 'SCAN_FORM' });
      
      if (response?.success && response.fields?.length > 0) {
        fields = response.fields;
        formValues = {};
        renderFields();
        updateProgress();

        const fieldNames = fields.map(f => f.label).join(', ');
        const msg = `Found ${fields.length} questions: ${fieldNames}. Click the microphone and start telling me your answers!`;
        setAiMessage(msg);
        speak(msg);

        if (apiKey) {
          micBtn.disabled = false;
        } else {
          setAiMessage(`Found ${fields.length} questions! Please set your Groq API key first (click ⚙️), then start talking.`);
          micBtn.disabled = true;
        }

        showToast(`Found ${fields.length} fields!`, 'success');
      } else {
        setAiMessage("I couldn't find any form fields. Make sure you're on a Google Form with questions visible, then try again.");
        showToast('No fields detected', 'error');
      }
    } catch (err) {
      console.error('[VoiceFill] Scan error:', err);
      setAiMessage("Couldn't connect to the form page. Try refreshing the Google Form and clicking the extension again.");
      showToast('Scan failed', 'error');
    }

    setThinking(false);
  }

  // ─── Render Fields ───
  function renderFields() {
    fieldsList.innerHTML = '';
    fields.forEach(field => {
      const card = document.createElement('div');
      card.className = `field-card${formValues[field.id] ? ' filled' : ''}`;
      card.id = `field-${field.id}`;

      const value = formValues[field.id];
      const typeLabel = field.type === 'radio' ? 'choice' : field.type === 'checkbox' ? 'multi' : field.type;

      card.innerHTML = `
        <div class="field-info">
          <div class="field-label">
            ${field.label}
            <span class="type-badge">${typeLabel}</span>
          </div>
          <div class="field-value${value ? '' : ' empty'}">${value || 'Pending...'}</div>
        </div>
        <div class="field-status ${value ? 'done' : 'pending'}">
          ${value ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        </div>
      `;
      fieldsList.appendChild(card);
    });
  }

  function updateProgress() {
    const filled = fields.filter(f => !!formValues[f.id]).length;
    const total = fields.length;
    const pct = total > 0 ? Math.round((filled / total) * 100) : 0;

    if (total > 0) {
      progressSection.classList.remove('hidden');
      progressLabel.textContent = `${filled} of ${total} fields`;
      progressPercent.textContent = `${pct}%`;
      progressFill.style.width = `${pct}%`;
    }
  }

  // ─── Speech Recognition ───
  function createRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast('Speech recognition not supported', 'error');
      return null;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.maxAlternatives = 3;

    rec.onresult = (event) => {
      let finalText = '';
      let interimText = '';

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          let bestAlt = result[0];
          for (let j = 1; j < result.length; j++) {
            if (result[j].confidence > bestAlt.confidence) bestAlt = result[j];
          }
          finalText += bestAlt.transcript;
        } else {
          interimText += result[0].transcript;
        }
      }

      currentTranscript = (finalText + interimText).trim();
      transcriptText.textContent = currentTranscript || 'Listening... speak now';

      // Reset silence timer
      if (silenceTimeout) clearTimeout(silenceTimeout);
      silenceTimeout = setTimeout(() => {
        if (currentTranscript.trim() && recognition) {
          console.log('[VoiceFill] Auto-stop after silence');
          stopAndProcess();
        }
      }, 3000);
    };

    rec.onend = () => {
      // Only auto-process if we didn't manually stop
      if (isListening && currentTranscript.trim()) {
        processConversation(currentTranscript);
      }
      setListeningUI(false);
    };

    rec.onerror = (event) => {
      console.error('[VoiceFill] Speech error:', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // Mic permission denied — popups can't show Chrome's Allow prompt,
        // so open the persistent grant page (user clicks Allow there).
        setListeningUI(false);
        setAiMessage('Microphone access is blocked. I opened a setup page — click "Grant Microphone Access" there, allow it, then come back here.');
        micWarning.classList.remove('hidden');
        chrome.tabs.create({ url: chrome.runtime.getURL('grant.html'), active: true });
      } else if (event.error !== 'no-speech') {
        setListeningUI(false);
        showToast('Mic error: ' + event.error, 'error');
      }
    };

    return rec;
  }

  function toggleListening() {
    if (isListening) {
      stopAndProcess();
    } else {
      startListening();
    }
  }

  function startListening() {
    if (isProcessing) return;
    
    // Cancel TTS
    speechSynthesis.cancel();

    recognition = createRecognition();
    if (!recognition) return;

    currentTranscript = '';
    transcriptText.textContent = 'Listening... speak now';

    try {
      recognition.start();
      isListening = true;
      setListeningUI(true);
    } catch (err) {
      console.error('[VoiceFill] Start error:', err);
      showToast('Could not start microphone', 'error');
    }
  }

  function stopAndProcess() {
    const transcript = currentTranscript;
    isListening = false;
    
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
    }
    if (silenceTimeout) clearTimeout(silenceTimeout);

    setListeningUI(false);

    if (transcript.trim() && !isProcessing) {
      processConversation(transcript);
    }
  }

  function setListeningUI(active) {
    isListening = active;
    if (active) {
      micBtn.classList.add('recording');
      micIcon.classList.add('hidden');
      micOffIcon.classList.remove('hidden');
      micLabel.textContent = 'Finish Speaking';
      transcriptBox.classList.add('active');
      waveform.classList.remove('hidden');
    } else {
      micBtn.classList.remove('recording');
      micIcon.classList.remove('hidden');
      micOffIcon.classList.add('hidden');
      micLabel.textContent = 'Start Talking';
      transcriptBox.classList.remove('active');
      waveform.classList.add('hidden');
    }
  }

  // ─── AI Conversation ───
  async function processConversation(text) {
    if (!text.trim() || isProcessing) return;

    isProcessing = true;
    micBtn.disabled = true;
    setThinking(true);
    setAiMessage('');

    try {
      const result = await getConversationTurn(text);

      // Update values
      const newValues = { ...formValues, ...result.extracted };
      formValues = newValues;
      renderFields();
      updateProgress();

      // Fill the actual Google Form
      if (Object.keys(result.extracted).length > 0) {
        await sendToContentScript({ 
          type: 'FILL_MULTIPLE', 
          values: result.extracted 
        });
        showToast(`Filled ${Object.keys(result.extracted).length} field(s)`, 'success');
      }

      // Check completion
      const isComplete = fields.length > 0 && fields.every(f => !!newValues[f.id]);

      if (isComplete) {
        setAiMessage("All fields are filled! Review the form and click Submit when you're ready. 🎉");
        speak("All fields are filled! Review the form and submit when ready.");
      } else {
        setAiMessage(result.reply);
        speak(result.reply, () => {
          // Auto-start listening after AI finishes speaking
          setTimeout(() => {
            if (!isProcessing && !isListening) {
              startListening();
            }
          }, 400);
        });
      }
    } catch (err) {
      console.error('[VoiceFill] Process error:', err);
      setAiMessage("Sorry, I had trouble processing that. Please try again.");
      showToast('Processing failed', 'error');
    }

    isProcessing = false;
    micBtn.disabled = false;
    setThinking(false);
  }

  async function getConversationTurn(userInput) {
    if (!apiKey) throw new Error('No API key');

    // Pick a model that actually exists on this account (Groq retires old IDs)
    if (!modelResolved) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (res.ok) {
          const data = await res.json();
          const ids = (data.data || []).map(m => m.id)
            .filter(id => !/guard|whisper|tts|embed|distil/i.test(id));
          TEXT_MODEL = MODEL_PREFS.find(p => ids.includes(p))
            || ids.find(id => /llama|gpt-oss/i.test(id))
            || ids[0]
            || TEXT_MODEL;
        }
        modelResolved = true;
        console.log('[VoiceFill] Using Groq model:', TEXT_MODEL);
      } catch (e) {
        console.log('[VoiceFill] Model resolution failed, using default:', e.message);
        modelResolved = true;
      }
    }

    const fieldList = fields.map(f => {
      let desc = `- ${f.id}: "${f.label}" (type: ${f.type})`;
      if (f.options?.length) desc += ` [options: ${f.options.join(', ')}]`;
      return desc;
    }).join('\n');

    const emptyFields = fields.filter(f => !formValues[f.id]);
    const filledFields = fields.filter(f => !!formValues[f.id]);

    const messages = [
      {
        role: 'system',
        content: `You are "VoiceFill", a friendly and precise form-filling AI assistant having a voice conversation.

CRITICAL RULES:
1. You can ONLY extract data for these specific field IDs: ${fields.map(f => f.id).join(', ')}
2. NEVER invent or ask about fields that are NOT in the list above
3. The "extracted" object must ONLY contain keys from the field ID list above
4. Always confirm what you extracted, then ask for the NEXT empty field
5. Keep replies under 2-3 short sentences for TTS
6. If user says "start" or "hello", greet them and ask for the first empty field
7. For radio/checkbox fields with options, match the user's answer to available options

You MUST respond with ONLY valid JSON in this exact format:
{"extracted": {}, "reply": "your response", "isComplete": false, "clarifications": []}`
      },
      {
        role: 'user',
        content: `FORM FIELDS (you can ONLY use these IDs):
${fieldList}

ALREADY FILLED:
${filledFields.length > 0 ? filledFields.map(f => `- ${f.id}: "${formValues[f.id]}"`).join('\n') : '(none)'}

STILL EMPTY (need to fill):
${emptyFields.length > 0 ? emptyFields.map(f => {
  let desc = `- ${f.id}: "${f.label}"`;
  if (f.options?.length) desc += ` [options: ${f.options.join(', ')}]`;
  return desc;
}).join('\n') : '(all filled!)'}

USER SAID (from speech-to-text, may have errors): "${userInput}"

EXTRACTION GUIDELINES:
- Names: capitalize properly ("john doe" → "John Doe")
- Emails: fix STT errors ("at" → "@", "dot" → ".", "gmail dot com" → "gmail.com")
- Phone numbers: extract digits ("nine eight seven" → "987")
- Dates: convert to proper format ("January 15 2000" → "2000-01-15")
- For radio/checkbox fields: match to one of the available options
- Gender/choice fields: extract the selected option as text

Respond with ONLY valid JSON.`
      }
    ];

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 4096,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      // Model may have been retired since resolution — re-resolve next turn
      if (/model_not_found|does not exist/i.test(errText)) modelResolved = false;
      throw new Error(`API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content || '';
    const parsed = extractJSON(content);

    // Filter extracted to valid field IDs only
    const validIds = new Set(fields.map(f => f.id));
    const cleanExtracted = {};
    if (parsed.extracted && typeof parsed.extracted === 'object') {
      for (const [key, value] of Object.entries(parsed.extracted)) {
        if (validIds.has(key) && value != null && String(value).trim()) {
          cleanExtracted[key] = String(value).trim();
        }
      }
    }

    return {
      extracted: cleanExtracted,
      reply: parsed.reply || "I didn't catch that. Could you say it again?",
      isComplete: parsed.isComplete || false,
      clarifications: parsed.clarifications || []
    };
  }

  function extractJSON(text) {
    try { return JSON.parse(text.trim()); } catch {}
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) { try { return JSON.parse(codeBlock[1].trim()); } catch {} }
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
    throw new Error('Could not parse JSON response');
  }

  // ─── Content Script Communication ───
  function sendToContentScript(message) {
    return new Promise((resolve, reject) => {
      if (!activeTabId) {
        reject(new Error('No active tab'));
        return;
      }
      chrome.tabs.sendMessage(activeTabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  // ─── TTS ───
  function speak(text, onEnd) {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    if (onEnd) utterance.onend = () => onEnd();
    speechSynthesis.speak(utterance);
  }

  // ─── UI Helpers ───
  function setAiMessage(text) {
    aiMessage.textContent = text;
    aiMessage.classList.toggle('hidden', !text);
  }

  function setThinking(active) {
    aiThinking.classList.toggle('hidden', !active);
    aiAvatar.classList.toggle('thinking', active);
    if (active) aiMessage.classList.add('hidden');
  }

  function showToast(message, type = 'info') {
    toastText.textContent = message;
    toast.className = `toast ${type}`;
    // Force reflow
    toast.offsetHeight;
    toast.classList.add('show');
    
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 300);
    }, 2500);
  }

  function resetAll() {
    fields = [];
    formValues = {};
    isListening = false;
    isProcessing = false;
    currentTranscript = '';
    
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
    }
    speechSynthesis.cancel();

    fieldsList.innerHTML = '';
    progressSection.classList.add('hidden');
    setListeningUI(false);
    setAiMessage('Scanning your form...');
    micBtn.disabled = true;
    transcriptText.textContent = 'Your voice will appear here...';

    // Re-scan
    setTimeout(() => scanForm(), 300);
  }

  // ─── Boot ───
  document.addEventListener('DOMContentLoaded', init);
  // Re-check mic permission when returning from the grant page tab
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && micWarning) checkMicPermission();
  });
})();
