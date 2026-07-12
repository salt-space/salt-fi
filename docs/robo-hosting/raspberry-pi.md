# Hosting a Robo Guardian on a Raspberry Pi

**Not yet validated** — this is a placeholder, not a tested guide.

In principle this should work the same way as any other Ubuntu/Debian host
(Raspberry Pi OS is Debian-based, which is all `RoboHost.generateSetupScript()`
requires), following the same shape as the [Hostinger guide](hostinger.md):
generate the script from the app, get it onto the Pi, run it as root.

Before relying on this, worth confirming:
- The `saltrobo/staging` Docker image actually publishes an `arm64`/`armhf`
  build — Docker Hub images aren't always multi-arch, and this hasn't been
  checked yet.
- Getting the script onto the Pi is simplest via `scp` if it's on your local
  network (`scp robo-setup-<org-id>.sh pi@<pi-ip>:~`) rather than needing
  the browser-terminal paste workaround from the Hostinger guide.

Once someone's actually run this end-to-end on a Pi, replace this file with
the real steps (and any gotchas hit along the way).
