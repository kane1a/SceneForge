import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/noto-serif-tc/500.css';
import '@fontsource/noto-serif-tc/600.css';
import './styles.css';
import App from './App';
import './ui-system.css';
import './overrides.css';

// 點在標籤文字或欄位上方的空白處，不要把游標送進輸入框；只有直接點輸入框才開始輸入。
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const label = target?.closest('label');
  if (!label || !target) return;
  if (target.closest('input, textarea, select, button, [contenteditable="true"], a, [role="combobox"], [role="switch"]')) return;
  event.preventDefault();
}, true);

const root = document.getElementById('root');
if (!root) throw new Error('SceneForge root element was not found.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
