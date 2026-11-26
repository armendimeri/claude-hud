import { activity } from './views/activity.mjs';
import { cards } from './views/cards.mjs';
import { network } from './views/network.mjs';

export const viewRegistry = new Map([cards, network, activity].map(view => [view.key, view]));
