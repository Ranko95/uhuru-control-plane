"""Exercise deployment transitions with real Git and isolated OS-command substitutes."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, shutil, subprocess, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['DEPLOY_TEST_ROOT'])
with (root / 'calls').open('a') as out:
    out.write(json.dumps([name, *args]) + '\n')
current = root / 'opt/uhuru'
sha = current.resolve().name
failed = sha == os.environ.get('FAIL_RELEASE')
if name == 'id':
    if args != ['-u']:
        sys.exit(1)
    print('0')
elif name == 'flock':
    sys.exit(int(os.environ.get('LOCK_FAIL', '0')))
elif name in ['chown', 'sleep', 'useradd', 'visudo']:
    pass
elif name == 'sshd':
    if args == ['-T']:
        print('allowusers ranko')
    else:
        assert args == ['-t']
elif name == 'install':
    directory = '-d' in args
    paths, mode = [], 0o755
    i = 0
    while i < len(args):
        if args[i] in ['-m', '-o', '-g']:
            if args[i] == '-m':
                mode = int(args[i+1], 8)
            i += 2
        elif args[i] == '-d':
            i += 1
        else:
            paths.append(pathlib.Path(args[i]))
            i += 1
    if directory:
        for path in paths:
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(mode)
    else:
        if paths[-1].exists():
            paths[-1].unlink()  # install can replace a root-owned read-only destination.
        shutil.copyfile(*paths)
        paths[-1].chmod(mode)
elif name == 'systemd-run':
    pass  # The caller must submit only a fixed executable and validated arguments.
elif name == 'mv':
    paths = [a for a in args if not a.startswith('-')]
    os.replace(*paths)
elif name == 'runuser':
    if args[:3] == ['-u', 'uhuru-build', '--']:
        sys.exit(subprocess.call(args[3:]))
    assert args[:5] == ['-u', 'postgres', '--', 'env', '-i']
    assert 'PGHOST=/var/run/postgresql' in args and 'PGUSER=postgres' in args
    target = pathlib.Path(args[-1]).parents[1]
    assert args[args.index('node'):] == ['node', str(target / 'deploy/db-setup.ts')]
    assert sys.stdin.read() == ''
    with (root / 'migration_calls').open('a') as out:
        out.write(json.dumps({'release': target.name, 'current': sha}) + '\n')
    sys.exit(1 if os.environ.get('MIGRATION_FAIL') else 0)
elif name == 'npm':
    assert '--ignore-scripts' in args and '--omit=dev' in args
    if os.environ.get('NPM_FAIL'):
        sys.exit(1)
    target = pathlib.Path(args[args.index('--prefix') + 1])
    (target / 'node_modules').mkdir()
    (target / 'node_modules/installed').write_text('prepared')
    if os.environ.get('ADVANCE_MAIN'):
        subprocess.check_call(['git', '-C', str(root / 'opt/uhuru-repo'),
                               'push', '-q', 'origin', os.environ['ADVANCE_MAIN'] + ':main'])
elif name == 'systemctl':
    if args[0] == 'show':
        print('0' if failed else str(int(sha[:6], 16) + 1))
    elif args[0] == 'is-active':
        sys.exit(1 if failed else 0)
    elif args[0] not in ['restart', 'daemon-reload', 'reload']:
        raise AssertionError(args)
elif name == 'timeout':
    if args[1] == 'bash':
        sys.exit(1 if failed or sha == os.environ.get('NO_LISTENER') else 0)
    sys.exit(subprocess.call(args[1:]))
else:
    raise AssertionError(name)
'''


class RuntimePolicyTest(unittest.TestCase):
    def test_core_dump_policy(self):
        script = Path(__file__).resolve().parents[1] / 'deploy/check-runtime.sh'
        with tempfile.TemporaryDirectory(prefix='uhuru-runtime-test-') as directory:
            root = Path(directory)
            for name in ['grep', 'cat']:
                # Redirect only the OS file boundary; use the real command on each fixture.
                wrapper = root / name
                wrapper.write_text(f'''#!{sys.executable}
import os, pathlib, subprocess, sys
root = pathlib.Path(os.environ['RUNTIME_TEST_ROOT'])
files = {{'/proc/self/limits': 'limits', '/proc/sys/kernel/core_pattern': 'core_pattern'}}
args = [str(root / files[arg]) if arg in files else arg for arg in sys.argv[1:]]
sys.exit(subprocess.call([{shutil.which(name)!r}, *args]))
''')
                wrapper.chmod(0o755)
            for name, limits, pattern, expected in [
                ('disabled', 'Max core file size 0 0 bytes\n', 'core\n', 0),
                ('soft limit', 'Max core file size 1024 unlimited bytes\n', 'core\n', 1),
                ('hard limit', 'Max core file size 0 unlimited bytes\n', 'core\n', 1),
                ('pipe collector', 'Max core file size 0 0 bytes\n', '|/usr/bin/collector\n', 1),
                ('missing limits', '', 'core\n', 1),
                ('unreadable pattern', 'Max core file size 0 0 bytes\n', None, 1),
            ]:
                with self.subTest(name=name):
                    (root / 'limits').write_text(limits)
                    if pattern is None:
                        (root / 'core_pattern').unlink(missing_ok=True)
                    else:
                        (root / 'core_pattern').write_text(pattern)
                    result = subprocess.run(
                        ['/bin/sh', str(script)], text=True, capture_output=True, timeout=5,
                        env={**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH'],
                             'RUNTIME_TEST_ROOT': str(root)})
                    self.assertEqual(result.returncode, expected, result.stderr)
                    self.assertEqual(result.stdout, '')


class DeploymentTest(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'VPS administrative commands require Linux')
    def test_real_administrative_commands_are_available_in_script_path(self):
        source_dir = Path(__file__).resolve().parents[1] / 'deploy'
        for script, commands in [('setup-autodeploy.sh', ['useradd', 'visudo', 'sshd']),
                                 ('uhuru-deploy', ['runuser'])]:
            with self.subTest(script=script):
                source = (source_dir / script).read_text()
                path = next(line[5:] for line in source.splitlines() if line.startswith('PATH='))
                result = subprocess.run(['/bin/bash', '-c',
                                         'for tool; do command -v "$tool" || exit 1; done',
                                         '_', *commands], env={**os.environ, 'PATH': path},
                                        text=True, capture_output=True)

                self.assertEqual(result.returncode, 0,
                                 script + ': administrative command missing from PATH: ' + repr(commands))

    @unittest.skipUnless(sys.platform == 'linux' and Path('/usr/sbin/sshd').exists(),
                         'Real VPS SSH configuration requires sshd on Linux')
    def test_ssh_dropin_appends_deploy_without_removing_ranko(self):
        config_dir = self.root / 'ssh-config'
        config_dir.mkdir()
        key = config_dir / 'host_key'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '',
                        '-f', str(key)], check=True)
        config = config_dir / 'sshd_config'
        config.write_text('Include ' + str(config_dir / '*.conf') + '\nAllowUsers ranko\n'
                          'HostKey ' + str(key) + '\n')
        (config_dir / 'deploy.conf').write_text('AllowUsers uhuru-deploy\n')
        result = subprocess.run(['/usr/sbin/sshd', '-T', '-f', str(config)],
                                text=True, capture_output=True)

        self.assertEqual(result.returncode, 0, result.stderr)

        users = [line.split()[1] for line in result.stdout.splitlines()
                 if line.startswith('allowusers ')]

        self.assertEqual(set(users), {'ranko', 'uhuru-deploy'})

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='uhuru-deploy-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / 'opt/uhuru-repo'
        self.repo.mkdir(parents=True)
        self.remote = self.root / 'origin.git'
        self.state = self.root / 'var/lib/uhuru-deploy-state'
        self.state.mkdir(parents=True)
        (self.root / 'run/lock').mkdir(parents=True)
        self.releases = self.root / 'opt/uhuru-releases'
        self.releases.mkdir()
        self.current = self.root / 'opt/uhuru'
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Deployment test')
        subprocess.run(['git', 'init', '-q', '--bare', str(self.remote)], check=True)
        self.git('remote', 'add', 'origin', str(self.remote))
        (self.repo / 'schema.sql').write_text('initial schema\n')
        (self.repo / 'migrations').mkdir()
        (self.repo / 'migrations/0001_initial.sql').write_text('SELECT 1;\n')
        (self.repo / '.gitignore').write_text('node_modules/\n')
        self.old = self.commit('old')
        self.new = self.commit('new')
        (self.releases / self.old).mkdir()
        self.current.symlink_to(self.releases / self.old)
        self.mock_dir = self.root / 'mock'
        self.mock_dir.mkdir()
        mock = self.mock_dir / 'mock.py'
        mock.write_text(MOCK)
        mock.chmod(0o755)
        for name in ['id', 'flock', 'chown', 'sleep', 'systemd-run', 'mv',
                     'runuser', 'npm', 'systemctl', 'timeout', 'install', 'useradd', 'visudo', 'sshd']:
            (self.mock_dir / name).symlink_to(mock)
        source = (Path(__file__).resolve().parents[1] / 'deploy/uhuru-deploy').read_text()
        # Keep production paths and PATH fixed; redirect only this disposable copy.
        for prefix in ['/opt/uhuru', '/var/lib/uhuru-deploy-state', '/run/lock',
                       '/var/cache/uhuru-build']:
            source = source.replace(prefix, str(self.root) + prefix)
        source_path = next(line for line in source.splitlines() if line.startswith('PATH='))
        source = source.replace(source_path, f'PATH={self.mock_dir}:{os.environ["PATH"]}', 1)
        self.script = self.root / 'deploy'
        self.script.write_text(source)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args],
                                       text=True, stderr=subprocess.DEVNULL).strip()

    def commit(self, version, push=True):
        (self.repo / 'package.json').write_text(json.dumps({'version': version}))
        self.git('add', '.')
        self.git('commit', '-qm', version)
        sha = self.git('rev-parse', 'HEAD')
        if push:
            self.git('push', '-q', 'origin', 'HEAD:main')
        return sha

    def run_deploy(self, *args, **env):
        return subprocess.run(['bash', str(self.script), *args], text=True,
                              capture_output=True,
                              env={**os.environ, 'DEPLOY_TEST_ROOT': str(self.root), **env})

    def calls(self, name):
        path = self.root / 'calls'
        return [call for line in (path.read_text().splitlines() if path.exists() else [])
                if (call := json.loads(line))[0] == name]

    def test_success_prepares_dependencies_then_switches_and_keeps_previous(self):
        result = self.run_deploy('apply', self.new)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current.resolve().name, self.new)
        self.assertEqual((self.state / 'previous').read_text().strip(), self.old)
        self.assertTrue((self.releases / self.old).is_dir())
        self.assertTrue((self.releases / self.new / 'node_modules/installed').is_file())
        self.assertFalse((self.state / 'pending').exists())
        self.assertEqual(len(self.calls('runuser')), 2)
        migrations = [json.loads(line) for line in (self.root / 'migration_calls').read_text().splitlines()]
        self.assertEqual(migrations, [{'release': self.new, 'current': self.old}])

    def test_migration_failure_leaves_old_service_untouched(self):
        result = self.run_deploy('apply', self.new, MIGRATION_FAIL='1')

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('migration_failed', result.stderr)
        self.assertEqual(self.current.resolve().name, self.old)
        self.assertEqual(self.calls('systemctl'), [])
        self.assertFalse((self.state / 'pending').exists())
        self.assertFalse((self.state / 'previous').exists())

    def test_new_migrations_are_applied_without_manual_sql_override(self):
        (self.repo / 'migrations/0002_next.sql').write_text('SELECT 2;\n')
        sha = self.commit('new migration')
        result = self.run_deploy('apply', sha)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current.resolve().name, sha)

    def test_legacy_sql_can_move_into_a_new_migration_after_review(self):
        (self.repo / 'schema.sql').rename(self.repo / 'migrations/0002_legacy.sql')
        sha = self.commit('move legacy SQL into migrations')
        result = self.run_deploy('apply', sha, '--schema-reviewed')

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current.resolve().name, sha)

    def test_existing_migrations_cannot_be_changed_deleted_or_renamed(self):
        path = self.repo / 'migrations/0001_initial.sql'
        path.write_text('SELECT 2;\n')
        changed = self.commit('change migration')
        path.unlink()
        deleted = self.commit('delete migration')
        self.git('checkout', '-q', self.old, '--', 'migrations')
        path.rename(self.repo / 'migrations/0002_renamed.sql')
        renamed = self.commit('rename migration')

        for sha in [changed, deleted, renamed]:
            self.git('push', '-q', 'origin', sha + ':main', '--force')
            with self.subTest(sha=sha):
                result = self.run_deploy('apply', sha, '--schema-reviewed')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('migration_changed', result.stderr)
                self.assertEqual(self.current.resolve().name, self.old)

        self.assertEqual(self.calls('runuser'), [])

    def test_dependency_failure_leaves_old_service_untouched(self):
        result = self.run_deploy('apply', self.new, NPM_FAIL='1')

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current.resolve().name, self.old)
        self.assertEqual(self.calls('systemctl'), [])
        self.assertEqual(list(self.releases.glob('.prepare.*')), [])

    def test_failed_start_restores_old_version_and_reports_failure(self):
        result = self.run_deploy('apply', self.new, FAIL_RELEASE=self.new)

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current.resolve().name, self.old)
        self.assertIn('Restored ' + self.old, result.stdout)
        self.assertFalse((self.state / 'pending').exists())

    def test_active_process_without_listener_is_not_a_successful_start(self):
        result = self.run_deploy('apply', self.new, NO_LISTENER=self.new)

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current.resolve().name, self.old)

    def test_sql_changes_require_explicit_root_review(self):
        (self.repo / 'schema.sql').write_text('changed schema\n')
        sha = self.commit('schema change')
        result = self.run_deploy('apply', sha)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('schema_changed', result.stderr)
        self.assertEqual(self.current.resolve().name, self.old)
        self.assertEqual(self.calls('runuser'), [])

        result = self.run_deploy('apply', sha, '--schema-reviewed')

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_superseded_commit_is_skipped(self):
        self.commit('newer')
        result = self.run_deploy('apply', self.new)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Skipped superseded', result.stdout)
        self.assertEqual(self.current.resolve().name, self.old)
        self.assertEqual(self.calls('runuser'), [])

    def test_push_during_dependency_install_is_skipped_before_switch(self):
        newer = self.commit('newer', push=False)
        result = self.run_deploy('apply', self.new, ADVANCE_MAIN=newer)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Skipped superseded', result.stdout)
        self.assertEqual(self.current.resolve().name, self.old)
        self.assertEqual(self.calls('systemctl'), [])

    def test_server_lock_rejects_a_second_deployment(self):
        result = self.run_deploy('apply', self.new, LOCK_FAIL='1')

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current.resolve().name, self.old)
        self.assertEqual(self.calls('runuser'), [])

    def test_manual_rollback_can_return_to_previous_release(self):
        self.assertEqual(self.run_deploy('apply', self.new).returncode, 0)

        result = self.run_deploy('restore')

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current.resolve().name, self.old)
        self.assertEqual((self.state / 'previous').read_text().strip(), self.new)

    def test_manual_rollback_across_sql_requires_separate_review(self):
        (self.repo / 'schema.sql').write_text('changed schema\n')
        sha = self.commit('schema change')

        self.assertEqual(self.run_deploy('apply', sha, '--schema-reviewed').returncode, 0)
        self.assertNotEqual(self.run_deploy('restore').returncode, 0)
        self.assertEqual(self.current.resolve().name, sha)

        result = self.run_deploy('restore', '--schema-reviewed')

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current.resolve().name, self.old)

    def test_recovery_after_an_interrupted_switch(self):
        (self.releases / self.new).mkdir()
        self.current.unlink()
        self.current.symlink_to(self.releases / self.new)
        (self.state / 'pending').write_text(self.old + '\n')
        result = self.run_deploy('recover')

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current.resolve().name, self.old)
        self.assertFalse((self.state / 'pending').exists())

    def test_ssh_accepts_only_an_exact_deploy_command(self):
        for command in ['rollback', 'deploy main', 'deploy ' + self.new + '; id',
                        'deploy ' + self.new + ' --schema-reviewed',
                        'deploy ' + self.new + '\nid']:
            with self.subTest(command=command):
                result = self.run_deploy('ssh', SSH_ORIGINAL_COMMAND=command)

                self.assertNotEqual(result.returncode, 0)

        self.assertEqual(self.calls('systemd-run'), [])

        result = self.run_deploy('ssh', SSH_ORIGINAL_COMMAND='deploy ' + self.new)

        self.assertEqual(result.returncode, 0, result.stderr)

        launch = self.calls('systemd-run')[0]

        self.assertEqual(launch[-3:], ['/usr/local/sbin/uhuru-deploy', 'apply', self.new])
        self.assertIn('--property=ExecStopPost=/usr/local/sbin/uhuru-deploy recover', launch)

    def test_installer_preserves_existing_version_and_can_be_rerun(self):
        self.git('checkout', '-q', self.old)
        (self.repo / 'node_modules').mkdir()
        (self.repo / 'node_modules/installed').write_text('original dependencies')
        self.current.unlink()
        (self.releases / self.old).rmdir()
        self.repo.rename(self.current)
        settings = self.root / 'etc/uhuru/local.json'
        settings.parent.mkdir(parents=True)
        settings.write_text('existing secret settings')
        settings.chmod(0o640)
        sbin = self.root / 'usr/local/sbin'
        sbin.mkdir(parents=True)
        (self.root / 'etc/sudoers.d').mkdir()
        bin_dir = self.root / 'usr/local/bin'
        bin_dir.mkdir()
        (bin_dir / 'node').write_text('fixture')
        (bin_dir / 'node').chmod(0o755)
        key = self.root / 'key'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'fixture',
                        '-f', str(key)], check=True)
        source_dir = Path(__file__).resolve().parents[1] / 'deploy'
        source = (source_dir / 'setup-autodeploy.sh').read_text()
        for prefix in ['/opt/uhuru', '/var/lib', '/var/cache', '/run/lock', '/etc/uhuru', '/etc/ssh',
                       '/etc/sudoers.d', '/etc/systemd', '/usr/local/sbin', '/usr/local/bin']:
            source = source.replace(prefix, str(self.root) + prefix)
        source_path = next(line for line in source.splitlines() if line.startswith('PATH='))
        source = source.replace(source_path, f'PATH={self.mock_dir}:{os.environ["PATH"]}', 1)
        setup = self.root / 'setup'
        setup.write_text(source)
        (self.root / 'uhuru-deploy').write_text((source_dir / 'uhuru-deploy').read_text())
        env = {**os.environ, 'DEPLOY_TEST_ROOT': str(self.root)}
        for _ in range(2):
            result = subprocess.run(['bash', str(setup), str(key) + '.pub'],
                                    env=env, text=True, capture_output=True)

            self.assertEqual(result.returncode, 0, result.stderr)

        self.assertEqual(self.current.resolve().name, self.old)
        self.assertTrue((self.repo / '.git').is_dir())
        self.assertEqual((self.current / 'node_modules/installed').read_text(), 'original dependencies')
        self.assertEqual(settings.read_text(), 'existing secret settings')
        self.assertEqual(self.calls('systemctl'), [['systemctl', 'is-active', '--quiet',
                                                  'uhuru-control-plane.service'],
                                                 ['systemctl', 'reload', 'ssh.service'],
                                                 ['systemctl', 'daemon-reload']] * 2)
        self.assertEqual((self.root / 'etc/ssh/sshd_config.d/uhuru-deploy.conf').read_text(),
                         'AllowUsers uhuru-deploy\n')

        sudoers = (self.root / 'etc/sudoers.d/uhuru-deploy').read_text()

        self.assertIn('NOPASSWD: ' + str(sbin / 'uhuru-deploy') + ' ssh\n', sudoers)
        self.assertNotIn('*', sudoers)

        authorized = (self.root / 'var/lib/uhuru-deploy/.ssh/authorized_keys').read_text()

        self.assertTrue(authorized.startswith('restrict,command="/usr/bin/sudo -n '))
        self.assertIn(' uhuru-deploy ssh" ssh-ed25519 ', authorized.replace(str(sbin) + '/', ''))


if __name__ == '__main__':
    unittest.main()
