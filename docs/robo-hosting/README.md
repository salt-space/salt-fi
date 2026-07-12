# Hosting a Robo Guardian

"Create organisation" in the app can generate a self-hosted install script
(`RoboHost.generateSetupScript()`) for your organisation's Robo Guardians.
**You don't need to install anything yourself first** — the script is a
single file that, run as root on any Ubuntu or Debian machine, installs
Docker, Python, and everything else it needs, generates and encrypts the
robo's seed, and starts the container. You just need a box to run it on.

That box can be almost anything — a VPS, a spare machine on your desk, a
cloud instance. This folder collects platform-specific guides, since the
"generate the script → get it onto the box → run it as root" shape is the
same everywhere, but *how you get it onto the box* (and any quirks of that
platform) differs enough to be worth writing down per-platform as we
validate them.

## Guides

- **[Hostinger VPS](hostinger.md)** — validated end-to-end.
- **Raspberry Pi** — coming soon. Should work in principle (Raspberry Pi OS
  is Debian-based, which is all the script requires), but not yet validated,
  and it's worth confirming the `saltrobo/staging` Docker image actually
  ships an arm64/armhf build before relying on it.
- **[AWS](aws.md)** — the SDK's built-in one-click path
  (`RoboHost.generateCloudFormationUrl()`) is currently broken for TESTNET
  (see the root `claude.md`) and intentionally not wired up in this app.
  The self-hosted script still works fine on a plain EC2 instance today —
  see the AWS guide for what that looks like without the CloudFormation
  convenience.

More guides will be added here as we validate other hosts. If you set one
up somewhere not listed, a PR adding a guide for it is welcome.
