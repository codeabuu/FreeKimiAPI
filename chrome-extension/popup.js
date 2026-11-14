// Kimi Auth Exporter — Popup

const out = document.getElementById('out');
const refresh = document.getElementById('refresh');
const download = document.getElementById('download');

function summary(auth) {
  if (!auth) return 'No credentials captured yet.';
  const token = auth.token ? `${auth.token.length} chars` : 'MISSING';
  const shield = auth.shield ? 'OK' : 'none';
  const refreshToken = auth.refreshToken ? 'OK' : 'none';
  const lines = [
    `token      ${token}`,
    `refresh    ${refreshToken}`,
    `shield     ${shield}`,
    `cookie     ${auth.cookie ? 'present' : 'MISSING'}`,
    `deviceId   ${auth.deviceId || '(generated later)'}`,
    `sessionId  ${auth.sessionId || '(generated later)'}`,
    `trafficId  ${auth.trafficId || '(generated later)'}`,
  ];
  if (auth.tokenExpiresAt) {
    lines.push(`expires    ${new Date(auth.tokenExpiresAt * 1000).toLocaleString()}`);
  }
  return lines.join('\n');
}

function show(response) {
  if (!response || !response.ok) {
    out.innerHTML = `<span class="bad">${(response && response.error) || 'Failed'}</span>`;
    return;
  }
  out.textContent = summary(response.auth);
}

refresh.addEventListener('click', () => {
  out.textContent = 'Reading cookies, storage and the Chat request…';
  chrome.runtime.sendMessage({ action: 'refresh' }, show);
});
download.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'download' }, show);
});

chrome.runtime.sendMessage({ action: 'get' }, show);
