/**
 * VoiceFill AI - Popup Script
 * Handles voice recognition, AI conversation, and communication with content script.
 */

(() => {
  'use strict';

  // ─── Config ───
  const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
  const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
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
  // Groq Whisper STT models (fallback chain)
  let sttModel = 'whisper-large-v3-turbo';

  // ─── State ───
  let apiKey = '';        // Groq key (Whisper STT + fallback brain)
  let geminiKey = '';     // Gemini key (agent brain)
  let geminiModel = null; // resolved Gemini model
  let sttMode = 'whisper';// 'whisper' (Groq STT) | 'webspeech' (Chrome built-in)
  let agentHistory = [];  // Gemini agent conversation memory
  let mediaStream = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingTimer = null;
  let recordingStartedAt = 0;
  let isWhisperSession = false;
  let fields = [];
  let formValues = {};
  let isListening = false;
  let isProcessing = false;
  let recognition = null;
  let currentTranscript = '';
  let silenceTimeout = null;
  let activeTabId = null;
  let grantPageOpened = false; // open the grant page at most once per popup session (prevents loop)

  // ─── DOM Elements ───
  const $ = (sel) => document.querySelector(sel);
  const settingsBtn = $('#settingsBtn');
  const resetBtn = $('#resetBtn');
  const settingsPanel = $('#settingsPanel');
  const geminiKeyInput = $('#geminiKeyInput');
  const groqKeyInput = $('#groqKeyInput');
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
    // Load API keys
    const stored = await chrome.storage.local.get(['groqApiKey', 'geminiApiKey', 'sttMode']);
    if (stored.groqApiKey) {
      apiKey = stored.groqApiKey;
      groqKeyInput.value = '••••••••••••••••';
    }
    if (stored.geminiApiKey) {
      geminiKey = stored.geminiApiKey;
      geminiKeyInput.value = '••••••••••••••••';
    }
    sttMode = stored.sttMode === 'webspeech' ? 'webspeech' : 'whisper';

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
      (geminiKeyInput.value ? groqKeyInput : geminiKeyInput).focus();
    }
  }

  async function saveApiKey() {
    const MASK = '••••••••••••••••';
    const geminiVal = geminiKeyInput.value.trim();
    const groqVal = groqKeyInput.value.trim();
    const updates = {};

    if (geminiVal && geminiVal !== MASK) {
      geminiKey = geminiVal;
      updates.geminiApiKey = geminiVal;
      geminiKeyInput.value = MASK;
      geminiModel = null; // re-resolve model for the new key
    }
    if (groqVal && groqVal !== MASK) {
      apiKey = groqVal;
      updates.groqApiKey = groqVal;
      groqKeyInput.value = MASK;
    }
    if (!geminiKey && !apiKey) {
      showToast('Please enter at least one API key', 'error');
      return;
    }
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    settingsPanel.classList.add('hidden');

    // If we have fields but haven't started, enable mic
    if (fields.length > 0) {
      micBtn.disabled = false;
      const brain = geminiKey ? 'Gemini agent' : 'Groq';
      showToast(`Keys saved — ${brain} mode`, 'success');
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
        const msg = fields.length > 1
          ? `Hi there! I found ${fields.length} questions — ${fieldNames}. Just hit the mic and tell me your answers like you're talking to a friend. I'll fill everything in and check details with you as we go!`
          : `Hi! I found one question: ${fieldNames}. Hit the mic and tell me your answer!`;
        setAiMessage(msg);
        speak(msg);

        if (apiKey || geminiKey) {
          micBtn.disabled = false;
        } else {
          setAiMessage(`Found ${fields.length} questions! Please set an API key first (click ⚙️ — Gemini for the agent, Groq for Whisper hearing), then start talking.`);
          micBtn.disabled = true;
        }
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
  // Two engines:
  //   'whisper'   — record with MediaRecorder → Groq Whisper API (accurate)
  //   'webspeech' — Chrome built-in SpeechRecognition (fallback, instant)
  function createRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setAiMessage('Speech recognition is not supported in this browser. Please use Google Chrome.');
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
        routeToBrain(currentTranscript);
      }
      setListeningUI(false);
    };

    rec.onerror = (event) => {
      console.error('[VoiceFill] Speech error:', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // Mic permission denied — popups can't show Chrome's Allow prompt.
        // Open the persistent grant page ONCE; after that, show instructions
        // instead of looping.
        setListeningUI(false);
        micWarning.classList.remove('hidden');
        if (!grantPageOpened) {
          grantPageOpened = true;
          setAiMessage('Microphone access is blocked. I opened a setup page — click "Grant Microphone Access" there, allow it, then come back here.');
          chrome.tabs.create({ url: chrome.runtime.getURL('grant.html'), active: true });
        } else {
          setAiMessage('Chrome is still blocking the mic inside the popup. Click the yellow banner to open the setup page. If it keeps failing, reload the extension in chrome://extensions so the new "Record audio" permission is applied.');
          showToast('Mic still blocked — see the yellow banner', 'error');
        }
      } else if (event.error === 'no-speech') {
        setListeningUI(false);
        setAiMessage("I didn't hear anything — click the mic again and speak when you're ready.");
      } else {
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

  async function startListening() {
    if (isProcessing) return;

    // Cancel TTS
    speechSynthesis.cancel();

    currentTranscript = '';
    transcriptText.textContent = 'Listening... speak now';

    // Whisper mode: record real audio, transcribe via Groq
    if (sttMode === 'whisper' && apiKey) {
      try {
        await startWhisperRecording();
        isListening = true;
        setListeningUI(true);
        return;
      } catch (err) {
        console.error('[VoiceFill] Whisper recording failed, falling back to WebSpeech:', err);
        if (String(err).includes('NotAllowedError') || String(err).includes('not allowed') || String(err).includes('Permission')) {
          handleMicDenied();
          return;
        }
        // fall through to webspeech
      }
    }

    // WebSpeech mode (fallback)
    recognition = createRecognition();
    if (!recognition) return;

    try {
      recognition.start();
      isListening = true;
      setListeningUI(true);
    } catch (err) {
      console.error('[VoiceFill] Start error:', err);
      setAiMessage('Could not start the microphone. Try again, or click the yellow banner if the issue persists.');
    }
  }

  // ─── Whisper STT recording ───
  async function startWhisperRecording() {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream);
    audioChunks = [];
    recordingStartedAt = Date.now();

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => { /* handled after transcription */ };
    mediaRecorder.start(250); // gather chunks every 250ms

    startSilenceDetection(mediaStream);

    // Hard cap at 60s to protect the free tier
    recordingTimer = setTimeout(() => {
      if (isListening) { console.log('[VoiceFill] 60s max recording reached'); stopAndProcess(); }
    }, 60000);
  }

  // ─── Silence detection: auto-finish "Finish Talking" when the user goes quiet ───
  let audioCtx = null;
  let analyserNode = null;
  let silencePoll = null;
  let speechDetected = false;
  let silenceSince = 0;

  function startSilenceDetection(stream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const source = audioCtx.createMediaStreamSource(stream);
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 512;
      source.connect(analyserNode);

      const buf = new Uint8Array(analyserNode.fftSize);
      const RMS_THRESHOLD = 8;      // below this = silence
      const SILENCE_STOP_MS = 2500; // silence after speech -> auto-stop & process
      const NO_SPEECH_MS = 7000;    // no speech at all -> cancel quietly
      const GRACE_MS = 500;         // ignore mic ramp-up noise

      speechDetected = false;
      silenceSince = Date.now();
      const startedAt = Date.now();

      silencePoll = setInterval(() => {
        if (!analyserNode || !isListening) return;
        analyserNode.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = buf[i] - 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        if (rms > RMS_THRESHOLD) {
          speechDetected = true;
          silenceSince = now;
        }
        if (now - startedAt < GRACE_MS) return;
        const silentFor = now - silenceSince;
        if (speechDetected && silentFor > SILENCE_STOP_MS) {
          console.log('[VoiceFill] Silence detected after speech — finishing turn automatically');
          stopAndProcess();
        } else if (!speechDetected && now - startedAt > NO_SPEECH_MS) {
          console.log('[VoiceFill] No speech detected — cancelling recording');
          cancelWhisperRecording();
        }
      }, 250);
    } catch (e) {
      // Analyser unavailable (e.g. mocked stream) — timer-only recording, still works
      console.log('[VoiceFill] Silence detection unavailable:', e.message);
    }
  }

  function stopSilenceDetection() {
    if (silencePoll) { clearInterval(silencePoll); silencePoll = null; }
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
    analyserNode = null;
  }

  async function cancelWhisperRecording() {
    if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }
    stopSilenceDetection();
    const stream = mediaStream;
    await new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') return resolve();
      mediaRecorder.onstop = () => resolve();
      try { mediaRecorder.stop(); } catch { resolve(); }
    });
    if (stream) { stream.getTracks().forEach(t => t.stop()); }
    mediaStream = null;
    mediaRecorder = null;
    audioChunks = [];
    isListening = false;
    setListeningUI(false);
    setAiMessage("I didn't hear anything — click the mic again and speak when you're ready.");
  }

  async function stopWhisperRecording() {
    if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }
    stopSilenceDetection();
    const elapsed = Date.now() - recordingStartedAt;
    const chunks = audioChunks;
    const mimeType = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
    const stream = mediaStream;

    const stopped = new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') return resolve();
      mediaRecorder.onstop = () => resolve();
      try { mediaRecorder.stop(); } catch { resolve(); }
    });
    await stopped;

    if (stream) { stream.getTracks().forEach(t => t.stop()); }
    mediaStream = null;
    mediaRecorder = null;
    audioChunks = [];

    // Discard micro-recordings (accidental click / instant stop of an
    // auto-restarted session) — avoids wasting free-tier Whisper calls.
    if (elapsed < 600 || !chunks.length) return '';
    return transcribeWithGroq(new Blob(chunks, { type: mimeType }));
  }

  async function transcribeWithGroq(audioBlob) {
    if (!apiKey) throw new Error('No Groq key for Whisper');
    const form = new FormData();
    // Whisper requires a filename with a known extension; webm is accepted by Groq
    form.append('file', audioBlob, 'recording.webm');
    form.append('model', sttModel);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('language', 'en');

    const res = await fetch(GROQ_STT_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text();
      // Retired STT model — try the standard whisper once
      if (/model.*not.*found/i.test(errText) && sttModel !== 'whisper-large-v3') {
        sttModel = 'whisper-large-v3';
        return transcribeWithGroq(audioBlob);
      }
      throw new Error(`Whisper API error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    return (data.text || '').trim();
  }

  function stopAndProcess() {
    const wasListening = isListening;
    isListening = false;

    if (silenceTimeout) clearTimeout(silenceTimeout);

    setListeningUI(false);

    if (sttMode === 'whisper' && mediaRecorder) {
      // Whisper path: stop recording, transcribe, then process
      const recording = stopWhisperRecording();
      if (!wasListening) return;
      recording.then(transcript => {
        if (transcript && transcript.trim()) {
          transcriptText.textContent = transcript;
          routeToBrain(transcript);
        } else {
          console.log('[VoiceFill] Whisper returned empty transcript');
          setAiMessage("I didn't catch any words there — click the mic and try speaking a bit closer.");
        }
      }).catch(err => {
        console.error('[VoiceFill] Transcription error:', err);
        setAiMessage('Sorry, I could not transcribe that audio. Try speaking a bit longer.');
      });
      return;
    }

    // WebSpeech path
    const transcript = currentTranscript;
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
    }

    if (transcript.trim() && !isProcessing) {
      routeToBrain(transcript);
    }
  }

  function handleMicDenied() {
    setListeningUI(false);
    micWarning.classList.remove('hidden');
    if (!grantPageOpened) {
      grantPageOpened = true;
      setAiMessage('Microphone access is blocked. I opened a setup page — click "Grant Microphone Access" there, allow it, then come back here.');
      chrome.tabs.create({ url: chrome.runtime.getURL('grant.html'), active: true });
    } else {
      setAiMessage('Chrome is still blocking the mic inside the popup. Click the yellow banner to open the setup page. If it keeps failing, reload the extension in chrome://extensions so the new "Record audio" permission is applied.');
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
    if (!apiKey) {
      setAiMessage('Please set your Groq API key first (click ⚙️) — it powers Whisper hearing and the fallback brain.');
      return;
    }

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
        content: `You are "VoiceFill", a warm, human-sounding voice agent helping fill a form over a phone-like conversation.

SPEAK LIKE A HUMAN:
- Contractions, friendly tone, 1-2 short sentences. Sound like a helpful person, not a computer.

ACCURACY FIRST:
- Only put values in "extracted" when you are CONFIDENT what the user said.
- If the speech is garbled, ambiguous, or unsure (unclear spelling, mumbled email, vague choice), leave "extracted" EMPTY and use "reply" to ask ONE short natural clarifying question ("Sorry, was that Jon or John?").
- For radio/checkbox fields with options, match the user's answer to the EXACT available options.

HARD RULES:
1. You can ONLY extract data for these specific field IDs: ${fields.map(f => f.id).join(', ')}
2. NEVER invent or ask about fields that are NOT in the list above
3. The "extracted" object must ONLY contain keys from the field ID list above
4. When you fill something, confirm what you saved in "reply", then ask for the NEXT empty field
5. If user says "start" or "hello", greet them and ask for the first empty field

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

  // ─── Brain routing ───
  function routeToBrain(text) {
    if (geminiKey) return runAgentTurn(text);
    return processConversation(text);
  }

  async function runAgentTurn(text) {
    if (!text.trim() || isProcessing) return;

    isProcessing = true;
    micBtn.disabled = true;
    setThinking(true);
    setAiMessage('');

    try {
      const reply = await runGeminiAgent(text);

      const isComplete = fields.length > 0 && fields.every(f => !!formValues[f.id]);
      if (isComplete) {
        setAiMessage("All fields are filled! Review the form and click Submit when you're ready. 🎉");
        speak("All fields are filled! Review the form and submit when ready.");
      } else {
        setAiMessage(reply);
        speak(reply, () => {
          setTimeout(() => {
            if (!isProcessing && !isListening) startListening();
          }, 400);
        });
      }
    } catch (err) {
      console.error('[VoiceFill] Agent error:', err);
      setAiMessage("Sorry, I had trouble processing that. Please try again.");
    }

    isProcessing = false;
    micBtn.disabled = false;
    setThinking(false);
  }

  // ─── Gemini Agent (function-calling) ───
  const GEMINI_SYSTEM_PROMPT = `You are "VoiceFill", a warm, human-sounding voice agent that fills Google Forms by having a natural conversation.

SPEAK LIKE A HUMAN:
- Use contractions and a friendly, casual tone. Sound like a helpful person on the phone, not a robot.
- Keep replies to 1-2 short sentences — they are spoken aloud. Small natural phrases ("Sure thing", "Got it", "Oh, one more thing") are welcome.

ACCURACY & CLARIFICATION (most important):
1. Only call fill_fields when you are CONFIDENT about what the user said.
2. If the speech is garbled, ambiguous, or you are unsure (unclear name spelling, mumbled email, vague choice), DO NOT fill anything. Ask ONE short, natural clarifying question instead — e.g. "Sorry, quick check — was that Jon, J-O-N, or John, J-O-H-N?"
3. For names and emails, repeat back what you saved while filling ("I've got john@docs.com — just say 'change my email' if that's wrong.").
4. If the user corrects a value you already filled, call fill_fields again with the same field ID and the corrected value.

FORM RULES:
5. Match radio/checkbox answers to the EXACT options provided. For checkboxes with multiple selections, join values with a comma.
6. Clean up speech-to-text errors: emails ("john at gmail dot com" -> john@gmail.com), phone digits ("nine eight seven" -> 987), dates ("January 15 2000" -> 2000-01-15). Capitalize names ("john doe" -> "John Doe").
7. After each fill, briefly confirm what you saved, then ask for the NEXT missing field — one question at a time.
8. When every field is filled, congratulate the user and tell them to review the form and click Submit.
9. Never invent data or field IDs. If you lose track, use get_progress. Use scan_form only if the field list seems wrong.`;

  const GEMINI_TOOLS = [{
    functionDeclarations: [
      {
        name: 'fill_fields',
        description: 'Fill one or more form fields with values. Only use field IDs from the provided field list.',
        parameters: {
          type: 'OBJECT',
          properties: {
            values: { type: 'OBJECT', description: 'Map of fieldId to the value to fill, e.g. {"field_1_name": "John Doe"}' },
          },
          required: ['values'],
        },
      },
      {
        name: 'get_progress',
        description: 'Get how many fields are filled and which are still missing.',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
      {
        name: 'scan_form',
        description: 'Rescan the Google Form and return all question fields.',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
    ],
  }];

  function buildFormStateText() {
    return fields.map(f => {
      let line = `- ${f.id}: "${f.label}" (type: ${f.type})`;
      if (f.options?.length) line += ` [options: ${f.options.join(', ')}]`;
      line += formValues[f.id] ? ` [FILLED: "${formValues[f.id]}"]` : ' [EMPTY]';
      return line;
    }).join('\n') || '(no fields scanned yet)';
  }

  async function resolveGeminiModel() {
    if (geminiModel) return geminiModel;
    const res = await fetch(`${GEMINI_API_BASE}/models?key=${encodeURIComponent(geminiKey)}`);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Gemini key error ${res.status}: ${t.slice(0, 120)}`);
    }
    const data = await res.json();
    const usable = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => !/tts|image|audio|embedding|aqa|video|live|native|veo|imagen|learnlm|gemma|guard/i.test(n));
    const prefs = [
      /^gemini-3\.5-flash-lite/, /^gemini-[\d.]+-flash-lite/, /^gemini-[\d.]+-flash$/,
      /^gemini-.*flash/, /^gemini-/,
    ];
    for (const p of prefs) {
      const hit = usable.find(n => p.test(n));
      if (hit) { geminiModel = hit; break; }
    }
    if (!geminiModel) throw new Error('No usable Gemini model on this key');
    console.log('[VoiceFill] Using Gemini model:', geminiModel);
    return geminiModel;
  }

  async function executeGeminiTool(name, args) {
    if (name === 'fill_fields') {
      const values = args.values || {};
      const resp = await sendToContentScript({ type: 'FILL_MULTIPLE', values });
      formValues = { ...formValues, ...values };
      renderFields();
      updateProgress();
      return resp || { success: false };
    }
    if (name === 'get_progress') {
      const filled = fields.filter(f => !!formValues[f.id]).length;
      return {
        filled,
        total: fields.length,
        missing: fields.filter(f => !formValues[f.id]).map(f => f.label),
      };
    }
    if (name === 'scan_form') {
      const resp = await sendToContentScript({ type: 'SCAN_FORM' });
      if (resp?.success) {
        fields = resp.fields;
        renderFields();
        updateProgress();
      }
      return { success: true, fields };
    }
    return { error: `Unknown tool: ${name}` };
  }

  async function runGeminiAgent(userText) {
    const model = await resolveGeminiModel();

    if (agentHistory.length === 0) {
      agentHistory.push({
        role: 'user',
        parts: [{ text: `FORM FIELDS (the only IDs you may fill):\n${buildFormStateText()}\n\nConversation start. Greet briefly and ask for the first empty field.` }],
      });
    }
    agentHistory.push({ role: 'user', parts: [{ text: `User said: "${userText}"` }] });

    let reply = '';
    for (let step = 0; step < 5; step++) {
      const res = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
          contents: agentHistory,
          tools: GEMINI_TOOLS,
          generationConfig: { temperature: 0.2 },
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        if (/model.*not.*found|not found/i.test(errText)) geminiModel = null; // re-resolve next turn
        throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 140)}`);
      }
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);
      const textOut = parts.filter(p => p.text).map(p => p.text).join('');

      if (calls.length > 0) {
        agentHistory.push({ role: 'model', parts });
        const responseParts = [];
        for (const call of calls) {
          let result;
          try {
            result = await executeGeminiTool(call.name, call.args || {});
          } catch (e) {
            result = { error: String(e.message || e) };
          }
          responseParts.push({ functionResponse: { name: call.name, response: { result } } });
        }
        agentHistory.push({ role: 'user', parts: responseParts });
        continue; // let the model react to the tool results
      }

      reply = textOut || "I didn't catch that. Could you say it again?";
      agentHistory.push({ role: 'model', parts });
      break;
    }

    // Trim memory (keep the last ~12 exchanges)
    while (agentHistory.length > 24) agentHistory.shift();
    return reply || "I didn't catch that. Could you say it again?";
  }

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
    agentHistory = [];

    if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }
    stopSilenceDetection();
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    mediaRecorder = null;
    audioChunks = [];
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
