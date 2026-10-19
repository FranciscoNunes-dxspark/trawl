import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

/** Module load hook: compiles .jsx files with esbuild on the fly. */
export async function load(url, context, nextLoad) {
  if (!url.endsWith('.jsx')) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const { code } = await transform(await readFile(file, 'utf8'), {
    loader: 'jsx',
    jsx: 'automatic',
    format: 'esm',
    sourcefile: file,
  });
  return { format: 'module', source: code, shortCircuit: true };
}
