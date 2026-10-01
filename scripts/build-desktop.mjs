import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
await build({entryPoints:['desktop/src/viewer.js'],outfile:'desktop/desktop.js',bundle:true,format:'esm',minify:true,target:['es2022'],legalComments:'eof'});
await copyFile('node_modules/@novnc/novnc/LICENSE.txt','desktop/novnc-LICENSE.txt');
