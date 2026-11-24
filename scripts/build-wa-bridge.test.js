'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  defaultBinaryName,
  hostGoarch,
  hostGoos,
  resolveTargetPath,
} = require('./build-wa-bridge');

describe('build-wa-bridge path resolution', () => {
  it('maps Node platform/arch names to Go GOOS/GOARCH', () => {
    assert.equal(hostGoos('win32'), 'windows');
    assert.equal(hostGoos('darwin'), 'darwin');
    assert.equal(hostGoos('linux'), 'linux');
    assert.equal(hostGoarch('x64'), 'amd64');
    assert.equal(hostGoarch('arm64'), 'arm64');
  });

  it('keeps native binary name and isolates cross-builds on macOS', () => {
    const nativePath = resolveTargetPath({ hostOs: 'darwin', hostArch: 'arm64' });
    const crossLinux = resolveTargetPath({
      goos: 'linux',
      goarch: 'amd64',
      hostOs: 'darwin',
      hostArch: 'arm64',
    });
    assert.equal(path.basename(nativePath), 'wa-bridge');
    assert.equal(path.basename(crossLinux), 'wa-bridge-linux-amd64');
    assert.notEqual(nativePath, crossLinux);
  });

  it('keeps wa-bridge.exe for native Windows and isolates cross-builds', () => {
    assert.equal(
      defaultBinaryName('', '', { hostOs: 'windows', hostArch: 'amd64' }),
      'wa-bridge.exe',
    );
    assert.equal(
      defaultBinaryName('linux', 'amd64', { hostOs: 'windows', hostArch: 'amd64' }),
      'wa-bridge-linux-amd64',
    );
    assert.equal(
      defaultBinaryName('windows', 'arm64', { hostOs: 'linux', hostArch: 'amd64' }),
      'wa-bridge-windows-arm64.exe',
    );
  });

  it('honors explicit outPath or configured binary path over default', () => {
    const explicit = resolveTargetPath({
      goos: 'linux',
      goarch: 'amd64',
      outPath: 'custom/my-bridge',
      cwd: path.join('tmp', 'repo'),
      hostOs: 'darwin',
      hostArch: 'arm64',
    });
    assert.equal(explicit, path.resolve(path.join('tmp', 'repo'), 'custom/my-bridge'));
  });
});
