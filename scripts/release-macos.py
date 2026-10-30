#!/usr/bin/env python3
"""Build, sign, notarize and assemble a local macOS release; never upload a release."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import tarfile
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
MACHO = {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate release configuration without building or signing')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        raise SystemExit('macOS is required')
    required = ['APPLE_SIGNING_IDENTITY', 'GITCUB_NOTARY_PROFILE', 'GITCUB_UPDATE_ENDPOINT', 'GITCUB_UPDATE_PUBLIC_KEY', 'GITCUB_RELEASE_BASE_URL']
    missing = [key for key in required if not os.environ.get(key)]
    if not (os.environ.get('TAURI_SIGNING_PRIVATE_KEY') or os.environ.get('TAURI_SIGNING_PRIVATE_KEY_PATH')):
        missing.append('TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH')
    if missing:
        raise SystemExit('Missing release configuration: ' + ', '.join(missing))
    for key in ['GITCUB_UPDATE_ENDPOINT', 'GITCUB_RELEASE_BASE_URL']:
        if urlparse(os.environ[key]).scheme != 'https':
            raise SystemExit(f'{key} must use HTTPS')
    if not os.environ['APPLE_SIGNING_IDENTITY'].startswith('Developer ID Application:'):
        raise SystemExit('A Developer ID Application identity is required')
    if args.check:
        print('macOS release configuration is complete')
        return
    run('bun', 'run', 'tauri', 'build', '--bundles', 'app')
    bundle = ROOT / 'src-tauri/target/release/bundle/macos/GitCub.app'
    # Sign every embedded Mach-O, including bundled Git and native libraries,
    # before sealing the application. Never rely on codesign --deep for signing.
    files = []
    for path in bundle.rglob('*'):
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as stream:
                if stream.read(4) in MACHO:
                    files.append(path)
    identity = os.environ['APPLE_SIGNING_IDENTITY']
    for path in sorted(files, key=lambda p: len(p.parts), reverse=True):
        run('codesign', '--force', '--timestamp', '--options', 'runtime', '--entitlements', str(ROOT / 'src-tauri/entitlements.plist'), '--sign', identity, str(path))
    run('codesign', '--force', '--timestamp', '--options', 'runtime', '--entitlements', str(ROOT / 'src-tauri/entitlements.plist'), '--sign', identity, str(bundle))
    run('codesign', '--verify', '--deep', '--strict', '--verbose=2', str(bundle))
    output = ROOT / 'dist-release/macos'
    output.mkdir(parents=True, exist_ok=True)
    notarization = output / 'GitCub-notarization.zip'
    run('ditto', '-c', '-k', '--keepParent', str(bundle), str(notarization))
    run('xcrun', 'notarytool', 'submit', str(notarization), '--keychain-profile', os.environ['GITCUB_NOTARY_PROFILE'], '--wait')
    run('xcrun', 'stapler', 'staple', str(bundle))
    run('xcrun', 'stapler', 'validate', str(bundle))
    run('spctl', '--assess', '--type', 'execute', '--verbose=2', str(bundle))
    version = json.loads((ROOT / 'package.json').read_text())['version']
    architecture = {'arm64': 'aarch64', 'x86_64': 'x86_64'}[platform.machine()]
    artifact = output / f'gitcub-{version}-{architecture}.app.tar.gz'
    with tarfile.open(artifact, 'w:gz') as archive:
        archive.add(bundle, arcname='GitCub.app')
    run('bun', 'tauri', 'signer', 'sign', '--app-version', version, str(artifact))
    manifest = {'version': version, 'platforms': {f'darwin-{architecture}': {
        'url': os.environ['GITCUB_RELEASE_BASE_URL'].rstrip('/') + '/' + artifact.name,
        'signature': Path(str(artifact) + '.sig').read_text().strip()
    }}}
    (output / 'latest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Verified local release: {output}')

if __name__ == '__main__':
    main()
