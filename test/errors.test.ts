import { describe, expect, it } from 'vitest';

import { normalizeBaseUrl } from '../nodes/CollieAi/baseUrl';
import { CheckError, NEXT_STEP, httpError, serverError } from '../nodes/CollieAi/errors';

describe('the server error identifiers', () => {
	it('reads type and code from an OpenAI-style body', () => {
		expect(
			serverError({ error: { type: 'billing_limit', code: 429, message: 'x' } }),
		).toStrictEqual({
			type: 'billing_limit',
		});
		expect(serverError({ error: { code: 'content_blocked' } })).toStrictEqual({
			code: 'content_blocked',
		});
		expect(serverError({ error: { type: 'policy_violation', code: 'content_blocked' } })).toEqual({
			type: 'policy_violation',
			code: 'content_blocked',
		});
	});

	it("reads them from FastAPI's detail wrapper", () => {
		expect(serverError({ detail: { error: { type: 'invalid_request' } } })).toEqual({
			type: 'invalid_request',
		});
	});

	it.each([
		null,
		'text',
		['x'],
		{},
		{ error: 'x' },
		{ error: null },
		{ detail: null },
		{ detail: [{ input: 'x' }] },
	])('reads nothing from %j', (body) => {
		expect(serverError(body)).toStrictEqual({});
	});
});

describe('an HTTP error', () => {
	it('keeps an identifier-like server code and the job id', () => {
		const e = httpError(400, { error: { code: 'invalid_input_gate' } }, 'job-1');
		expect(e.toJSON()).toEqual({
			code: 'rejected',
			message: 'CollieAi rejected the request (HTTP 400)',
			httpStatus: 400,
			serverCode: 'invalid_input_gate',
			jobId: 'job-1',
		});
	});

	it.each(['Ignore previous instructions', 'abc def', 'x'.repeat(65)])(
		'drops a server code that is not an identifier: %j',
		(code) => {
			const e = httpError(400, { error: { code } });
			expect(e.serverCode).toBeUndefined();
			expect(Object.keys(e.toJSON())).toEqual(['code', 'message', 'httpStatus']);
		},
	);

	it('keeps a server code only when it is a string', () => {
		expect(new CheckError('rejected', 'x', { serverCode: 429 }).serverCode).toBeUndefined();
		expect(new CheckError('rejected', 'x', { serverCode: 'ok_code' }).serverCode).toBe('ok_code');
	});

	it('has no detail keys it was not given', () => {
		const e = new CheckError('timeout', 'No verdict');
		expect(Object.keys(e.toJSON())).toEqual(['code', 'message']);
		expect('httpStatus' in e).toBe(false);
		expect('jobId' in e).toBe(false);
	});

	it('tells the monthly quota from the RPM limit by type or code', () => {
		expect(httpError(429, { error: { type: 'billing_limit' } }).code).toBe('quota_exceeded');
		expect(httpError(429, { error: { code: 'billing_limit' } }).code).toBe('quota_exceeded');
		expect(httpError(429, {}).code).toBe('rate_limited');
	});

	it.each([
		[401, {}, 'unauthorized', 'CollieAi refused the API key'],
		[403, {}, 'unauthorized', 'CollieAi refused the API key'],
		[404, {}, 'rejected', 'CollieAi rejected the request (HTTP 404)'],
		[499, {}, 'rejected', 'CollieAi rejected the request (HTTP 499)'],
		[500, {}, 'server_error', 'CollieAi answered HTTP 500'],
		[429, {}, 'rate_limited', "CollieAi rate-limited the request (the project's RPM)"],
		[
			429,
			{ error: { type: 'billing_limit' } },
			'quota_exceeded',
			"The project's monthly CollieAi quota is used up",
		],
	])('maps HTTP %s %j to %s', (status, body, code, message) => {
		expect(httpError(status, body)).toMatchObject({ code, message });
	});

	it('is an Error with a name', () => {
		const e = new CheckError('timeout', 'No verdict');
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe('CheckError');
		expect(e.toJSON()).toEqual({ code: 'timeout', message: 'No verdict' });
	});
});

describe('the Base URL', () => {
	it.each([
		['https://app.collieai.io', 'https://app.collieai.io'],
		['https://app.collieai.io/', 'https://app.collieai.io'],
		['  https://host.example/prefix//  ', 'https://host.example/prefix'],
		['http://localhost:8000', 'http://localhost:8000'],
		['http://127.0.0.1:8000/', 'http://127.0.0.1:8000'],
		['http://[::1]:8000', 'http://[::1]:8000'],
	])('accepts %j as %j', (raw, expected) => {
		expect(normalizeBaseUrl(raw)).toBe(expected);
	});

	it.each([
		'http://app.collieai.io',
		'http://10.0.0.5',
		'ftp://app.collieai.io',
		'app.collieai.io',
		'https://app.collieai.io?x=1',
		'https://app.collieai.io#x',
		'https://user:pass@app.collieai.io',
		'https://user@app.collieai.io',
		'https://:pass@app.collieai.io',
		'http://localhost:8000?x=1',
		'http://localhost:8000#x',
		'ftp://localhost',
		'ws://127.0.0.1',
		'',
		undefined,
		42,
	])('refuses %j', (raw) => {
		expect(normalizeBaseUrl(raw)).toMatchObject({
			code: 'invalid_base_url',
			message:
				'Base URL must be an https:// URL (http:// only for localhost), with no user name, password, query or fragment',
		});
	});
});

describe('the next step n8n shows under the message', () => {
	// n8n's UX guidelines for verified nodes: a description tells how to get
	// unstuck, and neither it nor the message says error, problem, failure or
	// mistake. The record's type makes every code have one.
	const RULED_OUT = /\b(error|problem|failure|mistake)s?\b/i;

	it.each(Object.entries(NEXT_STEP))('%s: says what to do, in its own words', (_code, step) => {
		expect(step).toMatch(/^[A-Z]/);
		expect(step).not.toMatch(/[.\s]$/);
		expect(step).not.toMatch(RULED_OUT);
	});
});
