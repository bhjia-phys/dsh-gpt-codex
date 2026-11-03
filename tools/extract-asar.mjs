/**
 * Extract files from the installed DeepSeek Harness `app.asar`.
 *
 * The GPT/ChatGPT integration work in this repository is built on facts read out
 * of the shipped application, and every claim in `notes/gpt-*.md` cites a file
 * path plus a line number inside one of those packages. This script regenerates
 * that evidence tree so those citations stay checkable after an app update.
 *
 * Usage (same Node as the app, Windows paths matter):
 *
 *   node tools/extract-asar.mjs                       # dump every DSH package + pi-ai
 *   node tools/extract-asar.mjs clients               # dump every client bundle
 *   node tools/extract-asar.mjs list                  # write the full file index
 *   node tools/extract-asar.mjs get <asar-path>...    # extract specific files
 *
 * Output (relative to this repository):
 *   evidence/asar/            filenames with `/` replaced by `__`, so
 *                             `@scope/pkg/lib/index.js` becomes
 *                             `__dsh__node_modules__@scope__pkg__lib__index.js`
 *   evidence/client-bundles/  one bundle per client package
 *   evidence/asar-index.txt   every path in the archive
 *
 * The install location can be overridden with DSH_ASAR.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.join(here, '..', 'evidence');

/**
 * Where DeepSeek Harness installs `app.asar` on this platform.
 *
 * Derived from the home directory so the repository holds no machine-specific
 * path. Set `DSH_ASAR` for any other layout (a Linux package, a portable copy).
 */
function defaultAsarPath() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
  }
  if (process.platform === 'darwin') {
    return '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
  }
  return '';
}

const ASAR = process.env.DSH_ASAR || defaultAsarPath();

/**
 * Read an asar archive's file index.
 *
 * The format: an 8-byte pickle header, a 4-byte header size, a JSON directory
 * whose leaf entries carry `{ offset, size }` relative to the content start.
 * Content begins after 16 bytes of framing plus the JSON header; entries whose
 * `offset` is a non-numeric string must be skipped (asar encodes "unpacked"
 * markers that way, and `Number()` on them yields NaN).
 */
async function readIndex(archive) {
  const handle = await fsp.open(archive, 'r');
  try {
    const framing = Buffer.alloc(16);
    await handle.read(framing, 0, 16, 0);
    const headerSize = framing.readUInt32LE(12);

    const raw = Buffer.alloc(headerSize);
    await handle.read(raw, 0, headerSize, 16);
    const tree = JSON.parse(raw.toString('utf8').replace(/\0+$/, ''));

    const files = [];
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const full = `${prefix}/${name}`;
        if (entry.files) {
          walk(entry, full);
          continue;
        }
        const offset = Number(entry.offset);
        const size = Number(entry.size);
        if (Number.isFinite(offset) && Number.isFinite(size) && size > 0) files.push({ path: full, offset, size });
      }
    };
    walk(tree, '');

    return { handle, files, base: 16 + headerSize };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Filename for one archive path, keeping it inside OUT. */
function outputName(archivePath) {
  return archivePath.replace(/^\//, '').replace(/\//g, '__');
}

async function main() {
  const [command = 'default', ...targets] = process.argv.slice(2);
  const outDir = path.join(EVIDENCE, command === 'clients' ? 'client-bundles' : 'asar');
  await fsp.mkdir(outDir, { recursive: true });

  const { handle, files, base } = await readIndex(ASAR);
  try {
    if (command === 'list') {
      const listPath = path.join(EVIDENCE, 'asar-index.txt');
      await fsp.writeFile(listPath, files.map((file) => file.path).join('\n'), 'utf8');
      console.log(`${files.length} files indexed -> ${listPath}`);
      return;
    }

    let selected;
    if (command === 'get') {
      selected = targets.map((target) => {
        const entry = files.find((file) => file.path === target || `/${file.path}` === target);
        if (entry === undefined) throw new Error(`not in the archive: ${target}`);
        return entry;
      });
    } else if (command === 'clients') {
      // Client bundles are where the UI contracts live: slot declarations, the
      // seat a plugin may fill, and the exact props an owner dispatches.
      selected = files.filter((file) => file.path.endsWith('/lib/client.js'));
    } else {
      // The default set: every DSH package plus the vendored pi-ai library, which
      // is where the provider, OAuth and catalog facts live.
      selected = files.filter(
        (file) =>
          file.path.startsWith('/dsh/node_modules/@deepseek-ai/') ||
          file.path.startsWith('/dsh/node_modules/@earendil-works/') ||
          file.path === '/dsh/package.json' ||
          file.path === '/dsh/desktop-runtime.json',
      );
    }

    let written = 0;
    for (const entry of selected) {
      const buffer = Buffer.alloc(entry.size);
      await handle.read(buffer, 0, entry.size, base + entry.offset);
      await fsp.writeFile(path.join(outDir, outputName(entry.path)), buffer);
      written += 1;
    }
    console.log(`${written} files -> ${outDir}`);
  } finally {
    await handle.close();
  }
}

await main();
