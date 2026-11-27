# Dev server for Harvest Haven: like `python -m http.server`, but tells the browser not to cache,
# so edited game files show up on a normal reload. PUT /recordings/<name>.webm saves a recording
# or a .jpg still (the trailer recorder in src/trailer.js uploads its video here).
import http.server, os, re, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_PUT(self):
        m = re.fullmatch(r'/recordings/([\w-]+\.(?:webm|jpg))', self.path)
        if not m:
            self.send_error(403)
            return
        os.makedirs('recordings', exist_ok=True)
        n = int(self.headers.get('Content-Length', 0))
        if n > 300 * 1024 * 1024:
            self.send_error(413)
            return
        with open(os.path.join('recordings', m.group(1)), 'wb') as f:
            f.write(self.rfile.read(n))
        self.send_response(201)
        self.end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCache).serve_forever()
