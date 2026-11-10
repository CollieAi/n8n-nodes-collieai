import { describe, expect, it, vi } from 'vitest';

import {
	ORIGINS,
	POLL_INTERVAL_S,
	REQUEST_TIMEOUT_S,
	header,
	retryAfterSeconds,
	runCheck,
	untilAborted,
	type CheckDeps,
	type CheckParams,
	type HttpResponse,
} from '../nodes/CollieAi/check';
import { CheckError } from '../nodes/CollieAi/errors';
import { ALLOWED, fakeDeps, job, json } from './helpers';

const CREATED = json(
	202,
	{ job_id: 'job-1', status: 'processing_inbound' },
	{ 'x-request-id': 'req-9' },
);

function params(overrides: Partial<CheckParams> = {}): CheckParams {
	return {
		phase: 'input',
		text: 'secret text',
		conversationId: '',
		timeoutS: 30,
		includeMatchDetails: false,
		...overrides,
	};
}

describe('the create request', () => {
	it('sends the input body, the origin and nothing else', async () => {
		const { deps, requests } = fakeDeps([CREATED, job('completed', ALLOWED)]);
		await runCheck(deps, params());
		expect(requests[0]).toMatchObject({
			method: 'POST',
			path: '/v1/jobs',
			body: { message_input: 'secret text', inbound_only: true },
			origin: ORIGINS.input,
			timeoutMs: REQUEST_TIMEOUT_S * 1000,
		});
		expect(Object.keys(requests[0].body ?? {}).sort()).toEqual(['inbound_only', 'message_input']);
	});

	it('sends the output body for an output check', async () => {
		const { deps, requests } = fakeDeps([CREATED, job('completed', ALLOWED)]);
		await runCheck(deps, params({ phase: 'output' }));
		expect(requests[0].body).toEqual({ message_output: 'secret text' });
		expect(requests[0].origin).toBe('n8n.check_output');
		expect(requests[1].origin).toBe('n8n.check_output');
	});

	it('sends the conversation id when there is one', async () => {
		const { deps, requests } = fakeDeps([CREATED, job('completed', ALLOWED)]);
		await runCheck(deps, params({ conversationId: 'sess-1' }));
		expect(requests[0].body).toMatchObject({ conversation_id: 'sess-1' });
	});

	it('refuses an empty text before any request', async () => {
		const { deps, requests } = fakeDeps([]);
		const r = await runCheck(deps, params({ text: '' }));
		expect(r).toMatchObject({ code: 'empty_text' });
		expect(requests).toHaveLength(0);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 3_000_000])(
		'refuses the timeout %s before any request',
		async (timeoutS) => {
			const { deps, requests } = fakeDeps([]);
			const r = await runCheck(deps, params({ timeoutS }));
			expect(r).toMatchObject({ code: 'invalid_parameter' });
			expect(requests).toHaveLength(0);
		},
	);

	it.each([
		[401, {}, 'unauthorized'],
		[403, {}, 'unauthorized'],
		[422, { detail: [{ input: 'secret text' }] }, 'rejected'],
		[429, { error: { type: 'billing_limit', code: 429 } }, 'quota_exceeded'],
		[429, { error: { type: 'rate_limit_exceeded' } }, 'rate_limited'],
		[500, '<html>oops</html>', 'server_error'],
		[503, {}, 'server_error'],
	])('answers %s with %s and never repeats the create', async (status, body, code) => {
		const { deps, requests } = fakeDeps([json(status as number, body, { 'retry-after': '1' })]);
		const r = await runCheck(deps, params());
		expect(r).toBeInstanceOf(CheckError);
		expect(r).toMatchObject({ code, httpStatus: status });
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(r)).not.toContain('secret text');
	});

	it('is a connection error, not repeated, when the create gets no answer', async () => {
		const { deps, requests } = fakeDeps([{ reject: true }]);
		const r = await runCheck(deps, params());
		expect(r).toMatchObject({ code: 'connection_error' });
		expect(requests).toHaveLength(1);
	});

	it('is a timeout when the create hit its own deadline', async () => {
		const { deps } = fakeDeps([{ reject: true, abort: true }]);
		expect(await runCheck(deps, params())).toMatchObject({ code: 'timeout' });
	});

	it.each([
		['no job id', { status: 'processing_inbound' }],
		['an empty job id', { job_id: '' }],
		['a non-string job id', { job_id: 7 }],
		['a body that is not an object', 'job-1'],
	])('is a malformed answer with %s', async (_case, body) => {
		const { deps, requests } = fakeDeps([json(202, body)]);
		expect(await runCheck(deps, params())).toMatchObject({ code: 'invalid_response' });
		expect(requests).toHaveLength(1);
	});
	it.each([
		[200, true],
		[202, true],
		[199, false],
		[300, false],
	])('takes a create answered %s as created: %s', async (status, ok) => {
		const { deps, requests } = fakeDeps([
			json(status, { job_id: 'job-1' }),
			job('completed', ALLOWED),
		]);
		const r = await runCheck(deps, params());
		if (ok) expect(r).toMatchObject({ allowed: true });
		else expect(r).toMatchObject({ code: 'rejected', httpStatus: status });
		expect(requests).toHaveLength(ok ? 2 : 1);
	});

	it('is a malformed answer, not a crash, when the create body is null', async () => {
		const { deps } = fakeDeps([json(202, null)]);
		expect(await runCheck(deps, params())).toMatchObject({ code: 'invalid_response' });
	});

	it.each([
		[{ text: '' }, [], 'empty_text', 'Text is empty: there is nothing to check'],
		[{ timeoutS: 0 }, [], 'invalid_parameter', 'Timeout must be a positive number of seconds'],
		[{}, [{ reject: true, abort: true }], 'timeout', 'CollieAi did not answer within 30 s'],
		[{}, [{ reject: true }], 'connection_error', 'Could not reach CollieAi'],
		[{}, [json(202, {})], 'invalid_response', 'CollieAi did not return a job id'],
		[{}, [CREATED, json(200, 'x')], 'invalid_response', 'CollieAi returned a malformed result'],
		[{}, [CREATED, { reject: true }], 'connection_error', 'Lost the connection to CollieAi'],
		[{}, [CREATED, job('expired')], 'job_failed', "The check ended as 'expired' without a verdict"],
		[{ timeoutS: 7 }, [CREATED, { reject: true, abort: true }], 'timeout', 'No verdict within 7 s'],
	] as const)('says what failed: %j → %s', async (overrides, steps, code, message) => {
		const { deps } = fakeDeps([...steps] as never);
		const r = await runCheck(deps, params(overrides as Partial<CheckParams>));
		expect(r).toMatchObject({ code, message });
	});
});

describe('polling', () => {
	it('polls the job until its verdict and returns it', async () => {
		const { deps, requests, sleeps } = fakeDeps([
			CREATED,
			job('processing_inbound'),
			job('completed', { ...ALLOWED, filtered_content: 'masked' }),
		]);
		const r = await runCheck(deps, params());
		expect(r).toMatchObject({
			allowed: true,
			text: 'masked',
			jobId: 'job-1',
			requestId: 'req-9',
		});
		expect(requests.map((q) => [q.method, q.path])).toEqual([
			['POST', '/v1/jobs'],
			['GET', '/v1/jobs/job-1'],
			['GET', '/v1/jobs/job-1'],
		]);
		expect(requests[1].origin).toBe(ORIGINS.input);
		expect(sleeps).toEqual([POLL_INTERVAL_S]);
	});

	it('escapes the job id in the path', async () => {
		const { deps, requests } = fakeDeps([
			json(202, { job_id: 'a/b?c' }),
			job('completed', ALLOWED),
		]);
		await runCheck(deps, params());
		expect(requests[1].path).toBe('/v1/jobs/a%2Fb%3Fc');
	});

	it('bounds each poll by the time left', async () => {
		const { deps, requests } = fakeDeps([CREATED, job('completed', ALLOWED)]);
		await runCheck(deps, params({ timeoutS: 12 }));
		expect(requests[1].timeoutMs).toBe(12_000);
	});

	it.each([
		['completed', 'input'],
		['inbound_blocked', 'input'],
		['completed', 'output'],
		['outbound_blocked', 'output'],
	] as const)('takes %s as the %s verdict', async (status, phase) => {
		const { deps } = fakeDeps([CREATED, job(status, { allowed: false, blocked: true })]);
		expect(await runCheck(deps, params({ phase }))).toMatchObject({ blocked: true });
	});

	it('keeps polling a status that is not its own verdict', async () => {
		const { deps, requests } = fakeDeps([
			CREATED,
			job('outbound_blocked', ALLOWED),
			job('completed', ALLOWED),
		]);
		await runCheck(deps, params({ phase: 'input' }));
		expect(requests).toHaveLength(3);
	});

	it.each(['failed', 'expired'])('is a failed job when the job ends %s', async (status) => {
		const { deps } = fakeDeps([CREATED, job(status)]);
		expect(await runCheck(deps, params())).toMatchObject({ code: 'job_failed', jobId: 'job-1' });
	});

	it('is a connection error, not repeated, when a poll gets no answer', async () => {
		const { deps, requests } = fakeDeps([CREATED, { reject: true }]);
		expect(await runCheck(deps, params())).toMatchObject({
			code: 'connection_error',
			jobId: 'job-1',
		});
		expect(requests).toHaveLength(2);
	});

	it('is a timeout when the poll hit the deadline', async () => {
		const { deps } = fakeDeps([CREATED, { reject: true, abort: true }]);
		expect(await runCheck(deps, params())).toMatchObject({ code: 'timeout' });
	});

	it('is a timeout when a failed poll used up the budget', async () => {
		const { deps } = fakeDeps([CREATED, { reject: true, advanceS: 31 }]);
		expect(await runCheck(deps, params())).toMatchObject({ code: 'timeout' });
	});

	it('is a server error, not repeated, on a 5xx poll', async () => {
		const { deps, requests } = fakeDeps([CREATED, json(502, 'bad gateway')]);
		expect(await runCheck(deps, params())).toMatchObject({ code: 'server_error', jobId: 'job-1' });
		expect(requests).toHaveLength(2);
	});

	it('is a malformed answer when a poll body is not an object', async () => {
		const { deps } = fakeDeps([CREATED, json(200, ['completed'])]);
		expect(await runCheck(deps, params())).toMatchObject({ code: 'invalid_response' });
	});

	it.each([199, 300])('is an error, not repeated, on a poll answered %s', async (status) => {
		const { deps, requests } = fakeDeps([CREATED, json(status, {})]);
		expect(await runCheck(deps, params())).toMatchObject({ httpStatus: status, jobId: 'job-1' });
		expect(requests).toHaveLength(2);
	});

	it('is a malformed answer with its job id, not a crash, when a poll body is null', async () => {
		const { deps } = fakeDeps([CREATED, json(200, null)]);
		expect(await runCheck(deps, params())).toMatchObject({
			code: 'invalid_response',
			jobId: 'job-1',
		});
	});

	it('waits out a 429 on a poll and goes on', async () => {
		const { deps, sleeps } = fakeDeps([
			CREATED,
			json(429, {}, { 'retry-after': '2' }),
			job('completed', ALLOWED),
		]);
		expect(await runCheck(deps, params())).toMatchObject({ allowed: true });
		expect(sleeps[0]).toBeGreaterThanOrEqual(2);
	});

	it('gives up on 429s that leave no room in the budget', async () => {
		const { deps, requests } = fakeDeps([
			CREATED,
			json(429, { error: { type: 'rate_limit_exceeded' } }, { 'retry-after': '60' }),
		]);
		expect(await runCheck(deps, params())).toMatchObject({ code: 'rate_limited' });
		expect(requests).toHaveLength(2);
	});

	it('times out a job that never finishes, after a bounded number of polls', async () => {
		const pending = Array.from({ length: 200 }, () => job('processing_inbound'));
		const { deps, requests, left } = fakeDeps([CREATED, ...pending]);
		const r = await runCheck(deps, params({ timeoutS: 5 }));
		expect(r).toMatchObject({ code: 'timeout', jobId: 'job-1' });
		expect(requests.length).toBeLessThan(60);
		expect(left()).toBeGreaterThan(0);
	});

	it('does not accept a verdict that landed after the deadline', async () => {
		const { deps } = fakeDeps([CREATED, { respond: job('completed', ALLOWED), advanceS: 31 }]);
		expect(await runCheck(deps, params())).toMatchObject({ code: 'timeout' });
	});

	it('follows the server hint once out of the warm phase', async () => {
		const pending = Array.from({ length: 40 }, () =>
			job('processing_inbound', undefined, { suggested_poll_ms: 1000 }),
		);
		const { deps, sleeps } = fakeDeps([CREATED, ...pending, job('completed', ALLOWED)]);
		await runCheck(deps, params());
		expect(Math.max(...sleeps)).toBeGreaterThan(0.5);
		expect(sleeps.every((s) => s <= 5)).toBe(true);
	});
});

/** A transport that never answers on its own and ignores the request's
 * signal, as n8n's authenticated helper ignores the one in the options; the
 * test aborts the deadlines and delivers late answers by hand. */
function deafDeps(createAnswer: HttpResponse | null) {
	const deadlines: AbortController[] = [];
	const late: Array<(answer: HttpResponse) => void> = [];
	let calls = 0;
	const deps: CheckDeps = {
		request: async () => {
			calls += 1;
			if (calls === 1 && createAnswer !== null) return createAnswer;
			return await new Promise<HttpResponse>((resolve) => late.push(resolve));
		},
		sleep: async () => undefined,
		monotonic: () => 1000,
		rand: () => 0.5,
		deadline: () => {
			const controller = new AbortController();
			deadlines.push(controller);
			return controller.signal;
		},
	};
	return { deps, deadlines, late, calls: () => calls };
}

describe('a transport that ignores the signal', () => {
	it('still ends the create at its deadline', async () => {
		const { deps, deadlines, late, calls } = deafDeps(null);
		const pending = runCheck(deps, params());
		await vi.waitFor(() => expect(late).toHaveLength(1));
		deadlines[0].abort();
		expect(await pending).toMatchObject({
			code: 'timeout',
			message: `CollieAi did not answer within ${REQUEST_TIMEOUT_S} s`,
		});
		late[0](CREATED);
		await Promise.resolve();
		expect(calls()).toBe(1);
	});

	it('still ends a poll at the deadline and drops its late verdict', async () => {
		const { deps, deadlines, late, calls } = deafDeps(CREATED);
		const pending = runCheck(deps, params());
		await vi.waitFor(() => expect(late).toHaveLength(1));
		expect(deadlines).toHaveLength(2);
		deadlines[1].abort();
		expect(await pending).toMatchObject({
			code: 'timeout',
			message: 'No verdict within 30 s',
			jobId: 'job-1',
		});
		late[0](job('completed', ALLOWED));
		await Promise.resolve();
		expect(calls()).toBe(2);
	});
});

describe('untilAborted', () => {
	it('passes the answer on while the signal holds', async () => {
		const signal = new AbortController().signal;
		await expect(untilAborted(Promise.resolve('ok'), signal)).resolves.toBe('ok');
		await expect(untilAborted(Promise.reject(new Error('down')), signal)).rejects.toThrow('down');
	});

	it('rejects at once on a signal that already aborted, and keeps the late error handled', async () => {
		const controller = new AbortController();
		controller.abort();
		let fail: (error: Error) => void = () => undefined;
		const answer = new Promise<string>((_resolve, reject) => {
			fail = reject;
		});
		const refused = untilAborted(answer, controller.signal);
		await expect(refused).rejects.toBeInstanceOf(CheckError);
		await expect(refused).rejects.toMatchObject({
			code: 'timeout',
			message: 'The request ran out of time',
		});
		fail(new Error('late'));
		await Promise.resolve();
	});

	it('stops listening once the answer is in', async () => {
		const controller = new AbortController();
		const add = vi.spyOn(controller.signal, 'addEventListener');
		const remove = vi.spyOn(controller.signal, 'removeEventListener');
		await untilAborted(Promise.resolve('ok'), controller.signal);
		await untilAborted(Promise.reject(new Error('down')), controller.signal).catch(() => undefined);
		expect(add.mock.calls.map(([type]) => type)).toEqual(['abort', 'abort']);
		expect(remove.mock.calls).toEqual(add.mock.calls);
	});
});

describe('headers', () => {
	it('reads a header by its lower-case name, from a string or a list', () => {
		expect(header({ 'X-Request-Id': 'a' }, 'x-request-id')).toBe('a');
		expect(header({ 'content-type': 'json', 'x-request-id': 'r' }, 'x-request-id')).toBe('r');
		expect(header({ 'x-request-id': ['b', 'c'] }, 'x-request-id')).toBe('b');
		expect(header({ 'x-request-id': [5] }, 'x-request-id')).toBeNull();
		expect(header({ 'x-request-id': { 0: 'a' } }, 'x-request-id')).toBeNull();
		expect(header({ 'x-request-id': 5 }, 'x-request-id')).toBeNull();
		expect(header({}, 'x-request-id')).toBeNull();
	});

	it.each([
		['2', 2],
		['0', 0],
		['1.5', null],
		['1e2', null],
		['', null],
		['Wed, 21 Oct 2026 07:28:00 GMT', null],
	])('reads Retry-After %j as %s', (value, expected) => {
		expect(retryAfterSeconds({ 'retry-after': value })).toBe(expected);
	});
});
