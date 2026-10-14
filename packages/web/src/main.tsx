import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './design/tokens.css';
import './ui/ui.css';
import './app/app.css';
import './app/settings/settings.css';
import './app/calendar.css';
import './app/focus.css';
import './app/matrix.css';
import { restoreCachedTheme } from './app/theme.js';

restoreCachedTheme();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing in index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
