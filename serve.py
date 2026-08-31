# Local dev server for app/ with cache disabled, so data refreshes are always picked up.
import http.server


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory="app", **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", 8790), Handler).serve_forever()
