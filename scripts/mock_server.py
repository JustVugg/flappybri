#!/usr/bin/env python3
"""A mock decision server for FlappyBri: GET /v1/models and POST /v1/systemone.

It is NOT a model. It answers with a fixed, hand-written rule, so the game can
be developed, tested and recorded without a colibri server, and nobody should
read its numbers as a model's. The model id it reports says so: mock-policy.

The rule reads the compact JSON line at the end of `state` (the numbers the
page sends) and gives the probability of flapping as a logistic of two things:
how far the hummingbird sits below the middle of the next gap, and how fast it
is falling. Each answer is held back for a random 40 to 60 ms, so the latency
the page measures looks like a fast local engine's.

The request and the reply have the exact shapes colibri's gateway uses
(c/openai_server.py, systemone()), including the x-colibri-elapsed-ms and
x-colibri-queue-wait-ms headers, and it answers a browser from any origin.

    python3 scripts/mock_server.py                 # http://127.0.0.1:8011/v1
    python3 scripts/mock_server.py --port 8011 --latency 40-60 --key sk-test
"""

import argparse
import json
import math
import random
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = "mock-policy"


def flap_probability(numbers):
    """p(flap) from the numbers the page sends. Up is positive: gap_middle > 0
    means the middle of the gap is above the hummingbird; speed < 0 is falling."""
    z = 0.06 * (numbers["gap_middle"] - 12) - 0.225 * numbers["speed"]
    return 1.0 / (1.0 + math.exp(-z))


def read_numbers(state):
    """The last line of the state the page builds is compact JSON."""
    for line in reversed(state.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise ValueError("no JSON line in `state`")


def confidence(values):
    n = len(values)
    return 1.0 if n < 2 else round(max(0.0, (n * max(values) - 1.0) / (n - 1)), 6)


def answer(question, p):
    kind = question.get("type")
    if kind == "noul":
        return {"type": "noul", "noul": round(p, 6)}
    if kind == "choice":
        labels = list((question.get("criteria") or {}).keys())
        if len(labels) < 2:
            raise ValueError("a choice needs at least two labels")
        rest = (1.0 - p) / (len(labels) - 1) if "flap" in labels else 1.0 / len(labels)
        probs = {label: round(p if label == "flap" else rest, 6) for label in labels}
        best = max(probs, key=probs.get)
        return {"type": "choice", "choice": best, "probabilities": probs, "confidence": confidence(list(probs.values()))}
    raise ValueError(f"unsupported question type {kind!r}")


class Handler(BaseHTTPRequestHandler):
    server_version = "flappybri-mock/1"
    protocol_version = "HTTP/1.1"
    # Headers and body go out as two writes; with Nagle on, the body waits for
    # the browser's delayed ACK on a kept-alive connection, about 40 ms on
    # every answer. The latency the page shows should be the mock's own.
    disable_nagle_algorithm = True

    def log_message(self, *args):
        if self.server.verbose:
            super().log_message(*args)

    def cors(self):
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Expose-Headers", "x-request-id, x-colibri-elapsed-ms, x-colibri-queue-wait-ms")
            self.send_header("Access-Control-Max-Age", "600")

    def reply(self, status, body, headers=None):
        data = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.cors()
        self.end_headers()
        self.wfile.write(data)

    def error(self, status, message, param=None):
        self.reply(status, {"error": {"message": message, "type": "invalid_request_error", "param": param, "code": None}})

    def authed(self):
        key = self.server.key
        return not key or self.headers.get("Authorization", "") == f"Bearer {key}"

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            return self.reply(200, {"status": "ok"})
        if not self.authed():
            return self.error(401, "Invalid or missing API key.")
        if path == "/v1/models":
            return self.reply(200, {"object": "list", "data": [
                {"id": MODEL_ID, "object": "model", "created": self.server.created, "owned_by": "flappybri-mock",
                 "input_modalities": ["text"]}]})
        self.error(404, "Not found.")

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not self.authed():
            return self.error(401, "Invalid or missing API key.")
        if path != "/v1/systemone":
            return self.error(404, "Not found.")
        started = time.time()
        try:
            body = json.loads(raw or b"{}")
            state = body.get("state")
            if not isinstance(state, str) or not state.strip():
                return self.error(422, "`state` is required: the content the questions are about.", "state")
            questions = body.get("questions")
            if not isinstance(questions, dict) or not questions:
                return self.error(422, "`questions` must be a non-empty object of id: question.", "questions")
            p = flap_probability(read_numbers(state))
            answers = {qid: answer(question, p) for qid, question in questions.items()}
        except (ValueError, KeyError, TypeError) as error:
            return self.error(422, f"The mock cannot read this request: {error}")
        low, high = self.server.latency
        time.sleep(random.uniform(low, high) / 1000.0)
        self.server.count += 1
        elapsed = round((time.time() - started) * 1000)
        self.reply(200, {
            "model": MODEL_ID,
            "answers": answers,
            "usage": {"input_tokens": max(1, len(state) // 4), "output_tokens": 2 * len(answers)},
        }, {"x-colibri-elapsed-ms": str(elapsed), "x-colibri-queue-wait-ms": "0"})


def parse_latency(text):
    parts = [float(x) for x in text.split("-")]
    low, high = (parts[0], parts[0]) if len(parts) == 1 else (parts[0], parts[1])
    if low < 0 or high < low:
        raise argparse.ArgumentTypeError("latency is MS or LOW-HIGH in ms")
    return low, high


def make_server(host="127.0.0.1", port=8011, latency=(40.0, 60.0), key=None, verbose=False):
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.latency = latency
    server.key = key
    server.verbose = verbose
    server.count = 0
    server.created = int(time.time())
    return server


def start_in_thread(port=0, **kwargs):
    """For scripts/record.py: a mock on its own thread and a free port, returns (server, base_url)."""
    server = make_server(port=port, **kwargs)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    return server, f"http://{host}:{port}/v1"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8011)
    parser.add_argument("--latency", type=parse_latency, default=(40.0, 60.0), help="ms, or LOW-HIGH (default 40-60)")
    parser.add_argument("--key", default=None, help="require this Bearer key, to try the API key field")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    args = parser.parse_args()
    server = make_server(args.host, args.port, args.latency, args.key, args.verbose)
    print(f"mock decision server (a fixed rule, not a model) on http://{args.host}:{args.port}/v1", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
