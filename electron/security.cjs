const allowedExternalProtocols = new Set(['https:', 'http:']);

function isAllowedNavigation(rawUrl, expectedOrigin, splashUrl = '') {
  if (typeof rawUrl !== 'string') return false;
  if (splashUrl && rawUrl === splashUrl) return true;
  try {
    return new URL(rawUrl).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function safeExternalUrl(rawUrl, protocols = allowedExternalProtocols) {
  if (typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    if (!protocols.has(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function getIpcSenderRejectionReason(event, webContents, expectedOrigin) {
  if (event?.sender !== webContents) return 'sender-mismatch';
  const frame = event?.senderFrame;
  if (!frame) return 'frame-missing';
  // Electron's WebFrameMain exposes `parent`, not `isMainFrame`.
  if (frame.parent !== null) return 'subframe';
  let trustedOrigin;
  try { trustedOrigin = new URL(expectedOrigin).origin; } catch { return 'origin-unavailable'; }
  if (!trustedOrigin || trustedOrigin === 'null') return 'origin-unavailable';
  let frameOrigin;
  try { frameOrigin = new URL(frame.url).origin; } catch { return 'frame-url-invalid'; }
  return frameOrigin === trustedOrigin ? null : 'origin-mismatch';
}

function isTrustedIpcSender(event, webContents, expectedOrigin) {
  return getIpcSenderRejectionReason(event, webContents, expectedOrigin) === null;
}

function runTrustedIpcOn(event, webContents, expectedOrigin, callback) {
  if (!isTrustedIpcSender(event, webContents, expectedOrigin)) return false;
  callback();
  return true;
}

module.exports = { isAllowedNavigation, safeExternalUrl, isTrustedIpcSender, getIpcSenderRejectionReason, runTrustedIpcOn };
