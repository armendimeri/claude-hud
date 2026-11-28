// Private, on-demand conversation history (operator-cockpit P4). Nothing here runs at startup or in the background:
// the live tailer and the public publisher never import this directory.
export { createHistoryReader, LIMITS } from './reader.mjs';
export { createHistoryService, openHistorySource, sourceGeneration } from './source.mjs';
export { HistoryError } from './errors.mjs';
