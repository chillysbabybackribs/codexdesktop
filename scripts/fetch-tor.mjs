#!/usr/bin/env node
// Downloads the official Tor Expert Bundle for the current platform into
// resources/tor/<platform>-<arch>/, where the app's built-in VPN
// (src/main/browser/vpn-manager.ts) looks for it. Run once per dev machine,
// and as part of any future packaging step so every distributed copy ships
// with the tunnel built in. Without a bundled binary the VPN toggle falls
// back to a system-wide `tor` on PATH.
//
// Everything comes straight from torproject.org: the release version from the
// official update endpoint, the tarball from dist.torproject.org.

import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..')

const bundlePlatforms = {
  'win32-x64': 'windows-x86_64',
  'win32-ia32': 'windows-i686',
  'darwin-x64': 'macos-x86_64',
  'darwin-arm64': 'macos-aarch64',
  'linux-x64': 'linux-x86_64',
  'linux-ia32': 'linux-i686'
}

async function main() {
  const key = `${process.platform}-${process.arch}`
  const bundlePlatform = bundlePlatforms[key]
  if (!bundlePlatform) {
    console.error(
      `No Tor Expert Bundle is published for ${key}. Install a system tor instead (e.g. apt/dnf/brew install tor); the VPN toggle finds it on PATH.`
    )
    process.exit(1)
  }

  console.log('Resolving the current Tor Browser release version…')
  const releaseResponse = await fetch(
    'https://aus1.torproject.org/torbrowser/update_3/release/downloads.json'
  )
  if (!releaseResponse.ok) {
    throw new Error(`Version lookup failed: HTTP ${releaseResponse.status}`)
  }
  const release = await releaseResponse.json()
  const version = release.version
  if (!version) {
    throw new Error('Could not read a version from the Tor release metadata')
  }

  const url = `https://dist.torproject.org/torbrowser/${version}/tor-expert-bundle-${bundlePlatform}-${version}.tar.gz`
  const archivePath = join(tmpdir(), `tor-expert-bundle-${bundlePlatform}-${version}.tar.gz`)
  console.log(`Downloading ${url}`)
  const download = await fetch(url)
  if (!download.ok || !download.body) {
    throw new Error(`Download failed: HTTP ${download.status}`)
  }
  await pipeline(Readable.fromWeb(download.body), createWriteStream(archivePath))

  const destination = join(projectRoot, 'resources', 'tor', key)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  console.log(`Extracting into ${destination}`)
  // bsdtar ships with Windows 10+, macOS, and every mainstream Linux distro.
  const extraction = spawnSync('tar', ['-xzf', archivePath, '-C', destination], {
    stdio: 'inherit'
  })
  if (extraction.status !== 0) {
    throw new Error(`tar exited with status ${extraction.status}`)
  }
  await rm(archivePath, { force: true })

  const executable = process.platform === 'win32' ? 'tor.exe' : 'tor'
  console.log(`Done. Tor ${version} bundled at ${join(destination, 'tor', executable)}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
