const fs = require('fs/promises');
const path = require('path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const outputPath = path.join(projectRoot, 'dist', 'content.js');

esbuild.build({
  absWorkingDir: projectRoot,
  entryPoints: [path.join(projectRoot, 'content.js')],
  outfile: outputPath,
  bundle: true,
  format: 'iife',
  legalComments: 'external',
  target: ['chrome120']
}).then(async () => {
  const legalPath = `${outputPath}.LEGAL.txt`;
  const legalText = await fs.readFile(legalPath, 'utf8');
  const normalizedLegalText = `${legalText.split(/\r?\n/).map(line => line.trimEnd()).join('\n').trimEnd()}\n`;
  await fs.writeFile(legalPath, normalizedLegalText);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
