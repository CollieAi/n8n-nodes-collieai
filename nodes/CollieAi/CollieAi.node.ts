import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import { normalizeBaseUrl } from './baseUrl';
import { runCheck, type CheckDeps } from './check';
import { CheckError, NEXT_STEP } from './errors';
import { deadlineSignal } from './pacing';
import type { CheckResult, Phase } from './verdict';

const PHASE_OF: Record<string, Phase> = { checkInput: 'input', checkOutput: 'output' };

const DEFAULT_TIMEOUT_S = 30;

/** Any error as the node's own: an n8n error keeps its (n8n-written) message,
 * anything else becomes a generic one. Never the HTTP client's error object. */
function asCheckError(error: unknown): CheckError {
	const message =
		error instanceof NodeOperationError || error instanceof NodeApiError
			? error.message.slice(0, 300)
			: 'The check could not run';
	return new CheckError('node_error', message);
}

/** The next step, then the identifiers support asks for. */
function describe(error: CheckError): string {
	const ids = [`code: ${error.code}`];
	if (error.serverCode !== undefined) ids.push(`server code: ${error.serverCode}`);
	if (error.jobId !== undefined) ids.push(`job ID: ${error.jobId}`);
	return `${NEXT_STEP[error.code]} (${ids.join(', ')})`;
}

function toNodeError(node: INode, error: CheckError, itemIndex: number) {
	if (error.httpStatus !== undefined) {
		return new NodeApiError(node, error.toJSON() as JsonObject, {
			message: error.message,
			description: describe(error),
			httpCode: String(error.httpStatus),
			itemIndex,
		});
	}
	return new NodeOperationError(node, error.message, {
		description: describe(error),
		itemIndex,
	});
}

/** The `collieai` object of an item whose check failed: blocked, so an IF on
 * `collieai.allowed` keeps it off the allowed path. */
function failedCheck(error: CheckError): IDataObject {
	return {
		allowed: false,
		blocked: true,
		text: null,
		blockMessage: null,
		triggeredRules: [],
		jobId: error.jobId ?? null,
		requestId: null,
		error: error.toJSON(),
	};
}

export class CollieAi implements INodeType {
	// Stryker disable all: UI copy. The fields that are behaviour (names,
	// defaults, the credential) are pinned by test/description.test.ts.
	description: INodeTypeDescription = {
		displayName: 'CollieAi',
		name: 'collieAi',
		icon: { light: 'file:collieai.svg', dark: 'file:collieai.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] === "checkOutput" ? "Check Output" : "Check Input"}}',
		description: 'Check text against your CollieAi policy',
		defaults: {
			name: 'CollieAi',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		// n8n's lint requires the property and its type allows only `true`. As an
		// agent's tool the node is an extra: the guard is still the node placed
		// in the workflow, which an agent cannot skip.
		usableAsTool: true,
		credentials: [
			{
				name: 'collieAiApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Check Input',
						value: 'checkInput',
						description:
							"Check a user's message against the project's Input rules, before it reaches the model",
						action: 'Check input',
					},
					{
						name: 'Check Output',
						value: 'checkOutput',
						description:
							"Check the model's reply against the project's Output rules, before it reaches the user",
						action: 'Check output',
					},
				],
				default: 'checkInput',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				required: true,
				default: '',
				description: 'The text to check',
			},
			{
				displayName: 'Conversation ID',
				name: 'conversationId',
				type: 'string',
				default: '',
				description:
					"Groups the turns of one conversation in CollieAi Logs, for example the Chat Trigger's session ID",
			},
			{
				displayName:
					'To branch, use an IF node on <code>collieai.allowed</code> being <code>true</code>, not on <code>collieai.blocked</code>',
				name: 'branchingNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Include Match Details',
						name: 'includeMatchDetails',
						type: 'boolean',
						default: false,
						description:
							"Whether to add each rule's match details. For pattern rules they hold the matched text, which n8n keeps in its execution history.",
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						typeOptions: {
							minValue: 1,
							maxValue: 300,
						},
						default: DEFAULT_TIMEOUT_S,
						description: 'Seconds to wait for the verdict once the check is created',
					},
				],
			},
		],
	};
	// Stryker restore all

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const node = this.getNode();
		const continues = this.continueOnFail();
		const toErrorOutput = node.onError === 'continueErrorOutput';
		const returnData: INodeExecutionData[] = [];

		// Failures that hold for every item. They are reported per item, so
		// that under the Continue modes each item still gets its own output: a
		// node that throws there makes n8n pass its input items on unchanged.
		let preflight: CheckError | null = null;
		let baseUrl = '';
		if (node.retryOnFail === true) {
			preflight = new CheckError(
				'retry_on_fail_unsupported',
				'Turn off Retry On Fail for this node: n8n would re-run every item and create a new, billed check for each',
			);
		} else {
			try {
				const credentials = await this.getCredentials('collieAiApi');
				const normalized = normalizeBaseUrl(credentials.baseUrl);
				if (normalized instanceof CheckError) preflight = normalized;
				else baseUrl = normalized;
			} catch (error) {
				preflight = asCheckError(error);
			}
		}

		const cancel = this.getExecutionCancelSignal();
		const deps: CheckDeps = {
			request: async (request) => {
				// n8n's authenticated helper sets the request's signal to the
				// one the context's getExecutionCancelSignal gives (n8n-core
				// 2.46 to 3.1), dropping the signal in the options. A context
				// that gives the execution's cancel joined with the check's
				// deadline keeps the cancel and closes a late answer's
				// connection at the deadline.
				const signal =
					cancel === undefined
						? request.abortSignal
						: AbortSignal.any([request.abortSignal, cancel]);
				const context = new Proxy(this, {
					get: (target, prop) => {
						if (prop === 'getExecutionCancelSignal') return () => signal;
						const value: unknown = Reflect.get(target, prop);
						return typeof value === 'function' ? value.bind(target) : value;
					},
				});
				const response = (await this.helpers.httpRequestWithAuthentication.call(
					context,
					'collieAiApi',
					{
						method: request.method,
						url: `${baseUrl}${request.path}`,
						body: request.body,
						json: true,
						headers: { 'X-CollieAi-SDK-Origin': request.origin },
						timeout: request.timeoutMs,
						abortSignal: signal,
						returnFullResponse: true,
						ignoreHttpStatusErrors: true,
					},
				)) as { statusCode: number; headers?: Record<string, unknown>; body: unknown };
				return {
					statusCode: response.statusCode,
					headers: response.headers ?? {},
					body: response.body,
				};
			},
			sleep: async (seconds) => await sleep(seconds * 1000),
			monotonic: () => performance.now() / 1000,
			rand: () => Math.random(),
			deadline: deadlineSignal,
		};

		const checkItem = async (itemIndex: number): Promise<CheckResult | CheckError> => {
			if (preflight !== null) return preflight;
			const operation = this.getNodeParameter('operation', itemIndex) as string;
			const phase = PHASE_OF[operation];
			if (phase === undefined) return new CheckError('invalid_parameter', 'Unknown operation');
			const text = this.getNodeParameter('text', itemIndex) as unknown;
			if (typeof text !== 'string') {
				return new CheckError('invalid_parameter', 'Text must be a string');
			}
			const conversationId = this.getNodeParameter('conversationId', itemIndex, '') as unknown;
			if (typeof conversationId !== 'string') {
				return new CheckError('invalid_parameter', 'Conversation ID must be a string');
			}
			const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
			return await runCheck(deps, {
				phase,
				text,
				conversationId,
				timeoutS: options.timeout === undefined ? DEFAULT_TIMEOUT_S : (options.timeout as number),
				includeMatchDetails: options.includeMatchDetails === true,
			});
		};

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			let outcome: CheckResult | CheckError;
			try {
				outcome = await checkItem(itemIndex);
			} catch (error) {
				// n8n's own errors, such as a parameter that cannot be read.
				outcome = asCheckError(error);
			}
			if (!(outcome instanceof CheckError)) {
				returnData.push({
					json: { ...items[itemIndex].json, collieai: outcome as unknown as IDataObject },
					pairedItem: { item: itemIndex },
				});
				continue;
			}
			if (!continues) throw toNodeError(node, outcome, itemIndex);
			const item: INodeExecutionData = {
				json: { ...items[itemIndex].json, collieai: failedCheck(outcome) },
				pairedItem: { item: itemIndex },
			};
			// With a top-level error n8n moves the item to the error output.
			if (toErrorOutput) item.error = toNodeError(node, outcome, itemIndex);
			returnData.push(item);
		}

		return [returnData];
	}
}
