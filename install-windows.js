#!/usr/bin/env node
'use strict';
/**
 * ENJOY Signage for Windows: installs or updates it. Run once from this folder:
 *
 *     node install-windows.js
 *
 * Options:  --port 8080            use another web port (default 3000)
 *           --import "C:\old\church-signage"   bring in content from an older copy
 *           --replace-content      with --import, replace content that's already installed
 *           --no-open              don't open the admin panel at the end
 *
 * See docs/INSTALL-WINDOWS.md. Nothing here needs administrator rights, and it works with Smart App Control on.
 */
require('./platform/windows/enjoy.js').main(['install', ...process.argv.slice(2)]).catch((e) => {
  console.error(`\n  \u001b[31mError:\u001b[0m ${e.constructor.name === 'Fail' ? e.message : e.stack || e.message}\n`);
  process.exitCode = 1;
});
