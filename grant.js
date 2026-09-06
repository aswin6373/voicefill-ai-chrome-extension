/**
 * VoiceFill AI - Microphone Permission Grant Page
 * Extension popups close before Chrome's mic prompt can be clicked,
 * so permission is granted here (a persistent tab) instead — same origin,
 * so the popup inherits it permanently.
 */

(() => {
  'use strict';

  const iconWrap = document.getElementById('iconWrap');
  const micSvg = document.getElementById('micSvg');
  const checkSvg = document.getElementById('checkSvg');
  const title = document.getElementById('title');
  const desc = document.getElementById('desc');
  const grantBtn = document.getElementById('grantBtn');
  const returnBtn = document.getElementById('returnBtn');
  const status = document.getElementById('status');
  const steps = document.getElementById('steps');

  function showStatus(text, type = 'info') {
    status.textContent = text;
    status.className = `status show ${type}`;
  }

  function setSuccess() {
    iconWrap.classList.add('success');
    micSvg.classList.add('hidden');
    checkSvg.classList.remove('hidden');
    title.textContent = "You're all set!";
    desc.textContent = 'Microphone access granted. VoiceFill can now hear your answers.';
    grantBtn.classList.add('hidden');
    returnBtn.classList.remove('hidden');
    steps.classList.add('hidden');
    showStatus('If the popup still can\'t hear you, reload the extension once in chrome://extensions — Chrome needs to apply the "Record audio" permission.', 'info');
  }

  async function isGranted() {
    try {
      const st = await navigator.permissions.query({ name: 'microphone' });
      if (st.state === 'granted') return true;
    } catch (e) { /* permissions API not available for this name */ }
    return false;
  }

  async function requestMic() {
    grantBtn.disabled = true;
    showStatus('Waiting for the Chrome permission prompt…', 'info');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      try { await chrome.storage.local.set({ micGranted: true }); } catch (e) {}
      setSuccess();
    } catch (err) {
      iconWrap.classList.add('error');
      title.textContent = 'Microphone is still blocked';
      showStatus(`Chrome said: "${err.name}". ` +
        'Fix: click the 🎙️/tune icon left of the address bar → Site settings → Microphone → Allow, then reload this page. ' +
        'Also check macOS System Settings → Privacy & Security → Microphone → Chrome is ON.', 'error');
      grantBtn.disabled = false;
      grantBtn.textContent = 'Try Again';
    }
  }

  returnBtn.addEventListener('click', () => {
    chrome.tabs.query({ url: 'https://docs.google.com/forms/*' }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.update(tabs[0].id, { active: true });
        window.close();
      } else {
        window.close();
      }
    });
  });

  grantBtn.addEventListener('click', requestMic);

  // Already granted? Skip straight to success.
  isGranted().then(granted => {
    if (granted) {
      try { chrome.storage.local.set({ micGranted: true }); } catch (e) {}
      setSuccess();
    }
  });
})();
