#!/usr/bin/env python3
"""Reject affected Python tools and emSign G3 CA bundles before packaging."""
import argparse
from importlib import metadata
from pathlib import Path
import re
import ssl
import sys
import zipfile

ROOT_NAME = 'emSign ECC Root CA - G3'
PEM = re.compile(rb'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', re.S)
MINIMUM = {'certifi': (2026, 10, 19), 'pip': (26, 2, 2)}
PYTHON_PATCH = {(3, 10): 22, (3, 11): 17, (3, 12): 15, (3, 13): 17,
                (3, 14): 9, (3, 15): 1}


def check_pem(data, name):
    for block in PEM.findall(data):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        try:
            context.load_verify_locations(cadata=block.decode('ascii'))
        except ssl.SSLError:
            # Stdlib fixtures and documentation can contain deliberately invalid
            # PEM examples. An invalid certificate cannot become a trust anchor.
            continue
        if any(ROOT_NAME in str(cert['subject']) for cert in context.get_ca_certs()):
            raise SystemExit(f'Compromised CA root in {name}')


def check_environment():
    version = sys.version_info[:3]
    minimum = PYTHON_PATCH.get(version[:2])
    if version < (3, 10, 0) or (minimum is not None and version[2] < minimum):
        raise SystemExit(f'Update the build interpreter: Python {sys.version.split()[0]}')
    for package, minimum in MINIMUM.items():
        try:
            installed = metadata.version(package)
        except metadata.PackageNotFoundError:
            continue
        if tuple(map(int, installed.split('.'))) < minimum:
            raise SystemExit(f'Update {package} {installed}; minimum is {minimum}')
    try:
        import certifi
    except ImportError:
        return
    check_pem(Path(certifi.where()).read_bytes(), 'installed certifi')


def check_bundle(root):
    if not root.exists():
        raise SystemExit(f'Missing bundle: {root}')
    files = root.rglob('*') if root.is_dir() else [root]
    for path in files:
        if not path.is_file():
            continue
        if path.suffix.lower() in {'.pem', '.crt'}:
            check_pem(path.read_bytes(), path)
        elif path.suffix.lower() in {'.zip', '.whl'}:
            with zipfile.ZipFile(path) as archive:
                for name in archive.namelist():
                    if name.lower().endswith(('.pem', '.crt')):
                        check_pem(archive.read(name), f'{path}!{name}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundles', nargs='*', type=Path)
    args = parser.parse_args()
    if args.bundles:
        for bundle in args.bundles:
            check_bundle(bundle)
    else:
        check_environment()
    print('Python security baseline and CA checks passed.')
