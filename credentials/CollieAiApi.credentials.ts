import type {
	Icon,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';
import { UserError } from 'n8n-workflow';

import { normalizeBaseUrl } from '../nodes/CollieAi/baseUrl';
import { CheckError } from '../nodes/CollieAi/errors';

/** Where n8n's transport sends a request: `url`, or else `uri` (its legacy
 * requests, the HTTP Request node's among them), against `baseURL` when there
 * is one (n8n-core 2.46 to 3.1). `null` when there is no URL to read. */
function targetOf(options: IHttpRequestOptions): URL | null {
	const raw: unknown = options.url ?? (options as { uri?: unknown }).uri;
	if (raw === undefined || raw === null) return null;
	try {
		return new URL(
			String(raw),
			options.baseURL === undefined ? undefined : String(options.baseURL),
		);
	} catch {
		return null;
	}
}

export class CollieAiApi implements ICredentialType {
	// Stryker disable all: UI copy. The fields that are behaviour (the name,
	// the key's password field, the Base URL default, the test request) are
	// pinned by test/description.test.ts.
	name = 'collieAiApi';

	displayName = 'CollieAi API';

	icon: Icon = { light: 'file:collieai.svg', dark: 'file:collieai.dark.svg' };

	documentationUrl = 'https://github.com/CollieAi/n8n-nodes-collieai#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'The API key of your CollieAi project (starts with clai_)',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://app.collieai.io',
			description: 'Where CollieAi runs. Change it only for a dedicated CollieAi host.',
		},
	];
	// Stryker restore all

	// n8n adds the key here for every request with this credential, its own
	// credential test included, which takes the Base URL as typed. So the URL
	// is checked here, by the node's own rule, before the key is added, and
	// the key goes only to that URL's origin: never over plain HTTP to another
	// host, never to another site through n8n's HTTP Request node, nor on a
	// redirect to another origin, where that node asks n8n to keep the key.
	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const baseUrl = normalizeBaseUrl(credentials.baseUrl);
		if (baseUrl instanceof CheckError) throw new UserError(baseUrl.message);
		const target = targetOf(requestOptions);
		if (target === null || target.origin !== new URL(baseUrl).origin) {
			throw new UserError('The CollieAi API key is sent only to the Base URL of its credential');
		}
		return {
			...requestOptions,
			sendCredentialsOnCrossOriginRedirect: false,
			headers: {
				...requestOptions.headers,
				Authorization: `Bearer ${String(credentials.apiKey)}`,
			},
		};
	}

	// A status no job has: the key and the project are checked, no job data
	// is read, and the total is counted over no rows.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/jobs',
			method: 'GET',
			qs: {
				page_size: 1,
				status_filter: 'n8n_credential_test',
			},
		},
	};
}
