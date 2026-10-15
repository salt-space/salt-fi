# salt-fi

A mini terminal app to get started with the Salt SDK ([`salt-sdk`](https://www.npmjs.com/package/salt-sdk) on npm).

**New to Salt?** The [Salt SDK Field Guide](https://salt-space.github.io/salt-fi/field-guide/)
walks through setup, signing in with your wallet, installing Robo Guardians
with Claude Code over SSH, and the policy layer, with replays of a real setup.

## Important notice

**salt-fi is an independent open-source project maintained by its author in a personal capacity. It is not an official Salt product and is not part of Salt's supported product offering.**

The maintainer of this project is also a founder of Salt. This repository is nevertheless independently maintained, and its releases, documentation and support should not be treated as official releases, documentation or support from Salt unless Salt expressly states otherwise.

References to Salt, the Salt SDK, Salt APIs, Salt services and related names are made to describe this project's interoperability with the Salt platform. No licence to use Salt branding, trademarks, proprietary software or services is granted by this repository.

> **Mainnet warning:** This software can interact with public blockchain networks and can initiate transactions involving assets with real economic value. Bugs, incorrect configuration, compromised credentials, third-party failures, smart-contract vulnerabilities or user error may result in the irreversible loss of digital assets.

Use this software at your own risk. Review and verify addresses, transactions, permissions, policies, contract interactions and configuration before execution. Blockchain transactions may be irreversible once submitted.

This project does not provide custody, asset recovery, transaction monitoring, financial guarantees or insurance. You are responsible for the security of your wallets, credentials, keys, devices and recovery methods.

Unless expressly stated otherwise, this project has not been independently audited or formally verified.

Nothing in this repository constitutes financial, investment, legal, tax, accounting, security or other professional advice. Nothing in this repository is an offer, solicitation, recommendation, endorsement or guarantee concerning any asset, protocol, transaction, strategy or service.

This software may interact with third-party blockchains, protocols, smart contracts, APIs and services. Those systems are outside this project's control and may have their own terms, fees, security assumptions and risks.

The software in this repository is provided **"AS IS"**, without warranties or guarantees of any kind. To the maximum extent permitted by applicable law, the author and contributors disclaim liability for losses or damages arising from the use of, or inability to use, this software.

Use of the Salt SDK, Salt platform, APIs or other Salt services may be subject to separate terms, licences and policies provided by Salt.

> **Terms of use.** By using this repository you agree to the [Salt Platform Suite Terms of Use](https://salt.space/terms/app/).

## New to the terminal? Start here

No experience needed — this section gets you comfortable before anything else.
If you already live in a terminal, skip to [Prerequisites](#prerequisites).

**What is a terminal?** It's just a window where you type commands instead of
clicking buttons. This whole app runs inside that window: you'll type a command
to start it, then use your arrow keys and Enter to move through menus. That's
it — no coding required.

**Open your terminal:**

- **macOS** — press `Cmd + Space` to open Spotlight, type `Terminal`, and press
  Enter. (It also lives in Applications → Utilities → Terminal.)
- **Windows** — click Start, type `PowerShell`, and press Enter. (Or open the
  newer "Windows Terminal" if you have it — either works.)
- **Linux** — press `Ctrl + Alt + T`, or search your apps for "Terminal".

A window opens with a blinking cursor. You type a line, press Enter, and it
runs. If something looks stuck, you can always press `Ctrl + C` to stop the
current command and get your prompt back.

**Move into a folder.** After you clone this project (step 1 of
[Setup](#setup)), you need to tell the terminal to "go into" that folder before
running the app. The command is `cd` (short for "change directory"):

```
cd salt-fi
```

Not sure of the full path to the folder? On macOS and most Linux desktops you
can type `cd ` (with a space after it), then **drag the folder from your file
explorer onto the terminal window** — it fills in the path for you. Then press
Enter. To check where you are, type `pwd` ("print working directory") and press
Enter; it shows the folder you're currently in.

That's the whole toolkit you need: open the terminal, `cd` into the folder, and
type the commands below exactly as shown.

## Prerequisites

You'll need these installed on your machine first:

- **Node.js 22 or newer** (this installs `npm` alongside it). Grab it from
  [nodejs.org](https://nodejs.org/) or, if you juggle Node versions, via
  [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22 && nvm use 22`). The
  SDK declares Node 24+, so on 22 you may see a harmless `EBADENGINE` warning
  during `npm install` — it still works. Verify your install with:
  ```
  node --version   # should print v22.x or higher
  npm --version
  ```
- **Git** — to clone this repository ([git-scm.com](https://git-scm.com/)).
- **An EVM wallet** — a 0x-prefixed private key for any Ethereum account (see
  step 3 below for what it's used for), or a Ledger (see
  [Signing with a Ledger](#signing-with-a-ledger)). A throwaway key is fine for
  testnet; don't reuse one that holds real mainnet funds.

## Setup

1. Clone the repository and enter it:
   ```
   git clone https://github.com/salt-space/salt-fi.git
   cd salt-fi
   ```
2. Install dependencies:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and set:
   - `PRIVATE_KEY` — a 0x-prefixed private key for any EVM EOA. This wallet
     *is* your identity in Salt: it signs you in with SIWE (see
     [Signing in](#signing-in-your-wallet-is-your-identity)) and, if you use
     "Create account", co-signs the account's keygen ceremony. You never interact with
     Arbitrum Sepolia directly — that's just the chain hosting Salt's on-chain
     shard registry (where your account's key shards are registered/backed up).
     Salt covers the gas for those registry operations — the signer's wallet
     never pays gas; the accounts you create/hold assets in can live on many
     other supported testnets.
   - Or, to keep that key on a Ledger instead, set `SIGNER=ledger` and leave
     `PRIVATE_KEY` out — see [Signing with a Ledger](#signing-with-a-ledger).

   > ⚠️ **Mainnet security:** Use a dedicated signer/account with only the permissions and funds required for what you are doing. Do not paste the private key of a wallet holding significant assets into an unfamiliar environment, shared machine, shell history, source file or committed `.env` file.

   `.env`, `.env.a`, `.env.b` and the session cache are gitignored — never commit a private key or a populated `.env` file.
4. Run in dev mode:
   ```
   npm run dev
   ```
   This asks which environment to use — **Testnet** (default) or **Mainnet**
   (real funds; it asks you to confirm) — then signs you in and drops you into
   the interactive menu. First-time users should pick **Getting started** for a
   guided walkthrough. To skip the prompt, launch a specific environment
   directly with `npm run dev:testnet` or `npm run dev:mainnet` (these also
   accept `SALT_ENV=testnet|mainnet` in your `.env`).

### Running several identities at once

Testing things like "Invite member" or "Listen for nudges" needs more than one
signer identity running at the same time (a three-signer account needs three).
A single shared `.env` won't do it, since editing it in one terminal changes
the key the other terminals pick up too. Instead, copy `.env.example` to
`.env.a`, `.env.b`, `.env.c` and `.env.d` (all gitignored), put a different
`PRIVATE_KEY` in each, and run one identity per terminal:

```
npm run dev:a   # uses .env.a
npm run dev:b   # uses .env.b
npm run dev:c   # uses .env.c
npm run dev:d   # uses .env.d
```

These scripts just set `DOTENV_CONFIG_PATH`, which `dotenv/config` (used in
`src/env.ts`) natively respects to load a file other than `.env`. Any other
`.env.<name>` works the same way: `DOTENV_CONFIG_PATH=.env.<name> npm run dev`.
A profile can also set `SALT_ENV`, or `SIGNER=ledger`, though only one terminal
can use a given Ledger at a time. Both
terminals still share the same session cache file, but since it's keyed by
wallet address, that's not a problem — each identity gets its own entry.

## Signing in: your wallet is your identity

There are no Salt usernames or passwords. salt-fi signs you in with
**Sign-In with Ethereum (SIWE)**: the app signs a standard login message with
your wallet (the key in `PRIVATE_KEY`, or your Ledger), and Salt verifies the
signature and issues a session token. Signing happens locally, so the key never
leaves your machine (or, with a Ledger, the device).
Nothing goes on-chain and there's no gas to pay.

That wallet's address is who you are in Salt:

- **Organisations** invite you by address, and you accept with the same
  wallet. Your access level (owner, member or agent) is attached to that
  address.
- **Accounts** you co-sign use this wallet in their MPC key-generation and
  signing ceremonies.
- **Backups** are encrypted to this wallet's public key, which Salt recovers
  from your sign-in signature. That covers your keyshare backups and, if you
  set up your organisation's Robo Guardians, their seed. Only this wallet can
  recover them, so back it up like any other key.

Change `PRIVATE_KEY` and you're a different person to Salt, which is how
[running several identities](#running-several-identities-at-once) works. A
session is scoped to the environment you picked (`testnet.salt.space` or
`app.salt.space`) and cached per wallet in `.salt-session.testnet.json` or
`.salt-session.mainnet.json` (both gitignored), so you don't sign again on
every launch. The app refreshes the token automatically; if it can't, it
discards the session and signs you in afresh.

## Signing with a Ledger

Your signer key can live on a Ledger instead of in `.env`. The Salt SDK only
ever asks your wallet for signatures, never for the key itself: the sign-in
message, Robo Guardian activation, and a typed message that unlocks your
keyshare in each account ceremony. The device can sign all of these.

1. Install the **Ethereum** app on your Ledger (Nano S Plus, Nano X, Stax or
   Flex) with Ledger Live, then **quit Ledger Live**, because it holds onto the
   USB connection. The original Nano S also works, but it can only show you
   hashes for typed messages.
2. In `.env`, set `SIGNER=ledger`. It signs with Ledger Live's first Ethereum
   account by default; set `LEDGER_PATH` to use another (Ledger Live's account
   N is `44'/60'/N'/0/0`). On Linux, install
   [Ledger's udev rules](https://github.com/LedgerHQ/udev-rules) first.
3. Plug in the Ledger, unlock it, open the Ethereum app and run `npm run dev`.

If your Ledger drops off USB mid-session, the app waits up to a minute for you
to reconnect it. If it keeps dropping, try another cable: the app can only see
what your computer sees. Run with `LEDGER_DEBUG=1` to print the USB connection
events (never what's being signed).

What to expect:

- **You confirm on the device** when you sign in, unless your saved session is
  still valid ("Signed in as … (saved session)" means no signature was needed;
  the app only read your address from the device). You also confirm once for
  each account ceremony: creating an account, sending, swapping, bridging, signing a
  message, and so on. "Verify account backup" runs two ceremonies, so it asks
  twice. The ceremony prompt is a typed
  message from `salt.space` with the action `derive-key`. Confirm it promptly,
  because the other signers are waiting in the ceremony.
- **Creating or joining an account asks first.** The SDK needs that prompt to
  back up your share of the new account's key, which normally happens after the
  key is generated. salt-fi asks for it before key generation instead, so
  rejecting it stops the setup with nothing generated, rather than losing your
  share.
- **Nudges need you at the device.** "Listen for account nudges" joins
  ceremonies for you, but each one still waits for a confirmation on the
  Ledger, so it won't co-sign unattended.
- **A Ledger is a new identity.** Its address differs from your `PRIVATE_KEY`
  wallet's, so it starts with no organisations or accounts. Invite it into
  your organisation, then create accounts with it as a signer. Accounts your old
  key co-signs stay tied to that key.
- **Robo Guardian seed backups** are encrypted to your signer's public key
  (see [Signing in](#signing-in-your-wallet-is-your-identity)). salt-fi never
  decrypts them, and a Ledger can sign but won't decrypt. If you set up Robo
  Guardians as a Ledger owner, recovering that seed yourself would need your
  Ledger's recovery phrase in a software wallet.

## Usage

`npm run dev` asks which environment to use, then signs you in with SIWE
(against that environment's privileged domain — `testnet.salt.space` for
Testnet, `app.salt.space` for Mainnet; see
[Signing in](#signing-in-your-wallet-is-your-identity)) and drops you into an
interactive menu.
The launch banner names the environment, and mainnet is flagged with a real-funds
warning so you always know which network you're on. It's grouped, with a
guided walkthrough at the top and the individual tools organised into submenus.
Creating an account and sending a transaction can cost a small fee; see
[Fees (x402)](#fees-x402) for who pays it.

- **Getting started** — a guided, five-step walkthrough that teaches each Salt
  concept as it sets it up: organisation → collaborators → Robo Guardians →
  account → first policy. It detects what you've already done and resumes, and
  when a step depends on something outside the terminal (a collaborator
  accepting an invite, a Robo Guardian coming online) it polls for a bit, then
  lets you exit and re-run later to continue. Aimed at first-time users; drawn
  from the [Salt onboarding docs](https://docs.salt.space/documentation/using-salt/onboarding).

### Organisation

- **Create organisation** — create a new organisation with you as owner, then
  optionally register a Robo Guardian host for it and choose how to set it
  up: a self-hosted install script (`robo-setup-<org-name>-<org-id>.sh`,
  gitignored — it embeds a secret OTP / one-time password), fully automated — run it as root
  on any Ubuntu or Debian box and it installs everything it needs (Docker
  included) and starts the robo itself — or an AWS CloudFormation URL that
  launches a pre-filled stack doing the same thing with no server access
  needed. Either way, check progress afterward with "Check robo guardians".
  See [`docs/robo-hosting/`](docs/robo-hosting/README.md) for platform-specific
  walkthroughs (Hostinger validated end-to-end; the AWS template's contents
  are verified correct for testnet, but no one's launched a real stack from
  it yet — more to come).
- **Invite collaborators** — invite another EVM address into an organisation
  you pick, with a role label and access level (owner/member/agent). Only
  organisation owners can actually do this — the API enforces it.
- **Manage collaborators** — edit an existing collaborator's display name,
  role label, and access level. Only organisation owners can do this too —
  the API rejects it otherwise, and also refuses to demote/deactivate an
  organisation's last remaining owner.
- **Manage your invitations** — view pending org invitations and accept or
  decline them.
- **List your organisations** — the organisations you're a member of, and
  your access level in each.

### Robo Guardians

- **Set up Robo Guardians** — register (or re-issue setup for) an existing
  organisation's robo host and get its self-hosted script or CloudFormation
  URL — the same setup "Create organisation" offers, but available any time,
  not just at creation. Reuses an existing host record rather than failing if
  one's already registered.
- **Check robo guardians** — see whether an organisation's Robo Guardians
  are currently online, before starting a ceremony that needs them. Worth
  checking if "Create account" ever seems stuck waiting for a signer to join
  — there's no timeout for a party that never shows up in the huddle
  (`timeoutMs` on account creation only bounds keygen rounds *after*
  everyone's present, not the wait for presence itself).

### Accounts

- **Create account** — start a new account's MPC keygen ceremony in an
  organisation (subject to whatever access level the API enforces for your
  membership). Co-signers are picked from the organisation's active
  collaborators (no pasting addresses); Robo Guardians are added
  automatically. Live progress shows each expected signer by name/"You"/"Robo
  guardian" and whether they've joined yet, so it's clear who the ceremony is
  still waiting on.
- **Listen for account nudges** — open a websocket connection and
  automatically join any account-setup ceremony you're nudged for (e.g. a
  teammate names you as a co-signer in "Create account"). Leave it running
  in a terminal while you wait; press Enter to stop.
- **List accounts** — the Salt accounts that exist within an organisation you
  pick.

### Assets

- **Faucet for Salt accounts** — top up a Salt account with test funds on any
  of the four supported testnets (only fully set-up accounts are offered as
  targets, not your signing wallet). Pick the account and network; it prints
  and can open the account's address alongside **Circle** (the chain's gas
  token — ETH, or POL on Amoy — plus testnet USDC) and **Google Cloud** (gas
  token only). Both work for brand-new accounts with no prior mainnet
  history, unlike Alchemy or Chainlink's faucets. Circle also has a
  programmatic drip API — a future upgrade once we have a verified API key.
- **Send assets** — send a mainstream asset (native currency, or a
  well-known token like USDC/USDT/DAI/WETH/WBTC — a curated allowlist rather
  than every balance an aggregator reports, to keep out spam/airdrop tokens)
  from an account you're a signer on. Checks balances across four testnets —
  Sepolia, Arbitrum Sepolia, Polygon Amoy, and Base Sepolia — so the asset
  picker doubles as the chain picker (e.g. "USDC on Base Sepolia"). Recipient
  can be picked from other accounts in the same organisation, or entered
  manually. Shows live signing progress (the account's Robo Guardians,
  nudged automatically), a per-stage timing breakdown
  (proposed/signed/broadcast — see
  [`docs/transaction-stages.md`](docs/transaction-stages.md) for exactly
  what each stage means), and the transaction hash once broadcast.
- **Swap assets** — swap one of the account's ERC-20 tokens for another. Two
  paths: **Fast swap** (Uniswap v3 — an immediate on-chain swap, no API key)
  and **Slow swap** (Turbine — coming soon). Fast swap quotes across Uniswap's
  fee tiers, picks the best, then runs the `approve` and the swap as MPC
  ceremonies from the account itself. Uniswap v3 is deployed on Sepolia, so
  unlike a mainnet-only aggregator this works on testnet today (e.g. USDC ↔
  WETH). ERC-20 → ERC-20 only for now (wrap native first). See
  [`docs/swap.md`](docs/swap.md).

### Policies

- **Manage policies** — form-driven CRUD for an account's transaction
  policies (whitelist / blocklist, denied proposers, per-transaction limits,
  contract-call restrictions) across chains. List, add, edit, and delete
  policies via guided prompts, with a few contract-restriction presets (e.g.
  "ERC-20 transfer — only to a specific recipient") to save typing. **No API
  key required** — this is the plain, always-available way to manage
  policies; Policy chat below is the natural-language alternative.
- **Policy chat** — a natural-language agent for reading and managing an
  account's transaction policies (whitelists, per-transaction limits, denied
  proposers, contract-function restrictions). Ask things like "what are my
  policies?", "copy my whitelist to all chains", "copy account A's policies
  onto account B", or "I'm going to trade on AAVE — what should I restrict?".
  Every change it proposes is shown and confirmed before it's applied.
  Requests Salt can't express yet (time-scheduled access, cumulative limits,
  enforced approvals) are logged to
  [`docs/requested-policies.md`](docs/requested-policies.md) for the Salt
  team. Requires an `ANTHROPIC_API_KEY` in `.env` (this is the only feature
  that needs one); powered by Claude via the Anthropic SDK.

From salt-sdk 0.0.44, your wallet signs every policy change
(create, edit or delete). The app does this for you with the wallet you signed
in with; on a Ledger, confirm it on the device.

## Fees (x402)

Salt can charge a small fee, in USDC, for two things: **creating an account**
and **sending a transaction** (anything that submits one: sending, swapping,
bridging, and so on). It's paid over x402, an open standard for paying over
HTTP: when an action costs a fee and nothing has paid it, Salt answers
`402 Payment Required`, and the app signs a USDC payment and tries again. The
payment is a signed transfer authorisation, so the wallet that pays needs the
USDC but **no gas**.

This needs salt-sdk 0.0.44 or newer, which this app installs. With 0.0.43
or earlier the app never pays and the **Fees (x402)** menu doesn't appear.

**Who pays.** Set `SALT_FEE_PAYER` in `.env`, or switch at any time from
**Fees (x402) → Choose who pays**:

| `SALT_FEE_PAYER` | Who pays |
|---|---|
| `signer` | Your signing wallet (the `PRIVATE_KEY` wallet, or your Ledger), from its own USDC. **The default on testnet.** |
| `wallet` | A separate sponsor wallet, so your signer never needs to hold funds. Put its private key in `SALT_FEE_PAYER_KEY` (or enter it in the menu, where it's kept in memory for that session only). |
| `account` | One of your Salt accounts. Put its id in `SALT_FEE_ACCOUNT_ID` (or pick it in the menu). Each payment is an MPC signing ceremony on that account, co-signed by its Robo Guardians and you, so they need to be online. |
| `none` | Nobody: anything that costs a fee is refused. **The default on mainnet.** |

**Mainnet never pays without asking.** Nothing picks a payer for you on
mainnet. Even once you choose one, the app pays without asking only on a
testnet chain, and only up to `SALT_FEE_MAX_USDC` (25 USDC by default). On any
other chain it shows the amount, the chain and who it's paying, and asks you to
confirm every payment; with no terminal to ask in, it refuses. On testnet, the
app pays in test USDC automatically: give the paying wallet some testnet USDC
from [Circle's faucet](https://faucet.circle.com/) on the chain it pays on.

Each payment prints a `Fee:` line saying how much, on which chain, and who
paid. Before paying, the app checks the payer holds enough USDC on that chain;
if it doesn't, it stops before anything is signed and says what would work
instead (another chain where that wallet has USDC, or another wallet that
does). With a Ledger, each payment your signer makes, or co-signs for a Salt
account, is one more confirmation on the device.

The rest of the **Fees (x402)** menu:

- **Show what Salt charges** — the fee for each action, on each chain Salt
  accepts payment on.
- **Toggle pre-signed payment** — sign the payment before the action instead
  of in reply to the 402, so it goes through in one request rather than two.
- **Pre-sign a batch** — sign several payments now and spend one per later
  action. Signing costs nothing; only a payment that's spent costs the fee.
  Each is tied to one payer, action and chain, expires after a while, and is
  never used within two minutes of expiring. They're kept in
  `.fee-stash.testnet.json` or `.fee-stash.mainnet.json` (owner-only and
  gitignored). Anyone holding that file can spend them, so keep it private.
- **View / clear the pre-signed stash** — what's signed and waiting, per payer;
  remove expired ones or clear them all.
- **Check payer USDC balances** — what each wallet that could pay holds on each
  chain Salt accepts payment on.
- **View fee payments** — the fees an organisation has paid.

All the settings, all optional (`.env.example` has them, commented out):

| Variable | What it does |
|---|---|
| `SALT_FEE_PAYER` | Who pays: `signer`, `wallet`, `account` or `none` (above). |
| `SALT_FEE_PAYER_KEY` | The sponsor wallet's private key, for `wallet`. |
| `SALT_FEE_ACCOUNT_ID` | The paying Salt account's id, for `account`. |
| `SALT_FEE_CHAIN` | The chain id to pay on, e.g. `84532` for Base Sepolia. Unset, the payer pays on its own chain when Salt accepts payment there. |
| `SALT_FEE_MAX_USDC` | Refuse any single payment above this many USDC (default `25`). |
| `SALT_FEE_PRESIGN` | `1` signs each payment up front (as **Toggle pre-signed payment**). |
| `SALT_FEE_PREFLIGHT` | `0` skips the check that the payer holds the fee. |
| `SALT_FEE_STASH` | `0` leaves pre-signed payments in the stash unspent. |

## Docs

- Salt SDK Field Guide: https://salt-space.github.io/salt-fi/field-guide/
  (source: [`docs/field-guide/`](docs/field-guide/index.html))
- SDK docs: https://docs.salt.space
- API reference: https://developer.salt.space/sdk/

## Scripts

- `npm run dev` — run `src/index.ts` directly with `tsx`
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled output

## License

The source code in this repository is licensed under the [Apache License 2.0](./LICENSE).

The licence applies only to the source code contained in this repository. It does not grant rights to Salt's trademarks, branding, proprietary software, hosted services, APIs or other intellectual property.

Use of Salt products or services may be subject to separate terms provided by Salt.
