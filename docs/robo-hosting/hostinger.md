# Hosting a Robo Guardian on a Hostinger VPS

Validated end-to-end on an Ubuntu Hostinger VPS.

## 1. Generate the script

In `salt-fi`, run the app (`npm run dev`), pick **Create organisation**, and
say yes when asked to set up Robo Guardians. You'll get a file like
`robo-setup-<org-name>-<org-id>.sh` in your project folder. It embeds a secret
OTP (one-time password) — treat it like a credential (don't paste it anywhere public, delete it
once you're done with it).

## 2. Get root on the VPS

Hostinger's hPanel gives you a browser-based terminal for the VPS — no SSH
client needed. Open it; you should land at a `root@...#` prompt directly.

## 3. Get the script onto the box

If you have `scp`/SSH access set up separately, that's simplest:
```
scp robo-setup-<org-name>-<org-id>.sh root@<vps-ip>:~
```

If you're only using the browser terminal, you need to paste the script's
contents in — and **this is the one real gotcha**: don't do it via
```
cat > robo-setup.sh << 'EOF'
...
EOF
```
The script itself writes several of its own files the same way internally
(it contains its own nested `cat > ... << 'EOF' ... EOF` blocks). Bash
doesn't understand "nesting" here — your outer heredoc closes at the
*first* bare `EOF` it encounters, which is partway through the script, not
at the end. Everything after that point then gets executed directly as
live shell commands instead of being safely written to the file — parts of
the script silently run out of order, without their prerequisites (Docker,
Python packages) actually installed yet, producing a confusing wall of
errors (`ModuleNotFoundError`, `Command 'docker' not found`, stray cron
jobs pointing at files that were never created, etc.).

Use an editor instead — it just inserts text, it doesn't parse shell syntax:
```
nano robo-setup.sh
```
Paste the full script contents in, then `Ctrl+O` then `Enter` to save,
`Ctrl+X` to exit.

## 4. Run it

```
chmod +x robo-setup.sh
./robo-setup.sh
```

It installs Docker, Python and its dependencies, generates a seed on the
host, encrypts it to your public key, uploads the encrypted backup to Salt,
pulls `saltrobo/staging:latest`, starts the container (named `robos`, no
ports published to the host), and registers a cron job that checks for
image updates every 5 minutes.

## 5. Verify

```
docker ps
docker logs -f robos
```
Then back in `salt-fi`, run **Check robo status** for the organisation and
confirm it shows online.

## Restarting the robo

If "Check robo status" shows it online but a signing/keygen ceremony hangs
indefinitely at the `signing`/`presence` stage with everyone showing as
joined — the ceremony never progresses to broadcasting — that's a sign the
robo is *reachable* but failing at something further in (this matched a
known intermittent expired-token issue on the Salt side as of this
session; ask in Slack if it's still around). A restart has fixed it before:

```
docker restart robos
```

Then confirm it actually reconnected — either check the logs:
```
docker logs --tail 20 robos
```
(want to see `App is running on port 4300` and the 3 signer addresses, not
a repeated reconnect/error loop), or just check **Check robo status** in
the app again. Retry whatever you were doing fairly soon after — this kind
of fix has previously only held for a limited window (~20 minutes) before
recurring, until the underlying issue is actually resolved upstream.

## Running a second organisation's robo on the same VPS

The script hardcodes the container name (`robos`) and working directory
(`/salt/robos`) — it isn't parameterized per-organisation. Running it a
second time on a host that already has a robo from a different org will
collide: `docker run --name robos` fails outright since the name's already
taken, and it'll also want to reuse the same `/salt/robos` directory.

Simplest fix: put the second organisation's robo on a separate VPS. If you'd
rather keep everything on one box, you'd need to hand-edit a copy of the
script — give it a different `--name`, a different `WORK_DIR`, and make the
matching substitutions inside the embedded `update_docker.sh` and cron line
so the auto-updater targets the right container/directory.
