"""防止测试迁移清单漂移，或把部分迁移误报成完整兼容。"""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch
from scripts import desktop_tests


class DesktopCatalogTests(unittest.TestCase):
    def test_every_desktop_file_is_connected_to_the_runner(self):
        manifest = json.loads(desktop_tests.MANIFEST.read_text())
        excluded = {path: entry for path, entry in manifest['files'].items()
                    if entry['status'] == 'excluded'}
        expected = {f'eslint-rules/tests/{name}-test.mjs' for name in (
            'config', 'insecure-random', 'no-loosely-typed-webcontents-ipc',
            'react-no-unbound-dispatcher-props', 'react-proper-lifecycle-methods',
            'react-readonly-props-and-state')}
        copilot = {f'app/test/unit/{name}-test.ts' for name in (
            'copilot-app', 'copilot-byok', 'copilot-commit-message-prompt',
            'copilot-commit-message', 'copilot-conflict-context',
            'copilot-conflict-resolution-error', 'copilot-conflict-resolution-model',
            'copilot-conflict-resolution', 'copilot-error',
            'copilot-in-memory-session-fs-provider', 'copilot-resolution-helpers',
            'copilot-sdk-auth', 'stores/copilot-store-credentials', 'stores/copilot-store')}
        copilot.update(f'app/test/unit/ui/{name}-test.tsx' for name in (
            'commit-message', 'commit-message-warning-dialogs',
            'copilot-custom-providers-dialog', 'copilot-preferences',
            'test-copilot-snapshot-card-dialog'))
        copilot.update(('script/copilot-test.ts', 'script/webpack-koffi-test.ts',
                        'script/webpack-copilot-timers-test.ts'))
        expected.update(copilot)
        # Dexie removed on 2026-10-26: the IndexedDB schema-migration suites have no counterpart.
        expected.update(('app/test/unit/database-migration-test.ts',
                         'app/test/unit/repositories-database-test.ts'))
        self.assertEqual(set(excluded), expected)
        for entry in excluded.values():
            self.assertTrue(entry.get('exclusion'))
        outstanding = {path: entry['status'] for path, entry in manifest['files'].items()
                       if path not in expected and entry['status'] != 'ported'}
        self.assertEqual(outstanding, {
            'app/test/unit/api-test.ts': 'partial',
            'app/test/unit/main-process/menu-test.ts': 'partial',
            'app/test/unit/refresh-token-consumers-test.ts': 'partial',
            'app/test/unit/repo-rules-test.ts': 'partial',
            # shadcn Collapsible instead of native <details>: one tutorial case excluded (design-adaptations.ts).
            'app/test/unit/ui/tutorial-welcome-surfaces-test.tsx': 'partial',
        }, 'Desktop completeness regressed')
        for path in outstanding:
            self.assertTrue(manifest['files'][path].get('exclusion'))

    def test_registered_ports_point_to_real_rust_tests(self):
        manifest = json.loads(desktop_tests.MANIFEST.read_text())
        vendor = desktop_tests.VENDOR if desktop_tests.VENDOR.exists() else None
        self.assertEqual(desktop_tests.verify(manifest, vendor), [])

    def test_upstream_change_is_reported_even_when_test_name_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            vendor = Path(directory)
            source = vendor / 'app/test/unit/git/example-test.ts'
            source.parent.mkdir(parents=True)
            source.write_text("it('same name', () => assert.equal(actual, 1))")
            digest = desktop_tests.upstream_files(vendor)['app/test/unit/git/example-test.ts']
            manifest = {'files': {'app/test/unit/git/example-test.ts': {
                'sha256': digest, 'status': 'pending', 'rust_tests': []}}}
            self.assertEqual(desktop_tests.verify(manifest, vendor), [])
            source.write_text("it('same name', () => assert.equal(actual, 2))")
            self.assertTrue(desktop_tests.verify(manifest, vendor))

    def test_deleted_rust_test_cannot_keep_coverage_claim(self):
        manifest = copy.deepcopy(json.loads(desktop_tests.MANIFEST.read_text()))
        entry = next(entry for entry in manifest['files'].values() if entry['rust_tests'])
        entry['rust_tests'][0]['rust'] = 'test_that_was_deleted'
        self.assertTrue(any('missing Rust test' in error for error in desktop_tests.verify(manifest)))

    def test_stale_port_is_not_accepted(self):
        manifest = {'files': {'removed-test.ts': {'status': 'stale', 'rust_tests': []}}}
        self.assertTrue(desktop_tests.verify(manifest))


class GitLensCatalogTests(unittest.TestCase):
    def test_gitlens_inventory_and_feature_sources(self):
        manifest = json.loads((desktop_tests.ROOT / 'tests/gitlens/manifest.json').read_text())
        vendor = desktop_tests.ROOT.parent / 'Vendor/vscode-gitlens'
        self.assertEqual(desktop_tests.verify(manifest, vendor if vendor.exists() else None, pinned=True), [])

    def test_pinned_gitlens_baseline_stays_fixed_while_live_audit_detects_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            vendor = Path(directory)

            def git(*args):
                return subprocess.check_output(['git', '-C', str(vendor), *args], text=True).strip()

            git('init', '-q')
            git('config', 'user.name', 'Conformance Test')
            git('config', 'user.email', 'test@example.invalid')
            test = vendor / 'src/__tests__/sample.test.ts'
            test.parent.mkdir(parents=True)
            test.write_text('original assertion')
            helper = vendor / 'src/__tests__/helpers.ts'
            helper.write_text('original helper')
            git('add', '.')
            git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline')
            manifest = {
                'project': 'gitlens', 'commit': git('rev-parse', 'HEAD'),
                'support_sha256': desktop_tests.upstream_support(vendor, 'gitlens'),
                'files': {name: {'sha256': digest, 'status': 'pending', 'rust_tests': []}
                          for name, digest in desktop_tests.upstream_files(vendor, 'gitlens').items()}}
            self.assertEqual(desktop_tests.verify(manifest, vendor, pinned=True), [])
            test.write_text('changed assertion')
            helper.write_text('changed helper')
            git('add', '.')
            git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'upstream changes')
            head = git('rev-parse', 'HEAD')
            self.assertEqual(desktop_tests.verify(manifest, vendor, pinned=True), [])
            errors = desktop_tests.verify(manifest, vendor)
            self.assertTrue(any('fixtures/helpers changed' in error for error in errors))
            self.assertTrue(any('sample.test.ts' in error for error in errors))
            changed = copy.deepcopy(manifest)
            changed['files']['src/__tests__/sample.test.ts']['sha256'] = 'invalid'
            self.assertTrue(desktop_tests.verify(changed, vendor, pinned=True))
            self.assertEqual(git('rev-parse', 'HEAD'), head)

    def test_gitlens_package_and_extension_tests_are_both_collected(self):
        with tempfile.TemporaryDirectory() as directory:
            vendor = Path(directory)
            paths = []
            for relative in ('src/a/__tests__/a.test.ts', 'packages/git/src/a.test.ts',
                             'tests/e2e/specs/a.test.ts', 'tests/fixtures/example.test.ts',
                             'packages/git/src/__tests__/helpers.ts'):
                path = vendor / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
                paths.append(path)
            with patch.object(desktop_tests, 'gitlens_paths', return_value=paths):
                files = desktop_tests.upstream_files(vendor, 'gitlens')
                self.assertEqual(set(files), {path.relative_to(vendor).as_posix() for path in paths[:3]})
                before = desktop_tests.upstream_support(vendor, 'gitlens')
                paths[-1].write_text('changed helper')
                self.assertNotEqual(before, desktop_tests.upstream_support(vendor, 'gitlens'))

    def test_reference_feature_does_not_count_as_ported(self):
        manifest = {'project': 'gitlens', 'files': {'blame.test.ts': {
            'status': 'ported', 'rust_tests': []}}}
        self.assertTrue(desktop_tests.verify(manifest))


class ConformanceSnapshotTests(unittest.TestCase):
    def test_snapshots_and_fixture_objects_are_original_bytes(self):
        root = desktop_tests.ROOT / 'tests/conformance'
        registry = json.loads((root / 'sources.json').read_text())
        records = {f'upstream/{key}': value for key, value in registry['sources'].items()}
        records.update(registry['support'])
        for relative, record in records.items():
            with self.subTest(path=relative):
                data = (root / relative).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), record['sha256'])
                vendor = desktop_tests.ROOT.parent / 'Vendor' / (
                    'desktop' if record['project'] == 'desktop' else 'vscode-gitlens')
                if vendor.exists():
                    self.assertEqual(data, (vendor / record['source']).read_bytes())

    def test_changed_original_assertions_cannot_keep_port_claim(self):
        manifest = copy.deepcopy(json.loads(desktop_tests.MANIFEST.read_text()))
        entry = next(entry for entry in manifest['files'].values() if entry.get('runner'))
        entry['sha256'] = 'changed'
        self.assertTrue(any('snapshot missing or modified' in error
                            for error in desktop_tests.verify(manifest)))
