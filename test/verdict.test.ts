import { describe, expect, it } from 'vitest';

import { CheckError } from '../nodes/CollieAi/errors';
import { toCheckResult, type Phase } from '../nodes/CollieAi/verdict';
import shared from './verdict_cases.json';

const RESULT_KEY: Record<Phase, string> = { input: 'inbound_result', output: 'outbound_result' };
const BLOCKED_STATUS: Record<Phase, string> = {
	input: 'inbound_blocked',
	output: 'outbound_blocked',
};

function verdict(phase: Phase, status: string, result: unknown, details = false) {
	return toCheckResult(
		phase,
		'original text',
		'job-1',
		'req-1',
		{ status, [RESULT_KEY[phase]]: result },
		details,
	);
}

describe.each(['input', 'output'] as const)('the %s verdict (the SDK fail-safe table)', (phase) => {
	it('is allowed only with an explicit allowed: true and no block signal', () => {
		const v = verdict(phase, 'completed', { allowed: true, blocked: false });
		expect(v).toMatchObject({ allowed: true, blocked: false, text: 'original text' });
	});

	it.each([
		['allowed is absent', { blocked: false }],
		['allowed is a truthy non-boolean', { allowed: 'true', blocked: false }],
		['allowed is false', { allowed: false, blocked: false }],
		['blocked is true', { allowed: true, blocked: true }],
	])('is blocked when %s', (_case, result) => {
		const v = verdict(phase, 'completed', result);
		expect(v).toMatchObject({ allowed: false, blocked: true, text: null });
	});

	it('is blocked when the status says so, whatever the result claims', () => {
		const v = verdict(phase, BLOCKED_STATUS[phase], { allowed: true, blocked: false });
		expect(v).toMatchObject({ allowed: false, blocked: true });
	});

	it('passes on the masked text when a rule masked it', () => {
		const v = verdict(phase, 'completed', { allowed: true, filtered_content: 'Call [PHONE]' });
		expect(v).toMatchObject({ allowed: true, text: 'Call [PHONE]' });
	});

	it('keeps an empty masked text as an empty string', () => {
		const v = verdict(phase, 'completed', { allowed: true, filtered_content: '' });
		expect(v).toMatchObject({ allowed: true, text: '' });
	});

	it('carries the block message and the ids', () => {
		const v = verdict(phase, BLOCKED_STATUS[phase], {
			allowed: false,
			blocked: true,
			block_message: 'Not allowed here',
		});
		expect(v).toMatchObject({
			blockMessage: 'Not allowed here',
			jobId: 'job-1',
			requestId: 'req-1',
		});
	});

	it('ignores a non-string block message', () => {
		const v = verdict(phase, 'completed', { allowed: false, block_message: 42 });
		expect(v).toMatchObject({ blockMessage: null });
	});

	it('maps the triggered rules without their match details by default', () => {
		const rule = {
			rule_id: 'r1',
			rule_name: 'PII',
			rule_type: 'pii',
			decision: 'mask',
			monitoring: true,
			match_info: { matched_text: '+1 555 0100' },
		};
		const v = verdict(phase, 'completed', { allowed: true, triggered_rules: [rule] });
		expect(v).not.toBeInstanceOf(CheckError);
		const rules = (v as { triggeredRules: unknown[] }).triggeredRules;
		expect(rules).toEqual([
			{ ruleId: 'r1', ruleName: 'PII', ruleType: 'pii', decision: 'mask', monitoring: true },
		]);
		expect(JSON.stringify(v)).not.toContain('555');
	});

	it('adds the match details only when asked', () => {
		const withInfo = { rule_id: 'r1', match_info: { matched_text: 'x' } };
		const without = { rule_id: 'r2', match_info: 'not an object' };
		const v = verdict(
			phase,
			'completed',
			{ allowed: true, triggered_rules: [withInfo, without] },
			true,
		);
		const rules = (v as unknown as { triggeredRules: Array<Record<string, unknown>> })
			.triggeredRules;
		expect(rules[0].matchInfo).toEqual({ matched_text: 'x' });
		expect(rules[1].matchInfo).toBeNull();
		expect(rules[1]).toMatchObject({ ruleName: '', ruleType: '', decision: '', monitoring: false });
	});

	it.each([
		['the phase result is missing', undefined],
		['the phase result is null', null],
		['the phase result is not an object', ['allowed']],
		['the triggered rules are not a list', { allowed: true, triggered_rules: {} }],
		['a triggered rule is not an object', { allowed: true, triggered_rules: ['r1'] }],
		['the masked text is not a string', { allowed: true, filtered_content: 7 }],
	])('is a malformed result when %s', (_case, result) => {
		const v = verdict(phase, 'completed', result);
		expect(v).toBeInstanceOf(CheckError);
		expect(v).toMatchObject({
			code: 'invalid_response',
			jobId: 'job-1',
			message: 'CollieAi returned a malformed result',
		});
	});

	it("reads only its own phase's result", () => {
		const other = phase === 'input' ? 'outbound_result' : 'inbound_result';
		const v = toCheckResult(
			phase,
			't',
			'job-1',
			null,
			{ status: 'completed', [other]: { allowed: true } },
			false,
		);
		expect(v).toBeInstanceOf(CheckError);
	});
});

interface VerdictCase {
	name: string;
	job: Record<string, unknown>;
	expect: { allowed: boolean; blocked: boolean; block_message?: string };
}

// The SDKs' shared vectors: a byte copy of conformance/verdict_cases.json in
// CollieAi/collieai-sdk.
const SHARED = shared.cases as VerdictCase[];

describe("the SDKs' shared verdict vectors, on an input check", () => {
	it('are all here', () => {
		expect(SHARED.length).toBeGreaterThanOrEqual(10);
	});

	it.each(SHARED.map((c) => [c.name, c] as const))('%s', (_name, c) => {
		const v = toCheckResult('input', 'original text', 'job-1', null, c.job, false);
		expect(v).not.toBeInstanceOf(CheckError);
		expect(v).toMatchObject({ allowed: c.expect.allowed, blocked: c.expect.blocked });
		if (c.expect.block_message !== undefined) {
			expect(v).toMatchObject({ blockMessage: c.expect.block_message });
		}
		if (!c.expect.allowed) expect(v).toMatchObject({ text: null });
	});
});

describe("the job's context result", () => {
	const allowedJob = (context: unknown) => ({
		status: 'completed',
		inbound_result: { allowed: true, blocked: false },
		outbound_result: { allowed: true, blocked: false },
		context_result: context,
	});

	it.each([
		['blocked: true', { blocked: true }],
		['a truthy blocked', { blocked: 1 }],
	])('blocks an input check when it has %s', (_case, context) => {
		const v = toCheckResult('input', 't', 'job-1', null, allowedJob(context), false);
		expect(v).toMatchObject({ allowed: false, blocked: true, text: null, blockMessage: null });
	});

	it.each([
		['blocked: false', { blocked: false, block_message: 'context msg' }],
		['no blocked', { block_message: 'context msg' }],
		['not an object', ['blocked']],
		['null', null],
	])('leaves an input check allowed when it has %s', (_case, context) => {
		const v = toCheckResult('input', 't', 'job-1', null, allowedJob(context), false);
		expect(v).toMatchObject({ allowed: true, blocked: false, text: 't', blockMessage: null });
	});

	it('gives its message only when the phase result has none that is text', () => {
		const job = {
			status: 'completed',
			inbound_result: { allowed: true, block_message: 7 },
			context_result: { blocked: true, block_message: 'context msg' },
		};
		expect(toCheckResult('input', 't', 'job-1', null, job, false)).toMatchObject({
			blockMessage: 'context msg',
		});
		const silent = { ...job, context_result: { blocked: true, block_message: 7 } };
		expect(toCheckResult('input', 't', 'job-1', null, silent, false)).toMatchObject({
			blocked: true,
			blockMessage: null,
		});
	});

	it("is not read by an output check, as the Node SDK's output mapper", () => {
		const v = toCheckResult(
			'output',
			't',
			'job-1',
			null,
			allowedJob({ blocked: true, block_message: 'context msg' }),
			false,
		);
		expect(v).toMatchObject({ allowed: true, blocked: false, blockMessage: null });
	});
});
