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
3. Copy `.env.example` to `.env` and set:
   - `PRIVATE_KEY` — a 0x-prefixed private key for any EVM EOA (this is the
     wallet that signs the SIWE login and, if you use "Create account",
     co-signs the account's keygen ceremony). You never interact with
     Arbitrum Sepolia directly — that's just the chain Salt uses internally
     to orchestrate ceremonies; the accounts you create/hold assets in can
     live on many other supported testnets.
   - `RPC_URL` — optional; an RPC endpoint for Arbitrum Sepolia, since that's
     the orchestration chain the SDK connects the signer to under the hood.
     Leave blank to use viem's default public RPC for the chain.
4. Run in dev mode:
   ```
   npm run dev
   ```

## Usage

`npm run dev` signs you in with SIWE (against `testnet.salt.space`, TESTNET's
privileged domain) and drops you into an interactive menu:

- **List organisations** — the organisations you're a member of, and your
  access level in each.
- **Manage invitations** — view pending org invitations and accept or
  decline them.
- **List accounts** — the Salt accounts that exist within an organisation you
  pick.
- **Create account** — start a new account's MPC keygen ceremony in an
  organisation (subject to whatever access level the API enforces for your
  membership), with live progress as co-signers join and keygen/backup
  complete.

The auth token from your first sign-in is cached in `.salt-session.json`
(gitignored) so you don't have to re-sign a wallet message on every launch;
it's discarded automatically and you're prompted to restart if it expires.

## Docs

- SDK docs: https://kagamidigital.github.io/docs/
- TypeDoc/API reference: https://kagamidigital.github.io/salt-sdk-mirror/

## Scripts

- `npm run dev` — run `src/index.ts` directly with `tsx`
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled output
