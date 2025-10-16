const fs = require('fs');
const path = require('path');

/*
 * generate_manifest.js
 *
 * This script scans the `tools` folder for HTML files and writes
 * a `tool-manifest.json` file at the project root. The manifest contains an
 * array of objects with `name` and `file` properties that can be consumed by
 * the index page to build a navigation menu automatically. Run this script
 * after adding or removing tools to keep the manifest up‑to‑date.
 */

const toolDir = path.join(__dirname, 'tools');
const manifestPath = path.join(__dirname, 'tool-manifest.json');

// Read all entries in the tool directory
let files = [];
try {
  files = fs.readdirSync(toolDir);
} catch (err) {
  console.error(`Unable to read directory ${toolDir}:`, err);
  process.exit(1);
}

// Filter HTML files only
files = files.filter((file) => file.toLowerCase().endsWith('.html'));
// Sort alphabetically
files.sort((a, b) => a.localeCompare(b));

// Build manifest entries
const manifest = files.map((file) => {
  const filePath = path.join(toolDir, file);

  let title = '';
  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    const match = contents.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (match) {
      title = match[1].trim();
    }
  } catch (err) {
    console.warn(`Unable to read ${filePath} for title extraction:`, err);
  }

  // Fallback to a humanised version of the filename if no title is present.
  if (!title) {
    try {
      title = decodeURIComponent(file);
    } catch (_) {
      title = file;
    }
    title = title
      .replace(/\.html$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  return {
    name: title,
    file: `tools/${file}`,
  };
});

// Write manifest to file
try {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${manifest.length} entries to ${manifestPath}`);
  // Also write a JS file that assigns the manifest to a global variable. This is useful when
  // loading the index page via the file:// protocol where fetch() cannot read local files.
  const jsFilePath = path.join(__dirname, 'tool-manifest.js');
  const jsContent = 'window.toolManifest = ' + JSON.stringify(manifest, null, 2) + ';\n';
  fs.writeFileSync(jsFilePath, jsContent);
  console.log(`Wrote manifest script to ${jsFilePath}`);
} catch (err) {
  console.error(`Unable to write manifest file ${manifestPath}:`, err);
  process.exit(1);
}