#!/usr/bin/env python3
"""Screenshots and a GIF of FlappyBri with the model playing, against any server.

    npm run build
    python3 scripts/record.py                                  # the built-in mock
    python3 scripts/record.py --server http://127.0.0.1:8000/v1 --timeout 300

Writes, in --out (docs/media by default):

    desktop-dark.png   model mode, dark theme, mid-flight
    desktop-light.png  the same in the light theme
    phone.png          a phone-width screen, mid-flight
    flappybri.gif      about 10 s of the model playing, with the HUD

Without --server it starts scripts/mock_server.py, a fixed hand-written rule
that is not a model, and the media say so. With --server it records whatever
model that server runs.

The page is served from dist/ by a small local server that also forwards /v1
to --server, so the page and the API share one origin and no cross-origin
setting is needed on the colibri side. --direct makes the page call --server
itself instead (the server must then allow the page's origin).

Needs Python Playwright with Chromium (`pip install playwright` and
`playwright install chromium`) and Pillow.
"""

import argparse
import base64
import io
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))


# ---- the page, served from dist/, with /v1 forwarded --------------------------------

class PageHandler(SimpleHTTPRequestHandler):
    upstream = None          # server root the /v1 requests go to, e.g. http://127.0.0.1:8000
    disable_nagle_algorithm = True   # no 40 ms stall between headers and body on a kept-alive connection

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {name: value for name, value in self.headers.items()
                   if name.lower() in ("authorization", "content-type", "accept")}
        request = urllib.request.Request(self.upstream + self.path, data=body, headers=headers, method=self.command)
        try:
            response = urllib.request.urlopen(request, timeout=120)
        except urllib.error.HTTPError as error:
            response = error
        except OSError as error:
            data = json.dumps({"error": {"message": f"record.py could not reach {self.upstream}: {error}"}}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        data = response.read()
        self.send_response(response.status if hasattr(response, "status") else response.code)
        for name, value in response.headers.items():
            if name.lower() in ("content-type", "x-colibri-elapsed-ms", "x-colibri-queue-wait-ms", "x-request-id"):
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.upstream and self.path.startswith("/v1/"):
            return self.forward()
        super().do_GET()

    def do_POST(self):
        if self.upstream and self.path.startswith("/v1/"):
            return self.forward()
        self.send_error(404)


def serve_page(dist, upstream):
    handler = partial(type("Handler", (PageHandler,), {"upstream": upstream}), directory=str(dist))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/"


# ---- driving the page -----------------------------------------------------------------

# The page's settings (src/lib/settings.ts, version 2): model mode, the
# question and the style from the command line, "Match the model's pace" on.
SETTINGS = {"version": 2, "mode": "model", "form": "where", "style": "words", "threshold": 0.5, "speed": 8,
            "match": True, "autoRestart": True}


def prepare(context, base_url, key, theme, args):
    """The page's own storage, set before it loads: the connection, model mode, the theme."""
    settings = dict(SETTINGS, form=args.form, style=args.style)
    values = {
        "flappybri.connection": json.dumps({"baseUrl": base_url, "apiKey": key}),
        "flappybri.settings": json.dumps(settings),
        "flappybri.theme": theme,
        "flappybri.locale": "en",
    }
    context.add_init_script("(() => { try { const v = %s; for (const k in v) localStorage.setItem(k, v[k]) } catch (e) {} })()"
                            % json.dumps(values))


def score(page):
    return int(page.locator(".fb-tile strong").first.inner_text().strip() or 0)


def hud(page):
    """The panel's numbers as the page shows them: score, best, latency, decisions per second."""
    tiles = page.locator(".fb-tile")
    parts = []
    for i in range(tiles.count()):
        text = " ".join(tiles.nth(i).inner_text().split())
        parts.append(text)
    return " | ".join(parts)


def phase(page):
    """playing, unless the overlay says otherwise."""
    overlay = page.locator(".fb-overlay")
    return overlay.get_attribute("data-phase") if overlay.count() else "playing"


def start_model(page, timeout_s):
    try:
        page.wait_for_selector(".conn[data-state=ok]", timeout=timeout_s * 1000)
    except Exception:
        text = page.locator(".conn-status").inner_text() if page.locator(".conn-status").count() else "(no panel)"
        raise SystemExit(f"the page could not connect: {text}")
    page.wait_for_function("() => !document.querySelector('.fb-primary')?.disabled", timeout=timeout_s * 1000)
    page.locator(".fb-toolbar .fb-primary").click()
    page.wait_for_function("() => document.querySelectorAll('.fb-decision-row strong[data-flap]').length > 0",
                           timeout=timeout_s * 1000)


def wait_mid_flight(page, at_least, timeout_s):
    """Until the model has scored `at_least` and is flying, or the time is up."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if phase(page) == "playing" and score(page) >= at_least:
            page.wait_for_timeout(350)
            if phase(page) == "playing":
                return True
        page.wait_for_timeout(120)
    return phase(page) == "playing"


def shoot(browser, url, base_url, key, out, name, theme, viewport, scale, mobile, args):
    context = browser.new_context(viewport=viewport, device_scale_factor=scale, is_mobile=mobile, has_touch=mobile,
                                  locale="en-US", color_scheme=theme)
    prepare(context, base_url, key, theme, args)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url, wait_until="networkidle")
    start_model(page, args.timeout)
    ok = wait_mid_flight(page, args.score, args.timeout)
    path = out / name
    page.screenshot(path=str(path))
    print(f"{path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}: score {score(page)}, "
          f"{'mid-flight' if ok else 'not mid-flight (the model kept crashing)'}")
    print(f"  {hud(page)}")
    context.close()
    return errors


def record_gif(browser, url, base_url, key, out, args):
    from PIL import Image

    view = {"width": 920, "height": 900}
    context = browser.new_context(viewport=view, device_scale_factor=1,
                                  locale="en-US", color_scheme="dark")
    prepare(context, base_url, key, "dark", args)
    page = context.new_page()
    page.goto(url, wait_until="networkidle")
    # The GIF shows the game and the live part of the HUD; the settings below
    # it would only be cut in half by the crop.
    page.add_style_tag(content=".fb-settings,.fb-note,.fb-reads,.fb-hud>.fb-help{display:none!important}")
    start_model(page, args.timeout)
    page.wait_for_timeout(1200)

    box = page.locator(".fb-page").bounding_box()
    stage = page.locator(".fb-stage").bounding_box()
    spark = page.locator(".fb-spark").bounding_box()
    bottom = max(stage["y"] + stage["height"], (spark["y"] + spark["height"]) if spark else 0) + 12
    crop = (int(box["x"]) - 12, int(box["y"]) - 12,
            int(min(view["width"], box["x"] + box["width"] + 12)), int(min(view["height"], bottom)))

    # Keep at most --fps frames a second, each lasting until the next one,
    # chosen as they arrive: a long time-lapse would not fit in memory whole.
    frames = []
    step = 1.0 / args.fps
    cdp = context.new_cdp_session(page)

    def on_frame(params):
        stamp = params["metadata"].get("timestamp", time.time())
        if not frames or stamp - frames[-1][0] >= step * 0.999:
            frames.append((stamp, params["data"]))
        try:
            cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
        except Exception:
            pass

    cdp.on("Page.screencastFrame", on_frame)
    cdp.send("Page.startScreencast", {"format": "png", "everyNthFrame": 1})
    page.wait_for_timeout(int(args.seconds * 1000))
    cdp.send("Page.stopScreencast")
    print(f"  after the GIF: {hud(page)}")
    page.wait_for_timeout(200)
    context.close()
    if len(frames) < 10:
        raise SystemExit(f"only {len(frames)} frames captured")

    picked = frames
    width = args.gif_width
    images = []
    for stamp, data in picked:
        image = Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB").crop(crop)
        height = round(image.height * width / image.width)
        images.append(image.resize((width, height), Image.LANCZOS))
    durations = [max(20, round((picked[i + 1][0] - picked[i][0]) * 1000 / args.speedup)) for i in range(len(picked) - 1)]
    durations.append(durations[-1] if durations else 80)

    # One palette for every frame, from a sample of them, so colors do not
    # flicker between frames; plus a swatch of the logo's five colors, which
    # cover too few pixels to win a place in the palette on their own.
    rows = 4
    swatch = 48
    sample = Image.new("RGB", (width, images[0].height * rows + swatch))
    for i, index in enumerate(range(0, len(images), max(1, len(images) // rows))):
        if i < rows:
            sample.paste(images[index], (0, images[0].height * i))
    for i, color in enumerate(("#d75fd7", "#5fd7d7", "#ff8700", "#00afaf", "#ffffff")):
        sample.paste(Image.new("RGB", (width // 5, swatch), color), (i * (width // 5), images[0].height * rows))
    palette = sample.quantize(colors=args.colors, method=Image.Quantize.MEDIANCUT)
    quantized = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image in images]
    path = out / "flappybri.gif"
    quantized[0].save(path, save_all=True, append_images=quantized[1:], duration=durations, loop=0,
                      optimize=True, disposal=1)
    seconds = sum(durations) / 1000
    size = path.stat().st_size
    lapse = f" (a {args.speedup:g}x time-lapse of {seconds * args.speedup:.0f} s)" if args.speedup != 1 else ""
    print(f"{path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}: {len(quantized)} frames, "
          f"{seconds:.1f} s{lapse}, {width}x{quantized[0].height}, {size / 1e6:.2f} MB")
    return size


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", help="the colibri server's /v1 URL; default: start the mock decision server")
    parser.add_argument("--key", default=os.environ.get("COLI_API_KEY", ""), help="API key, if the server wants one")
    parser.add_argument("--direct", action="store_true", help="let the page call --server itself instead of through /v1 here")
    parser.add_argument("--out", default=str(ROOT / "docs" / "media"))
    parser.add_argument("--dist", default=str(ROOT / "dist"))
    parser.add_argument("--build", action="store_true", help="run npm run build first")
    parser.add_argument("--only", choices=("shots", "gif"), help="make only the screenshots or only the GIF")
    parser.add_argument("--seconds", type=float, default=10.0, help="length of the GIF (default 10)")
    parser.add_argument("--fps", type=float, default=15.0, help="GIF frames per second at most (default 15)")
    parser.add_argument("--speedup", type=float, default=1.0,
                        help="play the GIF this many times faster than it was recorded, for a slow model (default 1)")
    parser.add_argument("--gif-width", type=int, default=760)
    parser.add_argument("--colors", type=int, default=96)
    parser.add_argument("--score", type=int, default=2, help="score to reach before a screenshot (default 2)")
    parser.add_argument("--timeout", type=float, default=60.0, help="seconds to wait for each step (default 60)")
    parser.add_argument("--latency", default="40-60", help="the mock's latency in ms, LOW-HIGH (default 40-60)")
    parser.add_argument("--form", default="where", choices=("low", "where", "danger", "noul", "choice"),
                        help="the question the page asks (default where: where is the hummingbird compared with the opening?)")
    parser.add_argument("--style", default="words", choices=("words", "numbers"), help="how the page describes the screen")
    args = parser.parse_args()

    from playwright.sync_api import sync_playwright

    dist = Path(args.dist)
    if args.build or not (dist / "index.html").exists():
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    mock = None
    if args.server:
        server_url = args.server.rstrip("/")
    else:
        from mock_server import parse_latency, start_in_thread
        mock, server_url = start_in_thread(latency=parse_latency(args.latency), key=args.key or None)
        args.direct = True
        print(f"mock decision server (a fixed rule, not a model) at {server_url}")
    upstream = None if args.direct else server_url[: -len("/v1")] if server_url.endswith("/v1") else server_url
    page_server, url = serve_page(dist, upstream)
    base_url = server_url if args.direct else "/v1"
    print(f"page at {url}, calling {base_url}" + ("" if args.direct else f" (forwarded to {server_url})"))

    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            if args.only != "gif":
                errors += shoot(browser, url, base_url, args.key, out, "desktop-dark.png", "dark",
                                {"width": 1280, "height": 860}, 2, False, args)
                errors += shoot(browser, url, base_url, args.key, out, "desktop-light.png", "light",
                                {"width": 1280, "height": 860}, 2, False, args)
                errors += shoot(browser, url, base_url, args.key, out, "phone.png", "dark",
                                {"width": 390, "height": 844}, 2, True, args)
            if args.only != "shots":
                record_gif(browser, url, base_url, args.key, out, args)
        finally:
            browser.close()
            page_server.shutdown()
            if mock:
                mock.shutdown()
    if errors:
        print("page errors:", *errors, sep="\n  ")
        sys.exit(1)


if __name__ == "__main__":
    main()
