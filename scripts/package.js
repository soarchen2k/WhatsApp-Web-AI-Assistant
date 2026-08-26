const fs = require('fs/promises');
const path = require('path');
const JSZip = require('jszip');

const projectRoot = path.resolve(__dirname, '..');
const packageEntries = [
  'manifest.json',
  'media-hook.js',
  'popup.html',
  'popup.js',
  'help.html',
  'styles.css',
  '_locales',
  'dist'
];

async function addEntry(zip, relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  const stats = await fs.stat(absolutePath);

  if (stats.isDirectory()) {
    const entries = await fs.readdir(absolutePath);
    await Promise.all(entries.map(entry => addEntry(zip, path.join(relativePath, entry))));
    return;
  }

  zip.file(relativePath.replace(/\\/g, '/'), await fs.readFile(absolutePath));
}

async function createPackage() {
  const zip = new JSZip();
  await Promise.all(packageEntries.map(entry => addEntry(zip, entry)));
  const outputPath = path.join(projectRoot, 'whatsapp-web-ai.zip');
  await fs.writeFile(outputPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  console.log(`Created ${outputPath}`);
}

createPackage().catch(error => {
  console.error('Unable to package extension:', error);
  process.exitCode = 1;
});
