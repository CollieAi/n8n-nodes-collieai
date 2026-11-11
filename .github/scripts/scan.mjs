// n8n's own scan (@n8n/scan-community-package), both of its lint legs, before
// publishing: the source as the scanner lints it from GitHub, and the packed
// tarball. The scanner's provenance check and its downloads need a published
// version; the release runs the real scanner on that.
//
// node scan.mjs <scanner install prefix> <source dir> <unpacked tarball dir>
import { pathToFileURL } from 'node:url';

const [prefix, source, tarball] = process.argv.slice(2);
const scanner = await import(
	pathToFileURL(`${prefix}/node_modules/@n8n/scan-community-package/dist/scanner.js`).href
);

let passed = true;
for (const [leg, dir, patterns] of [
	['source', source, scanner.SOURCE_FILE_PATTERNS],
	['tarball', tarball, ['**/*.js', 'package.json']],
]) {
	const result = await scanner.analyzePackage(dir, patterns);
	// "No files found" passes in the scanner; here it means a wrong directory.
	const ok = result.passed && result.message === undefined;
	console.log(`${leg}: ${ok ? 'passed' : (result.message ?? 'nothing scanned')}`);
	if (result.details) console.log(result.details);
	passed &&= ok;
}
process.exitCode = passed ? 0 : 1;
