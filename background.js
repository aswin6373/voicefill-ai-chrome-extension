/**
 * VoiceFill AI - Background Service Worker
 * Manages extension lifecycle and badge state.
 */

// Update badge when navigating to Google Forms
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    if (tab.url.includes('docs.google.com/forms')) {
      chrome.action.setBadgeText({ tabId, text: '✓' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b82f6' });
    } else {
      chrome.action.setBadgeText({ tabId, text: '' });
    }
  }
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      const isGoogleForm = tab?.url?.includes('docs.google.com/forms') || false;
      sendResponse({ isGoogleForm, tabId: tab?.id });
    });
    return true;
  }
});

console.log('[VoiceFill] Background service worker started');
