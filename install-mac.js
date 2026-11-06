#!/usr/bin/env node
'use strict';
/**
 * ENJOY Signage for macOS: installs or updates it. Run once from this folder in Terminal:
 *
 *     node install-mac.js
 *
 * Options:  --port 8080            use another web port (default 3000)
 *           --import ~/old/church-signage   bring in content from an older copy
 *           --replace-content      with --import, replace content that's already installed
 *           --allow-sleep          let the Mac sleep normally (by default it stays awake while the server runs)
 *           --dock / --no-dock     add the app to the Dock without asking (or don't)
 *           --no-open              don't open the admin panel at the end
 *
 * See docs/INSTALL-MAC.md. No administrator password is needed.
 */
require('./platform/mac/enjoy.js').main(['install', ...process.argv.slice(2)]).catch((e) => {
  console.error(`\n  \u001b[31mError:\u001b[0m ${e.constructor.name === 'Fail' ? e.message : e.stack || e.message}\n`);
  process.exitCode = 1;
});
