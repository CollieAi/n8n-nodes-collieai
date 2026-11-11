import type { IExecuteFunctions, INode, INodeExecutionData, OnError } from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

// n8n's sleep, observed and instant.
vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: vi.fn(async () => undefined),
}));

import { CollieAi } from '../nodes/CollieAi/CollieAi.node';
import { NEXT_STEP, type CheckErrorCode } from '../nodes/CollieAi/errors';

const KEY = 'clai_secret_key_value';
const TEXT = 'my card is 4111 1111 1111 1111';

type Answer =
	| { statusCode: number; body: unknown; headers?: Record<string, unknown> }
	| Error
	/** No answer of its own, as a server that keeps the response open: it ends
	 * only when the signal n8n's helper uses aborts, or never. */
	| 'until-cancelled'
	| 'never';

interface Setup {
	onError?: OnError;
	retryOnFail?: boolean;
	baseUrl?: unknown;
	credentialsError?: Error;
	paramError?: Error;
	items?: Array<Record<string, unknown>>;
	params?: Array<Record<string, unknown>>;
	answers?: Answer[];
	/** The execution's cancel signal; `null` for a context without one. */
	cancel?: AbortSignal | null;
}

const ALLOWED_JOB = {
	statusCode: 200,
	body: {
		job_id: 'job-1',
		status: 'completed',
		inbound_result: {
			allowed: true,
			blocked: false,
			filtered_content: 'my card is ****',
			triggered_rules: [
				{
					rule_id: 'r1',
					rule_name: 'Cards',
					rule_type: 'regex',
					decision: 'mask',
					monitoring: false,
					match_info: { matched_text: '4111 1111 1111 1111' },
				},
			],
		},
	},
};
const CREATED = {
	statusCode: 202,
	body: { job_id: 'job-1' },
	headers: { 'x-request-id': 'req-1' },
};

function run(setup: Setup) {
	const onError = setup.onError ?? 'stopWorkflow';
	const items: INodeExecutionData[] = (setup.items ?? [{ chatInput: 'hi' }]).map((json) => ({
		json: json as INodeExecutionData['json'],
	}));
	const answers = [...(setup.answers ?? [])];
	const contexts: IExecuteFunctions[] = [];
	// As n8n's helper (n8n-core 2.46 to 3.1): the signal it uses is the one
	// the calling context's getExecutionCancelSignal gives, not the options'.
	const httpRequestWithAuthentication = vi.fn<
		(this: IExecuteFunctions, type: string, options: object) => Promise<unknown>
	>(async function (this: IExecuteFunctions) {
		contexts.push(this);
		const next = answers.shift();
		if (next === undefined) throw new Error('no scripted answer');
		if (next === 'never') return await new Promise(() => undefined);
		if (next === 'until-cancelled') {
			const signal = this.getExecutionCancelSignal();
			return await new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => reject(new Error('canceled')));
			});
		}
		if (next instanceof Error) throw next;
		return { headers: {}, ...next };
	});
	const node = {
		id: 'n1',
		name: 'CollieAi',
		type: '@collieai/n8n-nodes-collieai.collieAi',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
		onError,
		retryOnFail: setup.retryOnFail,
	} as INode;
	// n8n's ExecuteContext keeps state that only its own instance can read,
	// as this private field: a method called on anything else fails.
	const own = new (class {
		readonly #node = node;
		getNode() {
			return this.#node;
		}
	})();
	const context = Object.assign(own, {
		getInputData: () => items,
		continueOnFail: () => onError !== 'stopWorkflow',
		getCredentials: async (type: string) => {
			if (type !== 'collieAiApi') throw new Error(`unexpected credential type ${type}`);
			if (setup.credentialsError) throw setup.credentialsError;
			return {
				apiKey: KEY,
				baseUrl: 'baseUrl' in setup ? setup.baseUrl : 'https://app.collieai.io/',
			};
		},
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
			if (setup.paramError && name === 'text') throw setup.paramError;
			const params = setup.params?.[itemIndex] ?? {};
			const defaults: Record<string, unknown> = { operation: 'checkInput', text: TEXT };
			if (name in params) return params[name];
			if (name in defaults) return defaults[name];
			return fallback;
		},
		getExecutionCancelSignal: () =>
			setup.cancel === null ? undefined : (setup.cancel ?? new AbortController().signal),
		helpers: { httpRequestWithAuthentication },
	}) as unknown as IExecuteFunctions;
	return {
		execute: () => new CollieAi().execute.call(context),
		httpRequestWithAuthentication,
		contexts,
		context,
		node,
	};
}

/** Everything an error carries that could leave n8n: its message, its
 * description and whatever it serializes to. */
function exposed(error: unknown): string {
	const e = error as NodeApiError;
	const seen = new WeakSet();
	const body = JSON.stringify(e, (_k, v) => {
		if (v !== null && typeof v === 'object') {
			if (seen.has(v)) return undefined;
			seen.add(v);
		}
		return v;
	});
	return [e.message, e.description, body, JSON.stringify(e.context)].join('\n');
}

describe('a check that passes', () => {
	it('keeps the input JSON, adds the result and pairs the item', async () => {
		const { execute } = run({ answers: [CREATED, ALLOWED_JOB] });
		const [out] = await execute();
		expect(out).toHaveLength(1);
		expect(out[0].pairedItem).toEqual({ item: 0 });
		expect(out[0].json).toMatchObject({
			chatInput: 'hi',
			collieai: {
				allowed: true,
				blocked: false,
				text: 'my card is ****',
				jobId: 'job-1',
				requestId: 'req-1',
			},
		});
		expect(out[0].error).toBeUndefined();
	});

	it('leaves the match details out unless asked', async () => {
		const plain = await run({ answers: [CREATED, ALLOWED_JOB] }).execute();
		expect(JSON.stringify(plain)).not.toContain('4111');
		const detailed = await run({
			params: [{ options: { includeMatchDetails: true } }],
			answers: [CREATED, ALLOWED_JOB],
		}).execute();
		expect(JSON.stringify(detailed)).toContain('matched_text');
	});

	it('calls CollieAi with the credential, the origin and full responses', async () => {
		const { execute, httpRequestWithAuthentication } = run({
			params: [{ conversationId: 'sess-1', options: { timeout: 12 } }],
			answers: [CREATED, ALLOWED_JOB],
		});
		await execute();
		const [type, create] = httpRequestWithAuthentication.mock.calls[0];
		expect(type).toBe('collieAiApi');
		expect(create).toMatchObject({
			method: 'POST',
			url: 'https://app.collieai.io/v1/jobs',
			body: { message_input: TEXT, inbound_only: true, conversation_id: 'sess-1' },
			json: true,
			headers: { 'X-CollieAi-SDK-Origin': 'n8n.check_input' },
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: 30_000,
		});
		const [, poll] = httpRequestWithAuthentication.mock.calls[1];
		expect(poll).toMatchObject({
			method: 'GET',
			url: 'https://app.collieai.io/v1/jobs/job-1',
			headers: { 'X-CollieAi-SDK-Origin': 'n8n.check_input' },
			timeout: 12_000,
		});
		expect(JSON.stringify(httpRequestWithAuthentication.mock.calls)).not.toContain(KEY);
	});

	it('runs an output check', async () => {
		const outputJob = {
			statusCode: 200,
			body: {
				job_id: 'job-1',
				status: 'outbound_blocked',
				outbound_result: { allowed: false, blocked: true, block_message: 'No' },
			},
		};
		const { execute, httpRequestWithAuthentication } = run({
			params: [{ operation: 'checkOutput' }],
			answers: [CREATED, outputJob],
		});
		const [out] = await execute();
		expect(out[0].json.collieai).toMatchObject({
			allowed: false,
			blocked: true,
			text: null,
			blockMessage: 'No',
		});
		expect(httpRequestWithAuthentication.mock.calls[0][1]).toMatchObject({
			body: { message_output: TEXT },
			headers: { 'X-CollieAi-SDK-Origin': 'n8n.check_output' },
		});
	});
});

// The node's failures, each where it can happen: before the first
// request, before the job exists, after it exists.
const FAILURES: Array<[string, Setup, string]> = [
	['Retry On Fail is on', { retryOnFail: true }, 'retry_on_fail_unsupported'],
	[
		'the credential cannot be read',
		{ credentialsError: new NodeOperationError({} as INode, 'Credentials not found') },
		'node_error',
	],
	['the Base URL is plain http', { baseUrl: 'http://app.collieai.io' }, 'invalid_base_url'],
	['the text is empty', { params: [{ text: '' }] }, 'empty_text'],
	['the text is not a string', { params: [{ text: 42 }] }, 'invalid_parameter'],
	['the operation is unknown', { params: [{ operation: 'nope' }] }, 'invalid_parameter'],
	['the conversation id is not a string', { params: [{ conversationId: 7 }] }, 'invalid_parameter'],
	[
		'a parameter cannot be read',
		{ paramError: new NodeOperationError({} as INode, 'Could not get parameter "text"') },
		'node_error',
	],
	[
		'the create is refused',
		{ answers: [{ statusCode: 422, body: { detail: [{ input: TEXT }] } }] },
		'rejected',
	],
	[
		'the create gets no answer',
		{ answers: [new Error(`connect ECONNREFUSED Authorization: Bearer ${KEY}`)] },
		'connection_error',
	],
	[
		'the job fails',
		{ answers: [CREATED, { statusCode: 200, body: { job_id: 'job-1', status: 'failed' } }] },
		'job_failed',
	],
	[
		'a poll gets a 5xx',
		{ answers: [CREATED, { statusCode: 500, body: { error: { message: TEXT } } }] },
		'server_error',
	],
];

describe.each(FAILURES)('when %s', (_case, setup, code) => {
	it('Stop Workflow: throws an n8n error with neither the key nor the text', async () => {
		const { execute } = run({ ...setup, onError: 'stopWorkflow' });
		const error = await execute().then(
			() => null,
			(e: unknown) => e,
		);
		expect(error instanceof NodeApiError || error instanceof NodeOperationError).toBe(true);
		const text = exposed(error);
		expect(text).toContain(`${NEXT_STEP[code as CheckErrorCode]} (code: ${code}`);
		expect(text).not.toContain(KEY);
		expect(text).not.toContain('4111');
	});

	it('Continue: a blocked item with the error and no top-level error', async () => {
		const { execute } = run({ ...setup, onError: 'continueRegularOutput' });
		const [out] = await execute();
		expect(out).toHaveLength(1);
		expect(out[0].error).toBeUndefined();
		expect(out[0].pairedItem).toEqual({ item: 0 });
		expect(out[0].json.chatInput).toBe('hi');
		expect(out[0].json.collieai).toMatchObject({
			allowed: false,
			blocked: true,
			text: null,
			blockMessage: null,
			triggeredRules: [],
			requestId: null,
			jobId: ['job_failed', 'server_error'].includes(code) ? 'job-1' : null,
			error: { code },
		});
		expect(JSON.stringify(out)).not.toContain(KEY);
		expect(JSON.stringify(out[0].json.collieai)).not.toContain('4111');
	});

	it('Continue (using error output): the item carries a top-level n8n error', async () => {
		const { execute } = run({ ...setup, onError: 'continueErrorOutput' });
		const [out] = await execute();
		expect(out).toHaveLength(1);
		expect(out[0].error).toBeInstanceOf(Error);
		expect(out[0].error?.message).not.toContain('4111');
		expect(exposed(out[0].error)).not.toContain(KEY);
		expect(out[0].json.collieai).toMatchObject({ allowed: false, error: { code } });
	});
});

describe('requests before the first one', () => {
	it.each([
		['Retry On Fail', { retryOnFail: true }],
		['a plain-http Base URL', { baseUrl: 'http://app.collieai.io' }],
		['an empty text', { params: [{ text: '' }] }],
	])('%s makes none', async (_case, setup) => {
		const { execute, httpRequestWithAuthentication } = run({
			...(setup as Setup),
			onError: 'continueRegularOutput',
		});
		await execute();
		expect(httpRequestWithAuthentication).not.toHaveBeenCalled();
	});
});

describe('a batch', () => {
	it('goes on after a failed item under Continue, in order, each item paired', async () => {
		const { execute, httpRequestWithAuthentication } = run({
			onError: 'continueRegularOutput',
			items: [{ n: 0 }, { n: 1 }, { n: 2 }],
			answers: [CREATED, ALLOWED_JOB, { statusCode: 500, body: {} }, CREATED, ALLOWED_JOB],
		});
		const [out] = await execute();
		expect(out.map((i) => [i.json.n, (i.json.collieai as { allowed: boolean }).allowed])).toEqual([
			[0, true],
			[1, false],
			[2, true],
		]);
		expect(out.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(5);
	});

	it('stops at the failed item under Stop Workflow', async () => {
		const { execute, httpRequestWithAuthentication } = run({
			items: [{ n: 0 }, { n: 1 }, { n: 2 }],
			answers: [CREATED, ALLOWED_JOB, { statusCode: 500, body: {} }],
		});
		await expect(execute()).rejects.toBeInstanceOf(NodeApiError);
		expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(3);
	});

	it('marks every item when the failure holds for all of them', async () => {
		const { execute } = run({
			onError: 'continueErrorOutput',
			retryOnFail: true,
			items: [{ n: 0 }, { n: 1 }],
		});
		const [out] = await execute();
		expect(out).toHaveLength(2);
		expect(out.every((i) => i.error instanceof NodeOperationError)).toBe(true);
	});
});

describe('what a failed check says', () => {
	// Labels, not %j: an n8n error serializes with its timestamp, and a test
	// name that changes between runs is one Stryker cannot select.
	it.each([
		[
			'Retry On Fail',
			{ retryOnFail: true },
			'Turn off Retry On Fail for this node: n8n would re-run every item and create a new, billed check for each',
		],
		['an unknown operation', { params: [{ operation: 'nope' }] }, 'Unknown operation'],
		['a text that is not a string', { params: [{ text: 42 }] }, 'Text must be a string'],
		[
			'a conversation id that is not a string',
			{ params: [{ conversationId: 7 }] },
			'Conversation ID must be a string',
		],
		[
			"an n8n error, with n8n's message",
			{ paramError: new NodeOperationError({} as INode, 'Could not get parameter "text"') },
			'Could not get parameter "text"',
		],
		[
			'a long n8n error, cut at 300 characters',
			{ paramError: new NodeOperationError({} as INode, 'x'.repeat(400)) },
			'x'.repeat(300),
		],
		[
			'any other error, without its message',
			{ credentialsError: new Error(`token ${KEY}`) },
			'The check could not run',
		],
	] as Array<[string, Setup, string]>)('%s', async (_label, setup, message) => {
		const [out] = await run({ ...setup, onError: 'continueRegularOutput' }).execute();
		expect(out[0].json.collieai).toMatchObject({ error: { message } });
	});

	it.each([
		[
			'a refused create names the server code',
			{ answers: [{ statusCode: 400, body: { error: { code: 'invalid_input_gate' } } }] },
			`${NEXT_STEP.rejected} (code: rejected, server code: invalid_input_gate)`,
		],
		[
			'a failed poll names the job',
			{ answers: [CREATED, { statusCode: 500, body: {} }] },
			`${NEXT_STEP.server_error} (code: server_error, job ID: job-1)`,
		],
		[
			'an error before the job names only the code',
			{ params: [{ text: '' }] },
			"Map a non-empty value to 'Text', or leave the empty items out before this node (code: empty_text)",
		],
	] as Array<[string, Setup, string]>)('%s', async (_label, setup, description) => {
		const error = (await run(setup)
			.execute()
			.catch((e: unknown) => e)) as NodeApiError;
		expect(error.description).toBe(description);
	});
});

describe('waiting for the verdict', () => {
	it("sleeps with n8n's sleep, in milliseconds, between polls", async () => {
		vi.mocked(sleep).mockClear();
		const pending = { statusCode: 200, body: { job_id: 'job-1', status: 'processing_inbound' } };
		const [out] = await run({ answers: [CREATED, pending, ALLOWED_JOB] }).execute();
		expect(out[0].json.collieai).toMatchObject({ allowed: true });
		expect(vi.mocked(sleep)).toHaveBeenCalledWith(50);
	});
});

describe("the request deadline, through n8n's helper", () => {
	it("gives the helper's context the check's signal, the execution's cancel joined", async () => {
		const cancel = new AbortController();
		const { execute, httpRequestWithAuthentication, contexts, context, node } = run({
			cancel: cancel.signal,
			answers: [CREATED, ALLOWED_JOB],
		});
		await execute();
		const [, create] = httpRequestWithAuthentication.mock.calls[0];
		const signal = contexts[0].getExecutionCancelSignal();
		expect(signal).toBe((create as { abortSignal: AbortSignal }).abortSignal);
		expect(signal?.aborted).toBe(false);
		// The rest of the context is n8n's own: its values, and its methods
		// bound to it.
		expect(contexts[0].helpers).toBe(context.helpers);
		expect(contexts[0].getNode()).toBe(node);
		await expect(contexts[0].getCredentials('collieAiApi')).resolves.toMatchObject({ apiKey: KEY });
		cancel.abort();
		expect(signal?.aborted).toBe(true);
	});

	it('uses the deadline alone when the execution has no cancel signal', async () => {
		const { execute, httpRequestWithAuthentication, contexts } = run({
			cancel: null,
			answers: [CREATED, ALLOWED_JOB],
		});
		const [out] = await execute();
		expect(out[0].json.collieai).toMatchObject({ allowed: true });
		const [, create] = httpRequestWithAuthentication.mock.calls[0];
		const signal = contexts[0].getExecutionCancelSignal();
		expect(signal).toBe((create as { abortSignal: AbortSignal }).abortSignal);
		expect(signal?.aborted).toBe(false);
	});

	it.each([
		['closes a poll that the server keeps open at the deadline', 'until-cancelled'],
		['ends the check at the deadline even when the request is never closed', 'never'],
	] as const)('%s', async (_case, answer) => {
		const { execute, contexts } = run({
			onError: 'continueRegularOutput',
			params: [{ options: { timeout: 1 } }],
			answers: [CREATED, answer],
		});
		const started = performance.now();
		const [out] = await execute();
		const elapsedMs = performance.now() - started;
		expect(out[0].json.collieai).toMatchObject({
			allowed: false,
			blocked: true,
			error: { code: 'timeout', message: 'No verdict within 1 s' },
		});
		expect(elapsedMs).toBeGreaterThanOrEqual(900);
		expect(elapsedMs).toBeLessThan(1500);
		expect(contexts[1].getExecutionCancelSignal()?.aborted).toBe(true);
	});
});
