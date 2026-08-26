// SessionStart — the board, delivered twice over: the full list as additional context for the
// MODEL, and one visible line for the USER. The rendering itself lives in src/board-render.mjs,
// shared with the launcher (which prints the same board into scrollback before the TUI starts).

import { failSoft, emitSessionStart } from './lib.mjs';
import { renderBoard } from '../../src/board-render.mjs';

await failSoft(async ({ substrate, workspace, identity, config }) => {
  const { context, message } = await renderBoard({ client: substrate, identity, workspace, config });
  emitSessionStart({ context, message });
}, { quietNote: 'Oathe board unavailable — substrate not initialized; run `oathe init`' });
