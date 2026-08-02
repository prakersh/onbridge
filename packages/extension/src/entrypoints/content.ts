import { defineContentScript } from 'wxt/utils/define-content-script';
import { CommandExecutor } from '../core/command-executor.js';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  // Without this the script only runs in the top frame, so everything inside an
  // iframe — embedded checkouts, editors, auth widgets — was invisible and
  // unreachable. Each frame gets its own instance and its own ref space; the
  // background namespaces them.
  allFrames: true,

  main() {
    const executor = new CommandExecutor();

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'command') return false;

      const { id, action, params } = message;

      const start = performance.now();
      executor
        .execute(action, params ?? {})
        .then((data) => {
          sendResponse({
            type: 'result',
            id,
            success: true,
            data,
            timing: Math.round(performance.now() - start),
          });
        })
        .catch((err: Error) => {
          sendResponse({
            type: 'result',
            id,
            success: false,
            data: null,
            error: err.message,
            timing: Math.round(performance.now() - start),
          });
        });

      return true;
    });
  },
});
