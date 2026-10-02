# FlappyBri

<p align="center">
  <img src="docs/media/flappybri.gif" width="760" alt="FlappyBri: colibri's hummingbird flies between pipes while the panel on the right shows each decision, its probability, the latency and the decisions per second">
</p>

<p align="center"><em>Recorded against a mock decision server (a fixed rule in <code>scripts/mock_server.py</code>, not a model); a recording with a real colibri model will replace it.</em></p>

FlappyBri is [colibri](https://github.com/JustVugg/colibri)'s hummingbird game.
The hummingbird of colibri's logo flies between pipes, and touching a pipe,
the ground or the top edge ends the round. You can fly it yourself, or hand
the controls to the model running in colibri: at every step the page asks it,
through colibri's `POST /v1/systemone` API, whether to flap, and the panel next
to the game shows how fast it answers and how sure it is.

It is a small demo you can watch: the speed and the calibration of a decision
model running on your own machine, turned into something that flies.

| Dark | Light | Phone |
| --- | --- | --- |
| ![Model mode, dark theme, mid-flight](docs/media/desktop-dark.png) | ![Model mode, light theme, mid-flight](docs/media/desktop-light.png) | ![Phone width, mid-flight](docs/media/phone.png) |

*All three recorded against a mock decision server; a recording with a real colibri model will replace them.*

## How it works

- **The page describes the screen.** At each step it writes where the
  hummingbird is relative to the next gap: how far above or below the middle,
  where the top and bottom edges are, how far ahead the gap starts (or that it
  is inside it), how fast it is rising or falling, and the distance to the
  ground and the top. First in a few sentences, then the same numbers as compact
  JSON. One line of rules leads, so an engine that reuses a cached prefix reads
  only the part that changed.
- **It asks one typed question.** The description goes to `POST /v1/systemone`
  as `state`, with one question: by default a `noul` ("Should the hummingbird
  flap its wings now?"), or a `choice` between `flap` and `glide`.
- **It reads p(flap).** The reply carries the probability of flapping. Above
  the threshold (0.5 unless you move it) the hummingbird flaps; otherwise it
  glides.
- **One request in flight.** The next question goes out only when the last
  answer has been used, so the model is never asked more than it can answer.
- **Latency is visible as play.** The game does not wait for the model: while
  it reads, the pipes keep coming. The answer applies on the step it arrives,
  to the screen as it is by then, the way a slow reflex would, and the panel
  says how many steps late that was.
- **A slower model can still play.** "Match the model's pace" slows the game
  so that about two steps pass while the model decides, from real time down to
  a hundredth of it. One step of physics is always the same; only the number of
  steps per second changes, and the speed the game actually runs at is shown.

The panel shows the model's name, the last decision with p(flap) against the
threshold, the latency of each decision (last, average and p95 over the last
100, with a sparkline, plus the engine's own time when the browser can read
it), decisions per second, steps per decision, how late each answer landed,
and the score and best (kept apart for you and for the model). "What the model
reads" shows the exact last request.

The physics are deterministic: 60 steps a second of game time, a seeded random
generator for the gaps, the same round for the same seed and the same flaps.

## The honest note

The model is not trained to play this game. At every step it reads a short
description of the screen and decides, so what you are watching is the speed
and the calibration of a decision model running locally, not a game-playing
agent. A model that flies well here is fast and well calibrated on a simple
question; a model that crashes may still be a good model that is slow, or one
whose probabilities are not where the threshold expects them.

## Play it with colibri

### 1. Get colibri

Follow colibri's README, section [Get started](https://github.com/JustVugg/colibri#get-started):
it covers the program (a prebuilt release or a build from source), the model,
and `coli`, the launcher that runs everything.

FlappyBri needs a colibri that has the `POST /v1/systemone` route. It is on
colibri's `dev` branch and comes with the next release; until then, build from
source on `dev`:

```bash
git clone https://github.com/JustVugg/colibri && cd colibri
git checkout dev
cd c && ./setup.sh
```

With an older colibri the page tells you so: "This server has no
/v1/systemone route: update colibri."

### 2. Start a model with `coli serve`

```bash
./coli serve --model /path/to/model          # listens on http://127.0.0.1:8000/v1
```

Which models can play: any model colibri serves can answer `/v1/systemone`,
except an image model. A language model answers through calibrated option
scoring: it reads the state and the question and scores the possible answers,
without generating text. That works on every family colibri runs, but it is the
slow path for a game, and how slow depends on the model and the machine. With
"Match the model's pace" on, the game slows down to the model rather than the
other way round. Native decision models such as Laya are coming to colibri and
will be the fast path.

### 3. Run FlappyBri

You need [Node.js](https://nodejs.org/) 20.19 or newer.

```bash
git clone https://github.com/JustVugg/flappybri && cd flappybri
npm install
npm run dev                                  # http://localhost:5173
```

Or build it once and serve the files:

```bash
npm run build                                # writes dist/
npm run preview                              # http://localhost:4173, see CORS below
```

`dist/` is a static site with relative paths: any static file server works,
from any folder. Serve it over http rather than opening `index.html` from disk.

### 4. Connect and let the model play

1. Open the page. The connection panel at the top of the controls holds the
   colibri server URL, `http://127.0.0.1:8000/v1` by default, and an optional
   API key (the one given to `coli serve --api-key` or `COLI_API_KEY`).
2. Press **Test connection**. It calls `GET /models` on the server and shows
   the model id, for example "Connected: qwen36 answered in 14 ms." The URL and
   the key are saved in this browser (localStorage) and tested again each time
   the page opens.
3. Choose **The model plays** and press **Start**.

If something is wrong, the panel says what: no answer (the server is down, or
the browser blocked a cross-origin request, see below), a missing or wrong key,
an address that is not a colibri `/v1`, or an image model. If the model fails
during a round, the page says why and hands the controls back to you.

### Calling colibri from another origin (CORS)

The page and colibri run on different origins (`localhost:5173` and
`127.0.0.1:8000`), so the browser checks colibri's cross-origin answers. This
is what `coli serve` does today, read from its gateway (`c/openai_server.py`)
and checked against it:

- **Preflight:** it answers `OPTIONS` with 204 and the CORS headers, without
  asking for the key.
- **Allowed origins:** by default `http://localhost:5173`,
  `http://127.0.0.1:5173`, `http://localhost:8000` and `http://127.0.0.1:8000`
  (plus colibri's desktop app). For an allowed origin it sends
  `Access-Control-Allow-Origin` with that origin; for any other it sends no CORS
  headers, and the browser blocks the reply.
- **Authorization:** allowed. `Access-Control-Allow-Headers` lists
  `Authorization` and `Content-Type`, so a key works cross-origin.
- **Exposed headers:** `x-request-id`, `x-colibri-queue-wait-ms` and
  `Retry-After`, but not `x-colibri-elapsed-ms`, so cross-origin the panel
  cannot show the engine's own time per decision. Everything else works.

What to do:

- **`npm run dev` on port 5173: nothing.** Stock `coli serve` already allows
  it. The dev server refuses to start on another port rather than move to one
  colibri would not allow.
- **Any other origin** (`npm run preview` on 4173, a static server, another
  port): start colibri with that origin allowed. `--cors-origin` replaces the
  default list, so repeat it for every origin you use:

  ```bash
  ./coli serve --model /path/to/model \
    --cors-origin http://localhost:4173 --cors-origin http://localhost:5173
  ./coli serve --model /path/to/model --cors-origin '*'     # any origin
  ```

- **Or skip CORS: use the proxy.** `npm run dev` and `npm run preview` forward
  `/v1` to colibri, so the page and the API share one origin. Set the server URL
  in the panel to `/v1`. The proxy sends to `http://127.0.0.1:8000` unless you
  set `COLIBRI_URL`:

  ```bash
  COLIBRI_URL=http://127.0.0.1:8001 npm run dev
  ```

  Through the proxy the engine's own time is visible too.

**colibri on another machine.** `coli serve` refuses a non-loopback bind
without a key, and checks the `Host` header the browser sends. Bind with
`--host` and `--api-key`, and if the browser reaches the server by a name or
address other than the one it binds to, add `--allowed-host <that name>`.

**A note on latency.** With today's gateway, a browser calling `coli serve`
directly can see about 40 ms more per decision than the engine spends: the
reply's headers and body go out as two writes, and on a kept-alive connection
the second waits for a delayed TCP acknowledgement. That time is the
connection's, not the model's. Through the `/v1` proxy the wait does not
happen, so use it when you want to see the fastest numbers.

## The request it sends and the field it reads

Every step, `POST {server URL}/systemone` with `Content-Type: application/json`
and, if you set a key, `Authorization: Bearer <key>`. With the default question:

```json
{
  "model": "qwen36",
  "state": "FlappyBri: a hummingbird flies right through the gaps between pipes. Touching a pipe, the ground or the top edge ends the game. A flap sends it up about 60 px over 18 frames; without one it falls faster every frame.\nNow: the hummingbird is 56 px below the middle of the next gap and rising at 6.6 px per frame. The next gap starts 331 px ahead and is 150 px tall: its top edge is 131 px above the hummingbird and its bottom edge 19 px below it. The ground is 316 px below and the top edge 224 px above.\nHeights in px relative to the hummingbird and speed in px per frame, up is positive:\n{\"gap_middle\":56,\"gap_top\":131,\"gap_bottom\":-19,\"speed\":6.6,\"gap_ahead\":331,\"in_gap\":false,\"gap_height\":150,\"ground\":-316,\"top\":224}",
  "questions": {
    "flap": {
      "type": "noul",
      "instructions": "Should the hummingbird flap its wings now?"
    }
  }
}
```

The reply, and the field the game reads, `answers.flap.noul`, the probability
of yes:

```json
{"model": "qwen36", "answers": {"flap": {"type": "noul", "noul": 0.75026}}, "usage": {"input_tokens": 133, "output_tokens": 2}}
```

With the "Flap or glide" question, `questions` is:

```json
{
  "move": {
    "type": "choice",
    "instructions": "What should the hummingbird do now?",
    "criteria": {
      "flap": "beat the wings once: it rises about 60 px over the next 18 frames",
      "glide": "do nothing: it keeps falling, a little faster every frame"
    }
  }
}
```

and the game reads `answers.move.probabilities.flap`:

```json
{"model": "qwen36", "answers": {"move": {"type": "choice", "choice": "glide", "probabilities": {"flap": 0.401312, "glide": 0.598688}, "confidence": 0.197375}}, "usage": {"input_tokens": 163, "output_tokens": 2}}
```

These are real exchanges with colibri's gateway code, captured from the page;
the probabilities came from the gateway's test engine, not from a model. The
`model` field of the request is the id the connection test found; colibri
answers with the model it runs. The page also reads the `x-colibri-elapsed-ms`
response header when the browser can see it (see CORS above).

## Controls and settings

| | |
| --- | --- |
| **Space, click or tap** | Flap when you play; start or resume otherwise |
| **P** | Pause and resume (a hidden tab pauses too) |
| **R** | Restart |
| **Who plays** | You play, or The model plays |
| **Question** | Yes or no: a `noul` question, two one-token answers, the lightest request. Flap or glide: a `choice` that says what each move does, a few more tokens to read |
| **Flap above** | The threshold, 0.05 to 0.95 (default 0.5): the model flaps when p(flap) is strictly above it |
| **Game speed** | From 0.01x to 1x of real time. Slower game time gives a slower model time to react |
| **Match the model's pace** | On by default in model mode: sets the speed so that about two steps pass while the model decides |
| **Start the next round by itself** | In model mode, a new round starts 1.6 s after a crash |

The settings, the language and the theme are remembered in the browser, and the
best scores are kept apart for you and for the model. The page follows the
system's dark or light theme until you pick one, works at phone widths down to
320 px, and with reduced motion requested it keeps only the motion the game
needs (no drifting hills, wing beats, tilt or crash flash). It speaks English,
Italian, German, Indonesian and Chinese (simplified and traditional).

## Try it without colibri

`scripts/mock_server.py` is a mock decision server: the same routes, request
and reply shapes as colibri's gateway, answered by a fixed rule (the
probability of flapping grows as the hummingbird sits below the middle of the
gap and as it falls faster), held back 40 to 60 ms per answer. It is not a
model and calls itself `mock-policy`.

```bash
npm run mock                                 # http://127.0.0.1:8011/v1
```

Then set the server URL in the panel to `http://127.0.0.1:8011/v1`. It allows
any origin, and `--key` makes it require an API key.

## Development

```bash
npm test                 # vitest: physics, the pilot, statistics, the API client, the connection panel, i18n
npm run build            # type check and production build into dist/
npm run dev              # dev server on http://localhost:5173
```

The game is plain TypeScript in `src/lib/flappybri/`: `game.ts` (world and
physics), `pilot.ts` (the state the model reads, the question, one request at a
time), `stats.ts` (latency window, p95, decisions per second) and `render.ts`
(the canvas). `src/FlappyBri.tsx` is the loop and the panel,
`src/ConnectionPanel.tsx` and `src/lib/connection.ts` the connection panel,
`src/lib/api.ts` the two HTTP calls.

### Recording the screenshots and the GIF

`scripts/record.py` makes `docs/media/desktop-dark.png`, `desktop-light.png`,
`phone.png` and `flappybri.gif` with the model playing. It needs Python 3 with
[Playwright](https://playwright.dev/python/) (`pip install playwright` and
`playwright install chromium`) and Pillow.

```bash
npm run build
python3 scripts/record.py                                    # against the mock
python3 scripts/record.py --server http://127.0.0.1:8000/v1  # against coli serve
python3 scripts/record.py --server http://127.0.0.1:8000/v1 --key "$COLI_API_KEY" --timeout 300
```

It serves `dist/` itself and forwards `/v1` to `--server`, so no CORS setting
is needed. A slow model needs a longer `--timeout`, and `--seconds` sets the
length of the GIF. When the media come from a real model, change the captions
above to say which one.

## License

Apache-2.0, see [LICENSE](LICENSE). The hummingbird is colibri's logo, by the
same author and under the same license. The pixel font, Bytesized, is under
the SIL Open Font License 1.1 ([src/assets/fonts/OFL.txt](src/assets/fonts/OFL.txt)).
