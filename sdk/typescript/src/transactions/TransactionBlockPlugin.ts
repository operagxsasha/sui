// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { parse } from 'valibot';

import type { SuiClient } from '../client/client.js';
import { SUI_TYPE_ARG } from '../utils/index.js';
import { normalizeSuiAddress, normalizeSuiObjectId } from '../utils/sui-types.js';
import type { CallArg, OpenMoveTypeSignature, Transaction } from './blockData/v2.js';
import { ObjectRef } from './blockData/v2.js';
import { Inputs, isMutableSharedObjectInput } from './Inputs.js';
import { getPureSerializationType, isTxContext } from './serializer.js';
import type { TransactionBlockDataBuilder } from './TransactionBlockData.js';
import { extractStructTag } from './utils.js';

export type MaybePromise<T> = T | Promise<T>;
export interface TransactionBlockPlugin {
	normalizeInputs?: (blockData: TransactionBlockDataBuilder) => MaybePromise<void>;
	resolveObjectReferences?: (blockData: TransactionBlockDataBuilder) => MaybePromise<void>;
	setGasPrice?: (blockData: TransactionBlockDataBuilder) => MaybePromise<void>;
	setGasBudget?: (
		blockData: TransactionBlockDataBuilder,
		options: {
			maxTxGas: number;
			maxTxSizeBytes: number;
		},
	) => MaybePromise<void>;
	setGasPayment?: (
		blockData: TransactionBlockDataBuilder,
		options: {
			maxGasObjects: number;
		},
	) => MaybePromise<void>;
	validate?: (
		blockData: TransactionBlockDataBuilder,
		options: {
			maxPureArgumentSize: number;
		},
	) => MaybePromise<void>;
}

// The maximum objects that can be fetched at once using multiGetObjects.
const MAX_OBJECTS_PER_FETCH = 50;

// An amount of gas (in gas units) that is added to transactions as an overhead to ensure transactions do not fail.
const GAS_SAFE_OVERHEAD = 1000n;

const chunk = <T>(arr: T[], size: number): T[][] =>
	Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
		arr.slice(i * size, i * size + size),
	);

export class DefaultTransactionBlockFeatures implements TransactionBlockPlugin {
	#plugins: TransactionBlockPlugin[];
	#getClient: () => SuiClient;

	constructor(plugins: TransactionBlockPlugin[], getClient: () => SuiClient) {
		this.#plugins = plugins;
		this.#getClient = getClient;
	}

	#runHook = async <T extends keyof TransactionBlockPlugin>(
		hook: T,
		...args: Parameters<NonNullable<TransactionBlockPlugin[T]>>
	) => {
		for (const plugin of this.#plugins) {
			if (plugin[hook]) {
				await (plugin[hook] as () => unknown)(...(args as unknown as []));
			}
		}
	};

	setGasPrice: NonNullable<TransactionBlockPlugin['setGasPrice']> = async (blockData) => {
		await this.#runHook('setGasPrice', blockData);
		if (blockData.gasConfig.price) {
			return;
		}

		blockData.gasConfig.price = String(await this.#getClient().getReferenceGasPrice());
	};

	setGasBudget: NonNullable<TransactionBlockPlugin['setGasBudget']> = async (
		blockData,
		options,
	) => {
		await this.#runHook('setGasBudget', blockData, options);
		if (!blockData.gasConfig.budget) {
			const dryRunResult = await this.#getClient().dryRunTransactionBlock({
				transactionBlock: blockData.build({
					maxSizeBytes: options.maxTxSizeBytes,
					overrides: {
						gasData: {
							budget: String(options.maxTxGas),
							payment: [],
						},
					},
				}),
			});

			if (dryRunResult.effects.status.status !== 'success') {
				throw new Error(
					`Dry run failed, could not automatically determine a budget: ${dryRunResult.effects.status.error}`,
					{ cause: dryRunResult },
				);
			}

			const safeOverhead = GAS_SAFE_OVERHEAD * BigInt(blockData.gasConfig.price || 1n);

			const baseComputationCostWithOverhead =
				BigInt(dryRunResult.effects.gasUsed.computationCost) + safeOverhead;

			const gasBudget =
				baseComputationCostWithOverhead +
				BigInt(dryRunResult.effects.gasUsed.storageCost) -
				BigInt(dryRunResult.effects.gasUsed.storageRebate);

			// Set the budget to max(computation, computation + storage - rebate)
			blockData.gasConfig.budget = String(
				gasBudget > baseComputationCostWithOverhead ? gasBudget : baseComputationCostWithOverhead,
			);
		}
	};

	// The current default is just picking _all_ coins we can which may not be ideal.
	setGasPayment: NonNullable<TransactionBlockPlugin['setGasPayment']> = async (
		blockData,
		options,
	) => {
		await this.#runHook('setGasPayment', blockData, options);
		if (blockData.gasConfig.payment) {
			if (blockData.gasConfig.payment.length > options.maxGasObjects) {
				throw new Error(`Payment objects exceed maximum amount: ${options.maxGasObjects}`);
			}
		}

		// Early return if the payment is already set:
		if (blockData.gasConfig.payment) {
			return;
		}

		const gasOwner = blockData.gasConfig.owner ?? blockData.sender;

		const coins = await this.#getClient().getCoins({
			owner: gasOwner!,
			coinType: SUI_TYPE_ARG,
		});

		const paymentCoins = coins.data
			// Filter out coins that are also used as input:
			.filter((coin) => {
				const matchingInput = blockData.inputs.find((input) => {
					if (input.Object?.ImmOrOwnedObject) {
						return coin.coinObjectId === input.Object.ImmOrOwnedObject.objectId;
					}

					return false;
				});

				return !matchingInput;
			})
			.slice(0, options.maxGasObjects - 1)
			.map((coin) => ({
				objectId: coin.coinObjectId,
				digest: coin.digest,
				version: coin.version,
			}));

		if (!paymentCoins.length) {
			throw new Error('No valid gas coins found for the transaction.');
		}

		blockData.gasConfig.payment = paymentCoins.map((payment) => parse(ObjectRef, payment));
	};

	resolveObjectReferences: NonNullable<TransactionBlockPlugin['resolveObjectReferences']> = async (
		blockData,
	) => {
		await this.#runHook('resolveObjectReferences', blockData);

		// Keep track of the object references that will need to be resolved at the end of the transaction.
		// We keep the input by-reference to avoid needing to re-resolve it:
		const objectsToResolve = blockData.inputs.filter((input) => {
			return input.UnresolvedObject;
		}) as Extract<CallArg, { UnresolvedObject: unknown }>[];

		if (objectsToResolve.length) {
			const dedupedIds = [
				...new Set(
					objectsToResolve.map((input) => normalizeSuiObjectId(input.UnresolvedObject.value)),
				),
			];
			const objectChunks = chunk(dedupedIds, MAX_OBJECTS_PER_FETCH);
			const objects = (
				await Promise.all(
					objectChunks.map((chunk) =>
						this.#getClient().multiGetObjects({
							ids: chunk,
							options: { showOwner: true },
						}),
					),
				)
			).flat();

			let objectsById = new Map(
				dedupedIds.map((id, index) => {
					return [id, objects[index]];
				}),
			);

			const invalidObjects = Array.from(objectsById)
				.filter(([_, obj]) => obj.error)
				.map(([id, _]) => id);
			if (invalidObjects.length) {
				throw new Error(`The following input objects are invalid: ${invalidObjects.join(', ')}`);
			}

			objectsToResolve.forEach((input) => {
				let updated: CallArg = input;
				const id = normalizeSuiAddress(input.UnresolvedObject.value);
				const normalizedType = input.UnresolvedObject.typeSignature;
				const object = objectsById.get(id)!;
				const owner = object.data?.owner;
				const initialSharedVersion =
					owner && typeof owner === 'object' && 'Shared' in owner
						? owner.Shared.initial_shared_version
						: undefined;

				if (initialSharedVersion) {
					// There could be multiple transactions that reference the same shared object.
					// If one of them is a mutable reference or taken by value, then we should mark the input
					// as mutable.
					const isByValue = !normalizedType.ref;
					const mutable =
						isMutableSharedObjectInput(input) || isByValue || normalizedType.ref === '&mut';

					updated = Inputs.SharedObjectRef({
						objectId: id,
						initialSharedVersion,
						mutable,
					});
				} else if (normalizedType && isReceivingType(normalizedType)) {
					updated = Inputs.ReceivingRef(object.data!);
				} else {
					updated = Inputs.ObjectRef(object.data!);
				}

				blockData.inputs[blockData.inputs.indexOf(input)] = updated;
			});
		}
	};

	normalizeInputs: NonNullable<TransactionBlockPlugin['normalizeInputs']> = async (blockData) => {
		await this.#runHook('normalizeInputs', blockData);
		const { inputs, transactions } = blockData;
		const moveModulesToResolve: Extract<Transaction, { MoveCall: unknown }>['MoveCall'][] = [];

		transactions.forEach((transaction) => {
			// Special case move call:
			if (transaction.MoveCall) {
				// Determine if any of the arguments require encoding.
				// - If they don't, then this is good to go.
				// - If they do, then we need to fetch the normalized move module.

				const inputs = transaction.MoveCall.arguments.map((arg) => {
					if (arg.Input) {
						return blockData.inputs[arg.Input];
					}
					return null;
				});
				const needsResolution = inputs.some((input) => input && input.RawValue);

				if (needsResolution) {
					moveModulesToResolve.push(transaction.MoveCall);
				}
			}

			// Special handling for values that where previously encoded using the wellKnownEncoding pattern.
			// This should only happen when transaction block data was hydrated from an old version of the SDK
			if (transaction.SplitCoins) {
				// TODO: Fix this during hydration
				// const amounts = transaction.SplitCoins[1].map((amount) => {
				// transaction.amounts.forEach((amount) => {
				// 	if (amount.kind === 'Input') {
				// 		const input = inputs[amount.index];
				// 		if (typeof input.value !== 'object') {
				// 			input.value = Inputs.Pure(bcs.U64.serialize(input.value));
				// 		}
				// 	}
				// });
			}

			// if (transaction.kind === 'TransferObjects') {
			// 	if (transaction.address.kind === 'Input') {
			// 		const input = inputs[transaction.address.index];
			// 		if (typeof input.value !== 'object') {
			// 			input.value = Inputs.Pure(bcs.Address.serialize(input.value));
			// 		}
			// 	}
			// }
		});

		if (moveModulesToResolve.length) {
			await Promise.all(
				moveModulesToResolve.map(async (moveCall) => {
					const normalized = await this.#getClient().getNormalizedMoveFunction({
						package: moveCall.package,
						module: moveCall.module,
						function: moveCall.function,
					});

					// Entry functions can have a mutable reference to an instance of the TxContext
					// struct defined in the TxContext module as the last parameter. The caller of
					// the function does not need to pass it in as an argument.
					const hasTxContext =
						normalized.parameters.length > 0 && isTxContext(normalized.parameters.at(-1)!);

					const params = hasTxContext
						? normalized.parameters.slice(0, normalized.parameters.length - 1)
						: normalized.parameters;

					if (params.length !== moveCall.arguments.length) {
						throw new Error('Incorrect number of arguments.');
					}

					params.forEach((param, i) => {
						const arg = moveCall.arguments[i];
						if (!arg.Input) return;
						const input = inputs[arg.Input];
						// Skip if the input is already resolved
						if (!input.RawValue) return;

						const inputValue = input.RawValue.value;

						const serType = getPureSerializationType(param, inputValue);

						if (serType) {
							inputs[inputs.indexOf(input)] = Inputs.Pure(inputValue, serType);
							return;
						}

						const structVal = extractStructTag(param);
						if (structVal != null || (typeof param === 'object' && 'TypeParameter' in param)) {
							if (typeof inputValue !== 'string') {
								throw new Error(
									`Expect the argument to be an object id string, got ${JSON.stringify(
										inputValue,
										null,
										2,
									)}`,
								);
							}

							inputs[inputs.indexOf(input)] = {
								UnresolvedObject: {
									value: inputValue,
									// TODO convert to OpenMoveTypeSignature
									typeSignature: param,
								},
							};
							return;
						}

						throw new Error(
							`Unknown call arg type ${JSON.stringify(param, null, 2)} for value ${JSON.stringify(
								inputValue,
								null,
								2,
							)}`,
						);
					});
				}),
			);
		}
	};

	validate: NonNullable<TransactionBlockPlugin['validate']> = async (blockData, options) => {
		await this.#runHook('validate', blockData, options);
		// Validate all inputs are the correct size:
		blockData.inputs.forEach((input, index) => {
			if (input.Pure) {
				if (input.Pure.length > options.maxPureArgumentSize) {
					throw new Error(
						`Input at index ${index} is too large, max pure input size is ${options.maxPureArgumentSize} bytes, got ${input.Pure.length} bytes`,
					);
				}
			}
		});
	};
}

function isReceivingType(type: OpenMoveTypeSignature): boolean {
	if (typeof type.body !== 'object' || !('datatype' in type.body)) {
		return false;
	}

	return (
		type.body.datatype.package === '0x2' &&
		type.body.datatype.module === 'transfer' &&
		type.body.datatype.type === 'Receiving'
	);
}
