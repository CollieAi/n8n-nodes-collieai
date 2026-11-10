import type {
	ICredentialDataDecryptedObject,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';
import { UserError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { CollieAiApi } from '../credentials/CollieAiApi.credentials';
import { CollieAi } from '../nodes/CollieAi/CollieAi.node';

// What n8n reads from the description is behaviour: the parameter names the
// node asks for, the defaults n8n fills in, the credential it binds.
const description = new CollieAi().description;

function property(name: string, within: INodeProperties[] = description.properties) {
	const found = within.find((p) => p.name === name);
	if (found === undefined) throw new Error(`no property ${name}`);
	return found;
}

describe('the node description', () => {
	it('offers exactly the two checks, Check Input by default', () => {
		const operation = property('operation');
		expect(operation.default).toBe('checkInput');
		expect(operation.noDataExpression).toBe(true);
		expect((operation.options ?? []).map((o) => ('value' in o ? o.value : undefined))).toEqual([
			'checkInput',
			'checkOutput',
		]);
	});

	it('asks for the text and an optional conversation id', () => {
		expect(property('text')).toMatchObject({ type: 'string', required: true, default: '' });
		expect(property('conversationId')).toMatchObject({ type: 'string', default: '' });
	});

	it('keeps match details off and the timeout at 30 s by default', () => {
		const options = property('options').options as INodeProperties[];
		expect(property('includeMatchDetails', options)).toMatchObject({
			type: 'boolean',
			default: false,
		});
		expect(property('timeout', options)).toMatchObject({
			type: 'number',
			default: 30,
			typeOptions: { minValue: 1, maxValue: 300 },
		});
	});

	it('has one main input and one main output', () => {
		expect(description.inputs).toEqual(['main']);
		expect(description.outputs).toEqual(['main']);
	});

	it('binds the CollieAi credential', () => {
		expect(description.credentials).toEqual([{ name: new CollieAiApi().name, required: true }]);
		expect(description.name).toBe('collieAi');
	});
});

describe('the credential', () => {
	const credential = new CollieAiApi();

	const KEY = 'clai_secret_key_value';
	const BASE_URL_RULE =
		'Base URL must be an https:// URL (http:// only for localhost), with no user name, password, query or fragment';
	const authenticate = async (baseUrl: unknown, options: IHttpRequestOptions) =>
		await credential.authenticate(
			{ apiKey: KEY, baseUrl } as ICredentialDataDecryptedObject,
			options,
		);

	it.each([
		['the node, by its full URL', { url: 'https://app.collieai.io/v1/jobs' }],
		[
			'the credential test, by the Base URL as typed',
			{ baseURL: 'https://app.collieai.io/', url: '/v1/jobs' },
		],
		["n8n's legacy request, by its uri", { uri: 'https://app.collieai.io/v1/jobs' }],
	])('sends the key as a bearer token to %s', async (_case, request) => {
		const options = {
			method: 'GET' as const,
			headers: { Accept: 'application/json' },
			...request,
		} as IHttpRequestOptions;
		await expect(authenticate('https://app.collieai.io/', options)).resolves.toEqual({
			...options,
			sendCredentialsOnCrossOriginRedirect: false,
			headers: { Accept: 'application/json', Authorization: `Bearer ${KEY}` },
		});
		expect(options.headers).toEqual({ Accept: 'application/json' });
	});

	it.each([
		['asked for', true],
		['not mentioned', undefined],
	])('never keeps the key on a redirect to another origin, %s', async (_case, keep) => {
		const options = await authenticate('https://app.collieai.io', {
			url: 'https://app.collieai.io/v1/jobs',
			sendCredentialsOnCrossOriginRedirect: keep,
		});
		expect(options.sendCredentialsOnCrossOriginRedirect).toBe(false);
	});

	it('reads the url before the uri, as the transport does', async () => {
		const options = await authenticate('https://app.collieai.io', {
			url: 'https://app.collieai.io/v1/jobs',
			uri: 'https://other.example/v1/jobs',
		} as IHttpRequestOptions);
		expect(options.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
	});

	it.each([
		'http://host.example',
		'http://127.0.0.2:8000',
		'https://:pass@app.collieai.io',
		'https://app.collieai.io?x=1',
		'https://app.collieai.io#x',
		undefined,
	])('refuses the Base URL %j before adding the key', async (baseUrl) => {
		const refused = authenticate(baseUrl, {
			baseURL: typeof baseUrl === 'string' ? baseUrl : undefined,
			url: '/v1/jobs',
		});
		await expect(refused).rejects.toThrow(UserError);
		await expect(refused).rejects.toThrow(BASE_URL_RULE);
	});

	it.each([
		['another host', { url: 'https://other.example/v1/jobs' }],
		['plain HTTP to the same host', { url: 'http://app.collieai.io/v1/jobs' }],
		['another port', { url: 'https://app.collieai.io:8443/v1/jobs' }],
		['another base', { baseURL: 'https://other.example', url: '/v1/jobs' }],
		['no URL it can read', { url: 'https://' }],
		['another host, by a legacy uri', { uri: 'https://other.example/v1/jobs' }],
		['a path with no base', { url: '/v1/jobs' }],
		['no URL at all', {}],
		['a base with no URL', { baseURL: 'https://app.collieai.io' }],
		['a base with a null legacy uri', { baseURL: 'https://app.collieai.io', uri: null }],
		['a protocol-relative URL', { baseURL: 'https://app.collieai.io', url: '//other.example/v1' }],
	])('refuses a request to %s', async (_case, request) => {
		const refused = authenticate('https://app.collieai.io', request as IHttpRequestOptions);
		await expect(refused).rejects.toThrow(UserError);
		await expect(refused).rejects.toThrow(
			'The CollieAi API key is sent only to the Base URL of its credential',
		);
	});

	it('hides the key and defaults to app.collieai.io', () => {
		expect(property('apiKey', credential.properties)).toMatchObject({
			typeOptions: { password: true },
			required: true,
		});
		expect(property('baseUrl', credential.properties).default).toBe('https://app.collieai.io');
	});

	it('is tested with a job status that no job has', () => {
		expect(credential.test.request).toEqual({
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/jobs',
			method: 'GET',
			qs: { page_size: 1, status_filter: 'n8n_credential_test' },
		});
	});
});
