# Field guide build

`docs/field-guide/index.html`, served at
<https://salt-space.github.io/salt-fi/field-guide/>, is generated. Edit the
sources here, then rebuild:

```
python3 tools/field-guide/build.py
```

- `template.html` is the page: copy, styles, the diagram and the replay
  player. `{{POSTER name}}`, `{{DURATION name}}` and `{{DATA name}}` mark
  where each recording goes.
- `recordings/<name>.cast` are the terminal sessions, in asciicast v2 format.
- `recordings/<name>.frames.json` are those sessions rendered into frames.
  Regenerate them after changing a `.cast`:

  ```
  pip install pyte
  python3 tools/field-guide/render_cast.py nara-create-org nara-ssh-setup nara-activate
  ```

- `build.py` inlines the frames and picks each replay's poster, the frame shown
  before it plays. `--fragment <file>` also writes the page without the
  document wrapper, for hosts that add their own.

The recordings come from a testnet demo. Check any new recording for secrets
before committing it: robo setup scripts embed a one-time setup code, and
server addresses should only appear as `$VPS`.
