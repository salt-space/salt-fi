# salt-fi

Rebuild of [`KagamiDigital/salt-autofi`](https://github.com/KagamiDigital/salt-autofi)
on Salt's new SDK (`@kagamidigital/salt-sdk-mirror`), replacing the old
INTU-based stack.

Salt is in Beta — treat this project as subject to change.

## Setup

1. Copy `.npmrc.example` to `.npmrc` and add a GitHub PAT with `read:packages`
   scope (you must be an external collaborator on `salt-sdk-mirror` to install
   the package).
2. Install dependencies:
   ```
   npm install
   ```
3. Run in dev mode:
   ```
   npm run dev
   ```

## Docs

- SDK docs: https://kagamidigital.github.io/docs/
- TypeDoc/API reference: https://kagamidigital.github.io/salt-sdk-mirror/

## Scripts

- `npm run dev` — run `src/index.ts` directly with `tsx`
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled output
