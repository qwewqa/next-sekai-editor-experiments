import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const native = path.join(root, 'native/lyon')
const rustc = process.env.SEKAI_RUSTC || 'rustc'
const cargo = process.env.SEKAI_CARGO || 'cargo'
const compiler = execFileSync(rustc, ['-vV'], { cwd: native, encoding: 'utf8' })
if (
    !compiler.includes('release: 1.96.0\n') ||
    !compiler.includes('commit-hash: ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96')
) {
    throw new Error('Use the pinned Rust 1.96.0 toolchain in native/lyon/rust-toolchain.toml')
}
const target = path.resolve(native, process.env.CARGO_TARGET_DIR || 'target')
const cargoHome = path.resolve(native, process.env.CARGO_HOME || path.join(homedir(), '.cargo'))
const flags = [
    '-C',
    'link-arg=--initial-memory=2097152',
    '-C',
    'link-arg=--max-memory=67108864',
    '-C',
    'link-arg=-zstack-size=65536',
    `--remap-path-prefix=${root}=/sekai`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
].join('\u001f')
execFileSync(cargo, ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown'], {
    cwd: native,
    env: {
        ...process.env,
        RUSTC: rustc,
        CARGO_ENCODED_RUSTFLAGS: flags,
        RUSTFLAGS: undefined,
        CARGO_TARGET_DIR: target,
        CARGO_HOME: cargoHome,
    },
    stdio: 'inherit',
})
const file = 'src/rendering/vendor/lyon.wasm'
const destination = path.join(root, file)
mkdirSync(path.dirname(destination), { recursive: true })
copyFileSync(
    path.join(target, 'wasm32-unknown-unknown/release/sekai_path_tessellator.wasm'),
    destination,
)
const hash = (file) =>
    createHash('sha256')
        .update(readFileSync(path.join(root, file)))
        .digest('hex')
const sourceFiles = [
    'native/lyon/src/lib.rs',
    'native/lyon/Cargo.toml',
    'native/lyon/Cargo.lock',
    'native/lyon/rust-toolchain.toml',
    'scripts/build-lyon.mjs',
    'public/third-party/lyon/sources.json',
    'public/third-party/lyon/README.txt',
]
const manifest = {
    abi: 1,
    compiler: compiler.trim(),
    link: { initialMemory: 2097152, maximumMemory: 67108864, stack: 65536 },
    sources: sourceFiles.map((file) => ({ file, sha256: hash(file) })),
    artifact: { file, sha256: hash(file), bytes: readFileSync(destination).byteLength },
}
writeFileSync(path.join(native, 'artifact.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest.artifact))
