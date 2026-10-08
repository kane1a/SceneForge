// Fonts shipped with SceneForge. Kept apart from the print engine so listing them is instant.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLED_FONTS = {
  'courier-prime': { label: 'Courier Prime', css: 'Courier Prime', script: 'latin', regular: path.join(ROOT, 'fonts', 'CourierPrime-Regular.woff'), bold: path.join(ROOT, 'fonts', 'CourierPrime-Bold.woff') },
  // The desktop build ships only dist/, where Vite copies public/fonts.
  'noto-mono-cjk': { label: 'Noto Sans Mono CJK TC', css: 'Noto Sans Mono CJK TC', script: 'cjk', regular: [path.join(ROOT, 'public', 'fonts', 'NotoSansMonoCJKtc-Regular.otf'), path.join(ROOT, 'dist', 'fonts', 'NotoSansMonoCJKtc-Regular.otf')].find((file) => existsSync(file)) },
};
