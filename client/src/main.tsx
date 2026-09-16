import './lib/zod-runtime';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { consumeSetupTokenFromLocation } from './lib/setup-location';
import { startThemeSync } from './lib/theme-preference';
import { ensureBootNamespaces, startLocaleSync } from './i18n';
// Load primitives after tokens and screen CSS so they win at equal
// specificity. Screen rules must not override shared primitive styling
// when both apply to the same element.
import './styles.css';
import './primitives.css';
import './shell.css';
// Screen styles that use shared tokens live in separate stylesheets.
import './screens/dashboard.css';
import './screens/content-list.css';
import './screens/content-editor.css';
import './screens/content-dialogs.css';
import './screens/comments.css';
import './screens/newsletters.css';
import './screens/forms.css';
import './screens/settings.css';
import './screens/media.css';
import './screens/structure.css';
import './screens/navigation.css';
import './screens/preview-data.css';
import './screens/wxr.css';
import './screens/users.css';
import './screens/account-security.css';
import './screens/auth.css';
import './screens/auth-setup.css';
import './screens/operations.css';

// Use one theme throughout the app, including pre-authentication screens.
// When `system` is selected, follow OS changes immediately. The inline script
// in index.html has already handled first paint.
startThemeSync();
startLocaleSync();

const root = document.getElementById('root');
if (!root) throw new Error('ZeroPress Studio root element is missing.');
// Remove the setup token from the URL before the await below, so it does not
// remain visible in the browser's address bar while initialization runs.
const setupToken = window.location.pathname === '/activate'
  ? consumeSetupTokenFromLocation()
  : '';

// Render after messages for the initial screen are ready. The fallback locale
// is bundled and needs no network request. For other locales, retain the
// background set by index.html's pre-paint script while loading the boot
// catalog, avoiding an initial frame in the wrong language.
await ensureBootNamespaces();

createRoot(root).render(
  <StrictMode>
    <App setupToken={setupToken} />
  </StrictMode>,
);
