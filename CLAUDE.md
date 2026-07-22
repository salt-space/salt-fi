# salt-fi

Rebuild of `KagamiDigital/salt-autofi` on Salt's new SDK (INTU has been replaced).
Salt is in Beta — treat all of this as subject to change; verify against
current docs/types before relying on anything below long-term.

An interactive **terminal app** (a client, not a library) for getting started
with Salt's MPC self-custody / treasury SDK: sign in with a wallet, create an
organisation, invite collaborators, stand up Robo Guardians, create accounts,
fund/send/swap assets, and manage transaction policies. Aimed partly at
onboarding and educating non-technical users, so UX copy and the "Getting
started" wizard matter as much as the plumbing. Public repo:
`github.com/salt-space/salt-fi`.

## Architecture

- **Runtime**: TypeScript, ESM (`"type": "module"`), NodeNext resolution, run
  directly with `tsx` in dev. `strict` TypeScript. Because it's NodeNext ESM,
  **relative imports must carry a `.js` suffix** (e.g. `import { runMenu } from
  "./menu.js"`) even though the source is `.ts` — match this in new files.
- **UI**: `@clack/prompts` (v1.x) — `select`/`text`/`confirm`/`multiselect`/
  `spinner`/`note`/`log.*`/`isCancel`/`intro`/`outro`. Esc cancels any prompt
  (`p.isCancel(value)` is true).
- **Chain access**: `viem`. The wallet is an EOA from `PRIVATE_KEY`.
- **AI**: `@anthropic-ai/sdk`, used only by the "Policy chat" feature.

### File map (`src/`)

- `index.ts` — entrypoint: intro → build wallet client → `loadSalt` (sign in) →
  `runMenu` → `salt.disconnect()`.
- `env.ts` — typed access to `PRIVATE_KEY` (required, 0x-prefixed) and `RPC_URL`
  (optional); loads `dotenv/config`. `DOTENV_CONFIG_PATH` selects an alt file.
- `wallet.ts` — `createSaltWalletClient()`: viem wallet client on
  **`arbitrumSepolia`** (the orchestration chain), `http(env.rpcUrl)` transport.
- `session.ts` — `loadSalt(walletClient)`: reuses a cached auth token from
  `.salt-session.json` (keyed by lowercased address, so `.env.a`/`.env.b` don't
  collide) if it still verifies, else does a fresh SIWE `authenticate()` and
  caches the token. `clearStoredSession(address)` on expiry. Domain constant
  `testnet.salt.space` lives here.
- `errors.ts` — `isAuthExpired(err)` (true for `InvalidAuthToken` **or**
  `ApiError` with `status === 401` — a server-rejected expired token comes back
  as a generic 401, *not* `InvalidAuthToken`, despite some SDK doc comments);
  `formatSaltError(err)` maps SDK error classes to friendly copy;
  `reportError(err)` logs the friendly message but **re-throws** auth-expiry so
  the menu loop can clear the session and prompt a restart.
- `menu.ts` — the top-level loop. Grouped into submenus (see below); data-driven
  via `MenuEntry { value, label, hint?, run }`; `execute()` wraps every action to
  translate auth-expiry into a clean app exit; `openSubmenu()` loops a group
  until Esc.
- `prompts.ts` — shared UI helpers: `select()` wrapper (adds a dimmed
  `Esc: <action>` hint line; pass `escAction` to override the default "go back");
  `pickOrganisation()`; `renderSignerList()`; `ACCESS_LEVEL_LABEL`.
- `chains.ts` — testnet chain lookup tables (ids, names, gas-token symbols).
- `uniswap.ts` — addresses, ABIs, and quote/encode helpers for fast swap.
- `policies.ts` — shared policy helpers, incl. `ResolveLabel` /
  `buildResolveLabel(accounts, members)` (address → human label).
- `commands/*.ts` — one module per feature (see menu below). Reusable pieces are
  exported so the wizard can compose them; several flows accept an optional
  preselected `organisationId` to skip their own org picker when driven by the
  wizard.

### Menu structure (grouped submenus)

```
Getting started        guided first-time wizard (getting-started.ts)
Organisation ▸         create · invite collaborators · manage collaborators
                       · manage your invitations · list organisations
Robo Guardians ▸       set up robo guardians · check robo guardians
Accounts ▸             create account · list accounts · listen for nudges
Assets ▸               faucet for Salt accounts · send assets · swap assets
Policies ▸             manage policies · policy chat
Exit
```

## Conventions

- **Error handling**: command flows `try/catch` around SDK calls and call
  `reportError(err)` (never swallow silently). Auth-expiry must propagate — don't
  catch-and-drop it. Add new SDK error classes to `formatSaltError`.
- **Cancellation**: after every prompt, check `p.isCancel(value)` and return
  early. Reusable sub-flows that the wizard composes should **return a signal**
  (e.g. boolean) so the wizard can exit rather than falling through to a wait
  gate — see `setUpRoboHost` / `inviteMemberFlow` returning `boolean`.
- **`p.note` wraps at the terminal width** (~44 cols in a typical narrow
  terminal), which breaks aligned two-column tables — keep note lines short
  (≲42 chars) and prefer vertical layouts over columns.
- **Copy bar**: concise, no repetition, no explaining-the-obvious, not
  patronising. Use the real name of a thing in context (e.g. the actual gas-token
  symbol, not "native gas"). This is an onboarding tool for non-technical people.
- **Idempotency / resumability**: flows should detect existing state and adapt
  (the wizard resumes; `setUpRoboHost` reuses an existing robo host instead of
  409ing). Re-running should never dead-end.

## Commands

- `npm install` — install deps (public npm, no auth). SDK declares Node `>=24`;
  it runs fine on Node 22 but prints a harmless `EBADENGINE` warning.
- `npm run dev` — run `src/index.ts` with `tsx` (main dev command).
- `npm run dev:a` / `npm run dev:b` — same, but load `.env.a` / `.env.b` via
  `DOTENV_CONFIG_PATH` (for running two identities at once — needed to test
  invites/nudges, which require two signers live simultaneously).
- `npm run build` — `tsc` to `dist/`. `npm start` — run compiled output.
- `npx tsc --noEmit` — typecheck (the standard pre-commit check; keep it clean).

## Completed work (feature inventory)

All merged to `main`:
- Core: SIWE sign-in + session caching, organisation CRUD, invitations, member
  management, account creation (MPC keygen with live signer presence).
- Robo Guardians: self-hosted setup script + AWS CloudFormation launch URL,
  status checks, "Set up Robo Guardians" for an existing org.
- Assets: faucet (Circle + Google Cloud, testnet), send (curated asset allowlist
  across four testnets), fast swap (Uniswap v3 on Sepolia).
- Policies: form-driven CRUD (`policy-management.ts`) and a natural-language
  agent (`policy-chat.ts`, needs `ANTHROPIC_API_KEY`).
- Onboarding: five-step "Getting started" wizard + grouped submenus + README
  onboarding for non-technical first-time users (terminal basics, prerequisites).
- Migrated off the GitHub-Packages scoped SDK to public npm `salt-sdk`.

## Important constraints

- **Never commit secrets.** Before any commit, scan the diff for `sk-ant-`,
  `PRIVATE_KEY=0x<hex>`, `ghp_`, tokens. Gitignored and must never be committed:
  `.env`, `.env.*` (except `.env.example`), `.salt-session.json`, `.npmrc`, and
  **`robo-setup-*.sh`** (these generated scripts embed a secret OTP — treat like
  a credential; several currently sit untracked in the repo root, which is fine
  because they're gitignored).
- **Public repo**: always **check with the user before creating GitHub issues**
  or posting any public content. Label issues that need a Salt SDK/API change
  `needs-salt-sdk`; label repo-side improvements `enhancement`.
- **Git workflow**: only commit/push when asked. Prefer a feature branch + PR;
  don't push straight to `main` unless told. Commit messages end with the
  `Co-Authored-By: Claude` trailer; PR bodies end with the Claude Code line.
  (Note: local `main` now tracks `origin/main`, after it once silently drifted
  because upstream tracking wasn't set — a stale-`main` trap to watch for.)
- **Robo credential terminology**: surfaced to users as an **OTP (one-time
  password)**; the SDK/CloudFormation template still call it `apiKey` /
  `param_ApiKey` — keep those literal names for SDK/template internals only.
- **Invitation read limitation (SDK)**: an invitee has **no read access** to an
  org before accepting — `getOrganisationById` 403s, `getOrganisations` omits
  it, and the invitation payload carries only `organisation_id` + `accessLevel`
  (no org name, no inviter). So you cannot show/verify org name + inviter
  pre-acceptance; the invite screen shows the org ID + access level and asks the
  invitee to confirm out-of-band. Tracked as GitHub issues #11 (upstream,
  `needs-salt-sdk`) and #12 (salt-fi follow-up, blocked by #11).

## The SDK itself

- **Real package**: [`salt-sdk`](https://www.npmjs.com/package/salt-sdk) on
  **public npm** — plain `npm install`, no auth needed. This is a change as of
  2026-07-20: the SDK previously lived only at the scoped, GitHub-Packages-only
  `@kagamidigital/salt-sdk-mirror` (requiring a `.npmrc` with a GitHub PAT and
  external-collaborator access) — that scoped package is now superseded by this
  one and salt-fi has migrated off it. `.npmrc`/`.npmrc.example` were removed;
  if either resurfaces, that's stale.
  - **Historical note, now resolved**: a public npm package literally named
    `salt-sdk` used to exist and was unrelated/unaffiliated with Salt — that
    was the reason for avoiding it before. The current `salt-sdk` package is
    the real one: verified via its npm registry maintainer (`team@salt.space`),
    publication through npm's Trusted Publisher / GitHub Actions OIDC
    mechanism, and a byte-identical type-definition diff against the last
    known-good `@kagamidigital/salt-sdk-mirror@0.0.28`. Don't assume any given
    npm package name is safe just because it "sounds right" — re-verify
    ownership/provenance the same way before trusting a similar situation
    again.
- Docs: https://kagamidigital.github.io/docs/
- TypeDoc/API reference: https://kagamidigital.github.io/salt-sdk-mirror/
  (still hosted under the old org name as of this writing)
- When published docs and the installed package's actual type definitions
  disagree, trust the type definitions — this is beta software and docs can
  lag behind. Read `node_modules/salt-sdk` directly when in doubt.
- Requires `"type": "module"` in package.json — the SDK ships with top-level
  `await` in an ESM file, which breaks under CJS-default Node resolution.

## Authentication model

- Wallet-based, SIWE (Sign-In with Ethereum). An EOA signs a login message
  via a viem `walletClient`; Salt verifies and issues a session token scoped
  to a **domain**.
- Constructor: `new Salt({ environment: 'TESTNET', domain: 'testnet.salt.space' })`
- **Domain matters a lot**: Robo Guardian configuration (the robo credential,
  seed material) is only returned to sessions authenticated against Salt's
  *privileged* domain for that environment. For TESTNET, that domain is
  `testnet.salt.space`. Using the wrong domain doesn't necessarily error —
  it can silently return `null` for secrets, or (see CloudFormation bug
  below) connect a live service to entirely the wrong backend.
- **Terminology**: the robo credential is surfaced to users as an **OTP
  (one-time password)** in this app's copy and docs. The SDK and the
  CloudFormation template still call it `apiKey` / `param_ApiKey`, so keep
  those literal names when describing SDK/template internals — the rename is
  user-facing copy only, until Salt changes it upstream.

## Network / chain IDs — the bug we hit

- **TESTNET orchestration chain is Arbitrum Sepolia, chain ID `421614`.**
- Arbitrum **One** (mainnet) is `42161` — do NOT use this for testnet work.
- `INTU_NETWORK` / `INTU_*` naming is from the **old** pre-SDK-rewrite stack.
  If you see `INTU_NETWORK` or similar in any generated config, that's a
  signal you're looking at stale/legacy tooling, not the current SDK.

### Fixed in 0.0.27: AWS CloudFormation robo-host template

Previously (through SDK 0.0.26), `RoboHost.generateCloudFormationUrl()`
pointed at a single hardcoded `setup.cloudformation-x86.yaml`, miswired for
testnet: hardcoded `API_URL="https://app.salt.space/api"` (mainnet/production)
instead of `testnet.salt.space`, `ORCHESTRATION_NETWORK_ID=42161` (Arbitrum
One) instead of `421614`, and a legacy `INTU_NETWORK=arbitrum-main` that
shouldn't have been present. Symptom: container boots, pulls
`saltrobo/app:latest`, but loops forever logging `Socket inactive, attempting
manual reconnection...` against `app.salt.space` — the OTP (`param_ApiKey`)
only exists in testnet's database, so it never authenticates. Was flagged to
Jason/Edd as unresolved.

**Verified fixed as of SDK `0.0.27`** (checked by diffing 0.0.26 vs 0.0.27's
bundled `salt.es.js` directly, then generating a real URL and fetching the
template): `generateCloudFormationUrl()` now builds an environment-namespaced
template URL (`https://${environment.name}-robo-signers-cloud-launch-template.s3...`,
ties into the `EnvironmentName` enum added in 0.0.26's types) instead of one
universal bucket. The `testnet-robo-signers-cloud-launch-template` bucket's
`setup.cloudformation-x86.yaml` now correctly has
`API_URL="https://testnet.salt.space/api"` and `SALT_CHAIN_ID=421614`, and no
`INTU_NETWORK` reference at all. Re-verify with the same
diff-then-fetch-the-template approach before trusting this on any future SDK
bump — don't assume a fix holds across versions without checking again.

### What actually works for testnet robo hosting

Both paths are now viable on `0.0.27`+:
- `RoboHost.generateSetupScript()` (self-hosted install script) — verified
  working end-to-end on a Hostinger VPS, correctly pulled
  `saltrobo/staging:latest` and connected to `testnet.salt.space` with
  `HTTP 200` on every step, no reconnect loop.
- `RoboHost.generateCloudFormationUrl()` — the bug above is fixed as of
  0.0.27 (verified by fetching the actual template, see above). Wired up as
  a second option in `create-organisation.ts`'s "Create organisation" flow.
  No one's actually launched a stack from it end-to-end yet (only the
  template contents and URL generation are verified) — if you hit anything
  unexpected running it for real, that's the first thing to check.

## Org / Account structure

- `createOrganisation()` → org with an owner (your EOA).
- `createRoboHost({ name, organisationId, ownerAddress })` — one robo host
  per org; a second call 409s. Use `getRoboHost({ organisationId })` to
  fetch the existing one instead of re-creating.
- `RoboHost.provisioned` — true once at least one signer has actually
  connected. If false, `generateSetupScript`/`generateCloudFormationUrl`
  are safe to re-run (per SDK docs).
- **Accounts require at least 2 collaborators** on the org (owner + 1) before
  they can be created — invite a second member first if starting fresh. A
  collaborator only counts once their status is `Active` (they've accepted);
  a fresh invite is `Invited`.
- Largest account configuration needs up to 3 Robo Guardian signers.
- Useful read APIs: `getRoboStatus({ organisationId })` → `{ isReachable,
  onlineCount, signers }`; `getAccounts(organisationId)`; `getOrganisationById`
  → `{ organisation }` (403s for non-members / pending invitees).

## Migration notes from salt-autofi

- Re-check every call site that referenced INTU-specific naming/config —
  treat `INTU_*` anywhere in the old codebase as a signal that section needs
  rewriting against the new SDK, not a direct port.
- Old repo may reference mainnet or a different environment entirely; don't
  assume its network/chain constants carry over to TESTNET work here.
