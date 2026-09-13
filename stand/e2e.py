"""Disposable real PostgreSQL -> HTTPS Control Plane -> Rust Agent -> Xray stand."""
import base64
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import resource
import ssl
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit, parse_qs

sys.path.insert(0, '/stand')
from e2e import ROOT, SETTINGS, BEARER, STATE, XRAY, AGENT, check, command, wait_for, write, api_users


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    check(not Path('/proc/sys/kernel/core_pattern').read_text().startswith('|'), 'core_policy_required')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Uhuru Stand CA',
             '-keyout', str(ROOT/'ca.key'), '-out', str(ROOT/'ca.pem')])
    command(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
             '-keyout', str(ROOT/'key.pem'), '-out', str(ROOT/'server.csr')])
    (ROOT/'extensions.cnf').write_text('basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n'
        'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n')
    command(['openssl', 'x509', '-req', '-in', str(ROOT/'server.csr'), '-CA', str(ROOT/'ca.pem'),
             '-CAkey', str(ROOT/'ca.key'), '-CAcreateserial', '-days', '1', '-out', str(ROOT/'cert.pem'),
             '-extfile', str(ROOT/'extensions.cnf')])
    command(['systemd-tmpfiles', '--create', '/etc/tmpfiles.d/uhuru-node.tmpfiles.conf'])
    version = sorted(Path('/etc/postgresql').iterdir())[0].name
    (Path('/etc/postgresql')/version/'main/conf.d/uhuru.conf').write_bytes(Path('/opt/uhuru/deploy/postgresql-secrets.conf').read_bytes())
    command(['systemctl', 'restart', f'postgresql@{version}-main'])
    command(['runuser', '-u', 'postgres', '--', 'createdb', 'uhuru'])
    for script in ['/opt/uhuru/schema.sql', '/opt/uhuru/deploy/app-role.sql']:
        command(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'uhuru', '-f', script])
    uid = int(command(['id', '-u', 'uhuru']).stdout)
    gid = int(command(['id', '-g', 'uhuru']).stdout)
    Path('/etc/uhuru').mkdir(mode=0o750)
    os.chown('/etc/uhuru', 0, gid)
    for name in ['key.pem', 'cert.pem']:
        write(Path('/etc/uhuru')/name, (ROOT/name).read_bytes(), gid=gid)
    password = base64.urlsafe_b64encode(os.urandom(32)).decode()
    basic = 'Basic ' + base64.b64encode(('admin:' + password).encode()).decode()
    cp_settings = dict(origin='https://localhost:18444', listen_host='127.0.0.1', port=18444,
                       database_socket='/var/run/postgresql', admin_username='admin', admin_password=password,
                       tls_cert='/etc/uhuru/cert.pem', tls_key='/etc/uhuru/key.pem')
    write(Path('/etc/uhuru/settings.json'), cp_settings, gid=gid)
    command(['systemctl', 'start', 'uhuru-control-plane'])
    context = ssl.create_default_context(cafile=str(ROOT/'ca.pem'))

    def request(method, path, body=None, auth=basic):
        conn = http.client.HTTPSConnection('localhost', 18444, context=context, timeout=5)
        try:
            conn.request(method, path, json.dumps(body) if body is not None else None,
                         {'Authorization': auth, **({'Content-Type': 'application/json'} if body is not None else {})})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def started():
        try:
            return request('GET', '/admin/users')[0] == 200
        except OSError:
            return False
    wait_for(started, 'control_plane_start', 15)
    keypair = dict(line.split(': ', 1) for line in command([XRAY, 'x25519']).stdout.decode().strip().splitlines())
    private_key, public_key = keypair['PrivateKey'], keypair['Password (PublicKey)']
    bearer = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('=')
    connection = dict(inbound_tag='vless', host='127.0.0.1', port=18443, server_name='localhost',
                      public_key=public_key, short_id='abcd', fingerprint='chrome')
    registration = dict(label='Stand node', public_connection=connection, bearer=bearer)
    status, _, body = request('POST', '/admin/nodes', registration)
    check(status == 201, 'register_node')
    node = json.loads(body)['id']
    user = json.loads(request('POST', '/admin/users', dict(label='Stand user'))[2])['id']
    status, _, body = request('POST', f'/admin/users/{user}/first-profile')
    check(status == 200, 'issue_profile')
    issued = json.loads(body)
    link_path = urlsplit(issued['link']).path
    check(request('GET', link_path, auth='')[0] == 503, 'no_config_before_ack')
    check(request('POST', '/admin/nodes', registration)[0] == 409, 'duplicate_secret_database_error')

    class Resource(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_GET(self):
            body = b'uhuru-control-resource'
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    target_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    target_context.minimum_version = ssl.TLSVersion.TLSv1_3
    target_context.set_alpn_protocols(['h2', 'http/1.1'])
    target_context.load_cert_chain(ROOT/'cert.pem', ROOT/'key.pem')
    target = ThreadingHTTPServer(('127.0.0.1', 18445), Resource)
    target.socket = target_context.wrap_socket(target.socket, server_side=True)
    threading.Thread(target=target.serve_forever, daemon=True).start()
    write(BEARER, bearer.encode(), uid=2002, mode=0o600)
    write(Path('/etc/uhuru-node/ca.pem'), (ROOT/'ca.pem').read_bytes(), mode=0o644)
    settings = dict(node_id=node, inbound_tag='vless', control_plane='https://localhost:18444',
                    bearer_file=str(BEARER), ca_file='/etc/uhuru-node/ca.pem', state_dir=str(STATE),
                    xray_binary=XRAY, xray_sha256=hashlib.sha256(Path(XRAY).read_bytes()).hexdigest(),
                    xray_socket='/run/uhuru-xray/api.sock', xray_uid=2001, xray_gid=2001, flow='xtls-rprx-vision', level=0,
                    template={'inbounds': [{'tag': 'vless', 'listen': '127.0.0.1', 'port': 18443, 'protocol': 'vless',
                        'settings': {'decryption': 'none', 'clients': []}, 'streamSettings': {'network': 'tcp', 'security': 'reality',
                        'realitySettings': {'target': '127.0.0.1:18445', 'serverNames': ['localhost'],
                                            'privateKey': private_key, 'shortIds': ['abcd']}}}],
                        'outbounds': [{'protocol': 'freedom', 'settings': {'finalRules': [{'action': 'allow', 'network': 'tcp',
                            'ip': ['127.0.0.1/32'], 'port': '18445'}]}}]})
    write(SETTINGS, settings)
    command(['runuser', '-u', 'uhuru-agent', '--', AGENT, 'init', str(SETTINGS)])
    command(['systemctl', 'start', 'uhuru-node-agent'])
    wait_for(lambda: request('GET', link_path, auth='')[0] == 200, 'ack_timeout')
    ready = json.loads(request('GET', f"/admin/profiles/{issued['first_profile_id']}/readiness")[2])[0]
    first_confirmed = ready['confirmed_at']
    status, headers, body = request('GET', link_path, auth='')
    check(status == 200 and headers.get('cache-control') == 'no-store', 'subscription_response')
    uris = body.decode().strip().splitlines()
    check(len(uris) == 1, 'exactly_one_configuration')
    uri = urlsplit(uris[0])
    params = {k: v[0] for k, v in parse_qs(uri.query).items()}
    check(request('POST', '/admin/users', {'label': uri.username, 'unexpected': issued['link']})[0] == 400, 'safe_validation_error')
    # Force errors whose PostgreSQL details contain each readable Profile secret.
    for credential in ['vless_uuid', 'gen_random_uuid()']:
        sql = ('INSERT INTO access_profiles(id,user_id,vless_uuid,link_secret) '
               f'SELECT gen_random_uuid(),user_id,{credential},link_secret FROM access_profiles LIMIT 1;')
        failed = subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'uhuru'],
                                input=sql.encode(), capture_output=True, timeout=10)
        check(failed.returncode != 0, 'profile_secret_constraint_error')
    users = api_users()
    check(len(users) == 1 and users[0]['email'] == issued['first_profile_id'], 'real_xray_set')
    check(users[0]['account']['id'] == uri.username and users[0]['account']['flow'] == 'xtls-rprx-vision', 'real_xray_account')
    client_config = {'log': {'loglevel': 'none', 'access': 'none', 'error': 'none'},
        'inbounds': [{'listen': '127.0.0.1', 'port': 10880, 'protocol': 'socks', 'settings': {'udp': False}}],
        'outbounds': [{'protocol': 'vless', 'settings': {'vnext': [{'address': uri.hostname, 'port': uri.port,
            'users': [{'id': uri.username, 'flow': params['flow'], 'encryption': params['encryption']}]}]},
            'streamSettings': {'network': params['type'], 'security': params['security'], 'realitySettings': {
                'serverName': params['sni'], 'password': params['pbk'], 'shortId': params['sid'], 'fingerprint': params['fp']}}}]}
    write(ROOT/'client.json', client_config, mode=0o600)
    client = subprocess.Popen([XRAY, 'run', '-config', str(ROOT/'client.json')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        def probe():
            result = command(['curl', '--silent', '--http1.1', '--max-time', '5', '--noproxy', '', '--socks5-hostname',
                              '127.0.0.1:10880', '--cacert', str(ROOT/'ca.pem'), 'https://localhost:18445/'], ok=False)
            return result.returncode == 0 and result.stdout == b'uhuru-control-resource'
        wait_for(probe, 'reality_vision_https_probe', 15)
    finally:
        client.terminate()
        client.wait(timeout=10)
    wait_for(lambda: json.loads(request('GET', f"/admin/profiles/{issued['first_profile_id']}/readiness")[2])[0]['last_seen_at'] > ready['last_seen_at'], 'repeat_poll')
    repeated = json.loads(request('GET', f"/admin/profiles/{issued['first_profile_id']}/readiness")[2])[0]
    check(repeated['confirmed_at'] == first_confirmed and len(api_users()) == 1, 'stable_confirmation_no_duplicate')
    command(['systemctl', 'restart', 'uhuru-control-plane'])
    wait_for(started, 'restart_control_plane', 15)
    check(json.loads(request('POST', f'/admin/users/{user}/first-profile')[2]) == issued, 'restart_same_link_and_term')
    forbidden = [bearer, password, basic, uri.username, issued['link'], link_path.rsplit('/', 1)[1], private_key]
    forbidden += [base64.urlsafe_b64decode(link_path.rsplit('/', 1)[1] + '=').hex(),
                  hashlib.sha256(base64.urlsafe_b64decode(bearer + '=')).hexdigest(), 'BEGIN PRIVATE KEY']
    logs = command(['journalctl', '--no-pager', '-o', 'cat', '-u', 'uhuru-control-plane', '-u', 'uhuru-node-agent', '-u', 'uhuru-xray']).stdout
    for log in Path('/var/log/postgresql').glob('*.log'):
        logs += log.read_bytes()
    check(all(item.encode() not in logs for item in forbidden), 'secret_in_logs')
    data = Path('/var/lib/postgresql')/version/'main'
    check(data.stat().st_mode & 0o077 == 0 and (data/'pg_wal').stat().st_mode & 0o077 == 0, 'database_permissions')
    for service in ['uhuru-control-plane', f'postgresql@{version}-main', 'uhuru-node-agent', 'uhuru-xray']:
        pid = command(['systemctl', 'show', '-p', 'MainPID', '--value', service]).stdout.decode().strip()
        limits = Path(f'/proc/{pid}/limits').read_text()
        import re
        check(re.search(r'Max core file size\s+0\s+0\s+', limits), 'core_limit')
    source = hashlib.sha256()
    for file in sorted([*Path('/opt/uhuru/src').rglob('*.ts'), Path('/opt/uhuru/schema.sql'), Path('/opt/uhuru/package-lock.json')]):
        source.update(str(file.relative_to('/opt/uhuru')).encode() + b'\0' + file.read_bytes() + b'\0')
    result = dict(status='PASS', agent_source=sys.argv[1], control_plane_source_sha256=source.hexdigest(),
        xray=command([XRAY, 'version']).stdout.decode().splitlines()[0],
        xray_sha256=settings['xray_sha256'], node=command(['node', '--version']).stdout.decode().strip(),
        postgres=command(['psql', '--version']).stdout.decode().strip(), issued_at=issued['starts_at'], confirmed_at=first_confirmed,
        transport='TCP + REALITY + XTLS Vision; local TLS 1.3 target', mime='text/plain; charset=utf-8',
        checks=['HTTPS issuance', 'no configuration before ACK', 'real agent save/apply/verify/ACK',
                'one matching live Xray account', 'URI-derived Xray client HTTPS probe', 'stable repeated confirmation',
                'Control Plane restart preserves identity and term', 'application/agent/Xray/PostgreSQL log secret scan',
                'private active database/WAL', 'zero core limits'],
        android='NOT RUN', ios='NOT RUN', public_vps_egress='NOT RUN', encrypted_backup='NOT RUN: no copy created',
        proxy_logs='N/A: direct TLS, no proxy')
    Path('/opt/uhuru/stand-results.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        events = []
        for raw in command(['journalctl', '--no-pager', '-o', 'cat', '-u', 'uhuru-node-agent'], ok=False).stdout.splitlines():
            try:
                event = json.loads(raw)
                events.append({key: event[key] for key in ['stage', 'code'] if key in event})
            except (ValueError, TypeError):
                pass
        line = traceback.extract_tb(error.__traceback__)[-1].lineno
        print(json.dumps({'status': 'FAIL', 'line': line, 'agent_events': events[-8:],
                          'code': str(error) if type(error) is RuntimeError else type(error).__name__}), flush=True)
        raise SystemExit(1)
