"""Configure the private HTTPS route that the Station talks to (run on the server).

Set QUASAR_DOMAIN to the public hostname and QUASAR_PORT to the listen port.
The random path prefix is read from secrets/route.token and is never printed.
"""
import os
import shutil
from datetime import datetime
from pathlib import Path

root = Path(os.environ.get('QUASAR_ROOT', '/opt/quasar-server'))
domain = os.environ.get('QUASAR_DOMAIN', 'quasar.example.com')
port = os.environ.get('QUASAR_PORT', '31117')
route = (root / 'secrets/route.token').read_text().strip()
conf = Path(os.environ.get('NGINX_CONF', '/etc/nginx/conf.d/quasar-server.conf'))
if conf.exists():
    backup = root / 'deploy/backups'
    backup.mkdir(mode=0o700, exist_ok=True)
    shutil.copy2(conf, backup / ('nginx-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.conf'))
conf.write_text(f'''server {{
    listen {port} ssl;
    server_name {domain};
    ssl_certificate /etc/letsencrypt/live/{domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:quasar:10m;
    ssl_session_tickets on;
    access_log off;
    error_log /var/log/nginx/quasar-error.log crit;
    client_max_body_size 2m;
    location /ROUTE/tidal/audio/ {{
        proxy_pass http://127.0.0.1:31119/audio/;
        proxy_http_version 1.1;
        proxy_read_timeout 120s;
        proxy_buffering off;
    }}
    location /ROUTE/ {{
        proxy_pass http://127.0.0.1:31115/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 60s;
        proxy_buffering off;
    }}
    location / {{ return 404; }}
}}
'''.replace('ROUTE', route))
conf.chmod(0o600)
print(f'Private Quasar HTTPS route configured on {domain}:{port}')
