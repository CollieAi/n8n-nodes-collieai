import { CheckError } from './errors';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The credential's Base URL without a trailing slash. `https://` only, and
 * `http://` only on this machine, as in the LiteLLM adapter: otherwise the
 * key and the checked text would cross the network unencrypted.
 */
export function normalizeBaseUrl(raw: unknown): string | CheckError {
	const invalid = new CheckError(
		'invalid_base_url',
		'Base URL must be an https:// URL (http:// only for localhost), with no user name, password, query or fragment',
	);
	if (typeof raw !== 'string') return invalid;
	const trimmed = raw.trim().replace(/\/+$/, '');
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return invalid;
	}
	const secure = url.protocol === 'https:';
	const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
	if (
		!(secure || local) ||
		url.search !== '' ||
		url.hash !== '' ||
		url.username !== '' ||
		url.password !== ''
	) {
		return invalid;
	}
	return trimmed;
}
