import { build } from 'esbuild';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
await build({entryPoints:['desktop/src/viewer.js'],outfile:'desktop/desktop.js',bundle:true,format:'esm',minify:true,target:['es2022'],legalComments:'eof',banner:{js:'/* noVNC 1.7.0 source and license notices: /desktop/NOTICE.txt */'}});
await copyFile('node_modules/@novnc/novnc/LICENSE.txt','desktop/novnc-LICENSE.txt');
await mkdir('desktop/licenses',{recursive:true});
for(const name of await readdir('node_modules/@novnc/novnc/docs')) if(name.startsWith('LICENSE.')) await copyFile(`node_modules/@novnc/novnc/docs/${name}`,`desktop/licenses/${name}`);
await copyFile('node_modules/@novnc/novnc/AUTHORS','desktop/licenses/novnc-AUTHORS.txt');
