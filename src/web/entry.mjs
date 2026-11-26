import { mountHudPage } from './components/page.mjs';
import { createHudStore } from './data/store.mjs';
import { createBrowserTransport } from './data/transport.mjs';

const transport = createBrowserTransport();
mountHudPage(document.body, { transport, store: createHudStore({ transport }) });
