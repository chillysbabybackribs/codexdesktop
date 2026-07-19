import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Production source uses NodeNext `.js` specifiers so bundlers and emitted
// JavaScript resolve correctly. During strip-only tests, map local `.js`
// specifiers back to their TypeScript source files.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);

    try {
      await access(fileURLToPath(candidate));
      return nextResolve(candidate.href, context);
    } catch {
      // Fall through for imports that only exist as JavaScript.
    }
  }

  return nextResolve(specifier, context);
}
