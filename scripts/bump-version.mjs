import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const level = process.argv[2] === 'major' || process.argv[2] === 'minor' ? process.argv[2] : 'patch';

const pkgPath = path.join(rootDir, 'package.json');
const versionTsPath = path.join(rootDir, 'src', 'version.ts');
const gradlePath = path.join(rootDir, 'android', 'app', 'build.gradle');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [majStr = '2', minStr = '0', patStr = '0'] = String(pkg.version || '2.0.0').split('.');
let major = Number(majStr) || 0;
let minor = Number(minStr) || 0;
let patch = Number(patStr) || 0;

if (level === 'major') {
  major += 1;
  minor = 0;
  patch = 0;
} else if (level === 'minor') {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}

const nextVersion = `${major}.${minor}.${patch}`;
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

let nextCode = 1;
if (fs.existsSync(versionTsPath)) {
  const versionTs = fs.readFileSync(versionTsPath, 'utf8');
  const codeMatch = versionTs.match(/APP_VERSION_CODE\s*=\s*(\d+)/);
  if (codeMatch) {
    nextCode = Number(codeMatch[1]) + 1;
  }
}

fs.writeFileSync(
  versionTsPath,
  `export const APP_VERSION = 'v${nextVersion}';\nexport const APP_VERSION_CODE = ${nextCode};\n`,
  'utf8'
);

if (fs.existsSync(gradlePath)) {
  let gradle = fs.readFileSync(gradlePath, 'utf8');
  gradle = gradle
    .replace(/versionCode\s+\d+/, `versionCode ${nextCode}`)
    .replace(/versionName\s+"[^"]+"/, `versionName "${nextVersion}"`);
  fs.writeFileSync(gradlePath, gradle, 'utf8');
}

console.log(`Updated PitStop-Sports to v${nextVersion} (versionCode ${nextCode})`);
