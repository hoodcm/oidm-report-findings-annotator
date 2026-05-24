#!/usr/bin/env python3
"""Test-only static server with SO_REUSEADDR + no-cache headers.

The repo's primary `serve.py` is for interactive development. Playwright
spins up and tears down the server many times per session, which leaves
the listening port in TIME_WAIT for ~60 seconds — `serve.py` rejects the
next bind, so consecutive test runs fail with EADDRINUSE.

`allow_reuse_address = True` makes the socket reusable inside the kernel's
TIME_WAIT window. Kept as a separate script so the choice of TCP behavior
doesn't leak into the dev workflow.
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8502
# Serve from the repo root regardless of where this script is invoked.
os.chdir(os.path.join(os.path.dirname(__file__), '..', '..'))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


with ReusableTCPServer(('', PORT), NoCacheHandler) as httpd:
    print(f'Serving http://localhost:{PORT} (no-cache, SO_REUSEADDR)')
    httpd.serve_forever()
