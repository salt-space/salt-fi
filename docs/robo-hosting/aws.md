# Hosting a Robo Guardian on AWS

**One-click via CloudFormation** (recommended): in "Create organisation",
choose "AWS CloudFormation" when setting up Robo Guardians, pick a stack
name, and open the generated URL while signed into the AWS console. It
launches a pre-filled stack that installs Docker, generates and encrypts
the robo's seed, and starts the container automatically — no server access
needed at all.

This was broken for TESTNET through SDK `0.0.26` — `generateCloudFormationUrl()`
pointed at a template hardcoding the mainnet API domain (`app.salt.space`)
and Arbitrum One's chain ID (`42161`) instead of TESTNET's
(`testnet.salt.space`, `421614`), so the container would boot but never
authenticate. **Fixed as of SDK `0.0.27`** — see the root `claude.md` for how
this was verified (the template is now environment-namespaced and its
contents were checked directly). No one's launched a real stack from it in
this app yet, so if you hit anything unexpected, compare against the
self-hosted path below and flag it.

## Self-hosted (manual EC2)

If you'd rather not use CloudFormation, "Create organisation" can also
generate the same self-hosted install script used on other platforms.
Launch an Ubuntu or Debian EC2 instance, get a root shell on it (SSH with
your key pair, or EC2 Instance Connect from the console), then follow the
same steps as the [Hostinger guide](hostinger.md) from "get the script onto
the box" onward.
