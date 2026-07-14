# Hosting a Robo Guardian

"Create organisation" in the app can set up your organisation's Robo
Guardians one of two ways: a self-hosted install script
(`RoboHost.generateSetupScript()`) or an AWS CloudFormation one-click launch
URL (`RoboHost.generateCloudFormationUrl()`). **Either way you don't need to
install anything yourself first** — both paths install Docker, Python, and
everything else needed, generate and encrypt the robo's seed, and start the
container automatically. The self-hosted script just needs a box to run it
on (root shell); CloudFormation needs nothing beyond an AWS console login.

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
- **[AWS](aws.md)** — the SDK's built-in one-click CloudFormation path, fixed
  for TESTNET as of SDK `0.0.27` (see the root `claude.md`) and now wired up
  as an option in "Create organisation". Template contents verified correct;
  no one's launched a real stack from it yet in this app. The self-hosted
  script also works fine on a plain EC2 instance if you'd rather not use it.

More guides will be added here as we validate other hosts. If you set one
up somewhere not listed, a PR adding a guide for it is welcome.
