// Kimi Auth Exporter — Content Script
// Runs on kimi.ai to read localStorage/sessionStorage values on request.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'readStorage') return;
  const read = (store) => {
    const out = {};
    for (const key of request.keys) {
      try { out[key] = store.getItem(key) || ''; } catch (e) { out[key] = ''; }
    }
    return out;
  };
  const data = {};
  for (const key of request.keys) {
    try { data[key] = localStorage.getItem(key) || sessionStorage.getItem(key) || ''; } catch (e) { data[key] = ''; }
  }
  sendResponse({ data });
});
