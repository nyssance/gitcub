"""Desktop / GitLens 测试清单与迁移审计。清单数量不是测试覆盖率。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'tests/desktop/manifest.json'
VENDOR = ROOT.parent / 'Vendor/desktop'
SUFFIXES = tuple('-test.' + ext for ext in ('ts', 'tsx', 'js', 'jsx', 'mts', 'mjs'))


GITLENS_SUFFIXES = tuple('.' + kind + '.' + ext
                        for kind in ('test', 'spec')
                        for ext in ('ts', 'tsx', 'js', 'jsx', 'mts', 'mjs', 'cts', 'cjs'))


def gitlens_paths(vendor):
    # 只看版本控制中的源码，排除 node_modules / 构建目录。
    paths = subprocess.check_output(['git', '-C', str(vendor), 'ls-files', '-z'], text=True).split('\0')
    return [vendor / path for path in paths if path and (vendor / path).is_file()]


def upstream_files(vendor, project='desktop'):
    result = {}
    if project == 'gitlens':
        for path in gitlens_paths(vendor):
            relative = path.relative_to(vendor)
            if any(part in ('fixtures', '__fixtures__') for part in relative.parts):
                continue
            if path.name.endswith(GITLENS_SUFFIXES):
                result[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        return dict(sorted(result.items()))
    for base in ('app/test', 'script', 'eslint-rules'):
        for path in sorted((vendor / base).rglob('*')):
            if not path.is_file() or 'fixtures' in path.parts or 'helpers' in path.parts:
                continue
            if path.name.endswith(SUFFIXES) or path.name.endswith('.e2e.ts'):
                result[path.relative_to(vendor).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def upstream_support(vendor, project='desktop'):
    # 夹具/辅助函数改变也会改变测试语义，不能只监视 it() 所在文件。
    digest = hashlib.sha256()
    paths = []
    if project == 'gitlens':
        for path in gitlens_paths(vendor):
            relative = path.relative_to(vendor)
            if (any(part in ('fixtures', '__fixtures__', 'helpers') for part in relative.parts)
                    or ('__tests__' in relative.parts and not path.name.endswith(GITLENS_SUFFIXES))
                    or (relative.parts[0] == 'tests' and not path.name.endswith(GITLENS_SUFFIXES))
                    or path.name in ('package.json', '.vscode-test.mjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')
                    or relative.as_posix() == 'scripts/build.mjs'):
                paths.append(path)
    for base in (() if project == 'gitlens' else ('app/test/helpers', 'app/test/fixtures')):
        paths.extend(path for path in (vendor / base).rglob('*') if path.is_file())
    paths.extend(vendor / path for path in (() if project == 'gitlens' else (
        'app/test/globals.mts', 'app/test/unit-test-env.ts', '.test.env', 'script/test.mjs')))
    for path in sorted(paths):
        if path.is_file():
            digest.update(path.relative_to(vendor).as_posix().encode() + b'\0')
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def pinned_gitlens_inventory(vendor, revision):
    """Read the immutable baseline from Git objects without changing the Vendor checkout."""
    commit = subprocess.check_output(
        ['git', '-C', str(vendor), 'rev-parse', '--verify', f'{revision}^{{commit}}'], text=True
    ).strip()
    tree = subprocess.check_output(
        ['git', '-C', str(vendor), 'ls-tree', '-r', '-z', commit]
    ).split(b'\0')
    tests, support = {}, {}
    for record in tree:
        if not record:
            continue
        metadata, raw_path = record.split(b'\t', 1)
        mode, kind, oid = metadata.split()
        if kind != b'blob':
            continue
        relative = Path(raw_path.decode())
        name = relative.as_posix()
        is_test = (relative.name.endswith(GITLENS_SUFFIXES)
                   and not any(part in ('fixtures', '__fixtures__') for part in relative.parts))
        is_support = (any(part in ('fixtures', '__fixtures__', 'helpers') for part in relative.parts)
                      or ('__tests__' in relative.parts and not relative.name.endswith(GITLENS_SUFFIXES))
                      or (relative.parts[0] == 'tests' and not relative.name.endswith(GITLENS_SUFFIXES))
                      or relative.name in ('package.json', '.vscode-test.mjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')
                      or name == 'scripts/build.mjs')
        if not is_test and not is_support:
            continue
        content = subprocess.check_output(['git', '-C', str(vendor), 'cat-file', 'blob', oid.decode()])
        digest = hashlib.sha256(content)
        if is_test:
            tests[name] = digest.hexdigest()
        if is_support:
            support[name] = digest.digest()
    digest = hashlib.sha256()
    for name in sorted(support, key=Path):
        digest.update(name.encode() + b'\0')
        digest.update(support[name])
    return tests, digest.hexdigest()


def verify(manifest, vendor=None, *, pinned=False):
    errors = []
    project = manifest.get('project', 'desktop')
    registered = set()
    for path in (ROOT / f'src-tauri/src/{project}_tests').glob('*.rs'):
        registered.update(re.findall(r'#\[test\]\s*fn\s+(\w+)\s*\(', path.read_text()))
    for source, entry in manifest['files'].items():
        if entry['status'] not in ('pending', 'partial', 'ported', 'stale', 'excluded'):
            errors.append(f'{source}: unknown status')
        if entry['status'] == 'excluded' and not entry.get('exclusion'):
            errors.append(f'{source}: exclusion requires an explicit reason')
        if entry['status'] in ('partial', 'ported') and not entry['rust_tests'] and not entry.get('runner'):
            errors.append(f'{source}: claims a port without tests')
        if runner := entry.get('runner'):
            snapshot = ROOT / runner['snapshot']
            if not snapshot.is_file() or hashlib.sha256(snapshot.read_bytes()).hexdigest() != entry['sha256']:
                errors.append(f'{source}: original test snapshot missing or modified')
            registry = json.loads((ROOT / 'tests/conformance/sources.json').read_text())
            key = snapshot.relative_to(ROOT / 'tests/conformance/upstream').as_posix()
            record = registry['sources'].get(key, {})
            if record.get('source') != source or record.get('sha256') != entry['sha256']:
                errors.append(f'{source}: runner source registration missing or stale')
            if not runner.get('adaptation') or runner.get('command') != 'bun run test:upstream':
                errors.append(f'{source}: missing runner command or adaptation')
        if entry['status'] == 'stale':
            errors.append(f'{source}: upstream changed; review the Rust assertions')
        for item in entry['rust_tests']:
            if item['rust'] not in registered:
                errors.append(f"{source}: missing Rust test {item['rust']}")
            if not item['upstream'] or not item['adaptation']:
                errors.append(f'{source}: missing original title or adaptation notes')
    for feature in manifest.get('features', []):
        for path in feature['gitcub']:
            if not (ROOT / path).is_file():
                errors.append(f'{feature["name"]}: missing GitCub file {path}')
        for path in feature['tests']:
            if path not in manifest['files']:
                errors.append(f'{feature["name"]}: unregistered upstream test {path}')
    for name in manifest.get('gitcub_regressions', []):
        if name not in registered:
            errors.append(f'missing GitCub regression: {name}')
    if vendor is not None:
        if pinned:
            if project != 'gitlens':
                raise ValueError('Pinned object audit currently supports GitLens only')
            actual, support = pinned_gitlens_inventory(vendor, manifest['commit'])
        else:
            actual, support = upstream_files(vendor, project), upstream_support(vendor, project)
        if 'support_sha256' in manifest and support != manifest['support_sha256']:
            errors.append(f'{project} test fixtures/helpers changed; review affected ports')
        expected = {path: entry['sha256'] for path, entry in manifest['files'].items()}
        for path in sorted(actual.keys() | expected.keys()):
            if actual.get(path) != expected.get(path):
                errors.append(f'{path}: added, removed or changed upstream; run --sync and review')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sync', action='store_true', help='refresh inventory, marking changed ports stale')
    parser.add_argument('--require-complete', action='store_true', help='fail if any in-scope upstream test file remains unported')
    parser.add_argument('--source', choices=('desktop', 'gitlens'), default='desktop')
    parser.add_argument('--vendor', type=Path)
    args = parser.parse_args()
    project = args.source
    manifest_path = ROOT / f'tests/{project}/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    checkout = args.vendor or (ROOT.parent / 'Vendor' / ('desktop' if project == 'desktop' else 'vscode-gitlens'))
    vendor = checkout if (checkout / ('app/test' if project == 'desktop' else '.git')).exists() else None
    if args.sync:
        if vendor is None:
            parser.error(f'{project} Vendor checkout is required for --sync')
        actual = upstream_files(vendor, project)
        support = upstream_support(vendor, project)
        support_changed = support != manifest.get('support_sha256', support)
        previous = manifest['files']
        files = {}
        for path, digest in actual.items():
            entry = previous.get(path, {'sha256': digest, 'status': 'pending', 'rust_tests': []})
            if (entry['sha256'] != digest or support_changed) and (entry['rust_tests'] or entry.get('runner')):
                entry['status'] = 'stale'
            entry['sha256'] = digest
            files[path] = entry
        # Keep removed ports visible for review instead of silently dropping coverage claims.
        for path in previous.keys() - actual.keys():
            entry = previous[path]
            entry['status'] = 'stale'
            files[path] = entry
        manifest['support_sha256'] = support
        manifest['files'] = dict(sorted(files.items()))
        manifest['commit'] = subprocess.check_output(['git', '-C', str(vendor), 'rev-parse', 'HEAD'], text=True).strip()
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    errors = verify(manifest, vendor)
    counts = {status: sum(entry['status'] == status for entry in manifest['files'].values())
              for status in ('ported', 'partial', 'pending', 'stale', 'excluded')}
    print(f"{project} {manifest['commit'][:12]}: {len(manifest['files'])} test files; {counts}")
    print('This is source inventory, not a test execution result or coverage percentage.')
    if vendor is None:
        print('Vendor checkout absent: local mapping checked; upstream drift NOT checked.')
    if args.require_complete:
        errors.extend(f'{path}: {entry["status"]}' for path, entry in manifest['files'].items()
                      if entry['status'] not in ('ported', 'excluded'))
    for error in errors:
        print(error)
    return int(bool(errors))


if __name__ == '__main__':
    raise SystemExit(main())
