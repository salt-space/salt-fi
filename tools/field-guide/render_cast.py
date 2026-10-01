"""Render terminal recordings (asciicast v2) into the compact frames the field guide replays.

    pip install pyte
    python3 tools/field-guide/render_cast.py nara-create-org nara-ssh-setup nara-activate

Reads recordings/<name>.cast and writes recordings/<name>.frames.json:
{"w", "h", "duration", "frames": [[t, [[row, html], ...]], ...], "poster": [html per row]}.
pyte (a VT100 emulator) replays the recording; each frame lists only the rows that changed.
Pauses longer than MAX_GAP are shortened so a replay never sits idle on the network, but every
frame is still the real terminal state.
"""
import html
import json
import os
import sys

try:
    import pyte
except ImportError:
    sys.exit("render_cast.py needs pyte: pip install pyte")

HERE = os.path.dirname(os.path.abspath(__file__))
RECORDINGS = os.path.join(HERE, "recordings")
MAX_GAP = 1.4       # seconds; longer pauses are shortened
COALESCE = 0.035    # events closer together than this share a frame

NAMED = {"black", "red", "green", "brown", "blue", "magenta", "cyan", "white",
         "brightblack", "brightred", "brightgreen", "brightbrown", "brightblue",
         "brightmagenta", "brightcyan", "brightwhite"}


def preprocess(data):
    # pyte ignores SGR 2 (faint); approximate dim text with a grey foreground.
    return data.replace("\x1b[2m", "\x1b[2m\x1b[38;5;244m").replace("\x1b[22m", "\x1b[22m\x1b[39m")


def style(ch):
    fg, bg = ch.fg, ch.bg
    if ch.reverse:
        fg, bg = (bg if bg != "default" else "rev-fg"), (fg if fg != "default" else "rev-bg")
    return (fg, bg, ch.bold, ch.underscore)


def span(text, key):
    fg, bg, bold, under = key
    cls, css = [], []
    if fg in NAMED:
        cls.append("f-" + fg)
    elif fg == "rev-fg":
        cls.append("f-rev")
    elif fg != "default" and len(fg) == 6:
        css.append(f"color:#{fg}")
    if bg in NAMED:
        cls.append("g-" + bg)
    elif bg == "rev-bg":
        cls.append("g-rev")
    elif bg != "default" and len(bg) == 6:
        css.append(f"background:#{bg}")
    if bold:
        cls.append("b")
    if under:
        cls.append("u")
    body = html.escape(text, quote=False)
    if not cls and not css:
        return body
    attrs = (f' class="{" ".join(cls)}"' if cls else "") + (f' style="{";".join(css)}"' if css else "")
    return f"<span{attrs}>{body}</span>"


def row_html(screen, y):
    line = screen.buffer[y]
    cursor_here = (not screen.cursor.hidden) and screen.cursor.y == y
    # Trim trailing default-styled blanks, keeping the cursor cell.
    last = screen.columns - 1
    while last >= 0:
        ch = line[last]
        if (ch.data not in (" ", "")) or style(ch) != ("default", "default", False, False) or (cursor_here and screen.cursor.x == last):
            break
        last -= 1
    out, run, run_key = [], [], None
    for x in range(last + 1):
        ch = line[x]
        key = style(ch)
        text = ch.data or " "
        if cursor_here and screen.cursor.x == x:
            if run:
                out.append(span("".join(run), run_key))
                run = []
            out.append(f'<span class="cur">{html.escape(text, quote=False)}</span>')
            run_key = None
            continue
        if key != run_key and run:
            out.append(span("".join(run), run_key))
            run = []
        run_key = key
        run.append(text)
    if run:
        out.append(span("".join(run), run_key))
    if cursor_here and screen.cursor.x > last:
        out.append(" " * (screen.cursor.x - last - 1) + '<span class="cur"> </span>')
    return "".join(out)


def render(cast_path):
    lines = open(cast_path).read().splitlines()
    header = json.loads(lines[0])
    w, h = header["width"], header["height"]
    events = [json.loads(l) for l in lines[1:]]
    screen = pyte.Screen(w, h)
    stream = pyte.Stream(screen)
    prev = [None] * h
    frames, clock, last_real = [], 0.0, 0.0
    i = 0
    while i < len(events):
        t0 = events[i][0]
        chunk = []
        while i < len(events) and events[i][0] - t0 <= COALESCE:
            chunk.append(events[i][2])
            i += 1
        stream.feed(preprocess("".join(chunk)))
        clock += min(t0 - last_real, MAX_GAP)
        last_real = t0
        rows = [row_html(screen, y) for y in range(h)]
        diff = [[y, r] for y, r in enumerate(rows) if r != prev[y]]
        if diff:
            frames.append([round(clock, 3), diff])
            prev = rows
    return {"w": w, "h": h, "duration": round(clock + 1.0, 3), "frames": frames, "poster": prev}


if __name__ == "__main__":
    for name in sys.argv[1:]:
        data = render(os.path.join(RECORDINGS, name + ".cast"))
        out = os.path.join(RECORDINGS, name + ".frames.json")
        with open(out, "w") as f:
            json.dump(data, f, separators=(",", ":"))
        print(f"{name}: {len(data['frames'])} frames, {data['duration']}s")
