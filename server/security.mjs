import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "manifest-src 'self'",
].join('; ');

export const API_COOKIE = 'sceneforge_api_token';
export const createApiToken = () => randomBytes(32).toString('base64url');

export function isAllowedHost(host, port) {
  if (typeof host !== 'string' || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return false;
  const normalized = host.toLowerCase();
  return normalized === `127.0.0.1:${Number(port)}` || normalized === `localhost:${Number(port)}`;
}

export function tokenFromRequest(req) {
  const authorization = req?.headers?.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
    if (match) return match[1];
  }
  const cookie = req?.headers?.cookie;
  if (typeof cookie !== 'string') return '';
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== API_COOKIE) continue;
    return part.slice(separator + 1).trim();
  }
  return '';
}

export function hasValidApiToken(req, expected) {
  if (typeof expected !== 'string' || expected.length < 32) return false;
  const received = tokenFromRequest(req);
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function routeTemplate(pathname) {
  const segments = String(pathname ?? '').split('/').filter(Boolean);
  if (segments[0] !== 'api') return '/static/:path';
  if (segments.length === 1) return '/api';
  const resource = segments[1];
  if (resource === 'projects') {
    if (segments.length === 2) return '/api/projects';
    if (segments.length === 3) return '/api/projects/:id';
    if (segments[3] === 'file') return '/api/projects/:id/file';
    if (segments[3] === 'snapshots' && segments.length === 4) return '/api/projects/:id/snapshots';
    if (segments[3] === 'snapshots' && segments[5] === 'restore') return '/api/projects/:id/snapshots/:snapshotId/restore';
    if (segments[3] === 'snapshots' && segments[5] === 'prune') return '/api/projects/:id/snapshots/prune';
    if (segments[3] === 'snapshots') return '/api/projects/:id/snapshots/:snapshotId';
    return '/api/projects/:id/:resource';
  }
  if (resource === 'library') {
    if (segments.length <= 2) return '/api/library';
    if (segments[3] === 'search') return '/api/library/:id/search';
    if (segments[3] === 'file') return '/api/library/:id/file';
    return '/api/library/:id';
  }
  if (resource === 'backups') return segments.length <= 2 ? '/api/backups' : '/api/backups/:name';
  if (resource === 'trash') {
    if (segments.length <= 2) return '/api/trash';
    if (segments[2] === 'items') return segments[4] === 'restore' ? '/api/trash/items/:id/restore' : '/api/trash/items/:id';
    return segments[3] === 'restore' ? '/api/trash/:id/restore' : '/api/trash/:id';
  }
  if (resource === 'fonts') return segments.length <= 2 ? '/api/fonts' : '/api/fonts/:id/file';
  if (['health', 'storage', 'render', 'import-memory'].includes(resource)) return `/api/${resource}`;
  return '/api/:route';
}
