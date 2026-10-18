import http.server
import ssl

port = 443
server_address = ('0.0.0.0', port)
httpd = http.server.HTTPServer(server_address, http.server.SimpleHTTPRequestHandler)

# Podpięcie certyfikatu SSL
httpd.socket = ssl.wrap_socket(httpd.socket,
                               server_side=True,
                               certfile='server.pem',
                               ssl_version=ssl.PROTOCOL_TLS)

print(f"Serwer HTTPS działa pod adresem: https://localhost:{port}")
httpd.serve_forever()