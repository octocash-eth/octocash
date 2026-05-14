import type { Account, Address, Call, Chain, Hex, HttpTransport, WalletClient } from "viem";
import { createWalletClient, encodeFunctionData, erc20Abi, keccak256, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt } from "viem/actions";
import { base, mainnet, optimism } from "viem/chains";
import { beforeAll, describe, expect, test } from "vitest";
import { USDC } from "../../app/data/token-contracts";
import { prepareSendCalls } from "../../app/lib/send-calls";
import { getTestClients } from "../integration-global-setup";

// Test clients for each chain
const { testClient: mainnetTestClient, publicClient: mainnetPublicClient, transport: mainnetTransport } = getTestClients(mainnet.id);
const { testClient: optimismTestClient, publicClient: optimismPublicClient, transport: optimismTransport } = getTestClients(optimism.id);
const { testClient: baseTestClient, publicClient: basePublicClient, transport: baseTransport } = getTestClients(base.id);

// Test account - using a private key to create a proper account
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const testAccount = privateKeyToAccount(TEST_PRIVATE_KEY);

// Real token addresses
const USDC_MAINNET = USDC[mainnet.id];
const USDC_OPTIMISM = USDC[optimism.id];
const USDC_BASE = USDC[base.id];

// Helper to create wallet clients for testing
const createTestWalletClient = (chainId: number): WalletClient<HttpTransport, Chain, Account> => {
	const chain = chainId === mainnet.id ? mainnet : chainId === optimism.id ? optimism : base;
	const transport = chainId === mainnet.id ? mainnetTransport : chainId === optimism.id ? optimismTransport : baseTransport;
	
	return createWalletClient({
		account: testAccount,
		chain,
		transport,
	});
};

/**
 * No-op switchChain for Anvil testing.
 * Anvil doesn't support wallet_switchEthereumChain or wallet_addEthereumChain,
 * so we skip chain switching and assume the client is already on the correct chain.
 */
const noOpSwitchChain = async () => {};

/**
 * Helper to set ERC20 balance by writing to storage slot
 * Most ERC20 tokens use slot keccak256(abi.encode(address, balanceSlot))
 */
const setERC20Balance = async (
	testClient: any,
	tokenAddress: Address,
	account: Address,
	amount: bigint,
	balanceSlot: number = 9, // USDC uses slot 9 on mainnet
) => {
	// Calculate storage slot: keccak256(abi.encode(account, balanceSlot))
	const slot = keccak256(
		`0x${account.slice(2).padStart(64, "0")}${balanceSlot.toString(16).padStart(64, "0")}` as Hex
	);
	
	// Convert amount to bytes32
	const value = `0x${amount.toString(16).padStart(64, "0")}` as Hex;
	
	await testClient.setStorageAt({
		address: tokenAddress,
		index: slot,
		value,
	});
};

describe("send-calls integration tests", () => {
	let mainnetWallet: WalletClient<HttpTransport, Chain, Account>;
	let optimismWallet: WalletClient<HttpTransport, Chain, Account>;
	let baseWallet: WalletClient<HttpTransport, Chain, Account>;

	beforeAll(async () => {
		// Create wallet clients for each chain
		mainnetWallet = createTestWalletClient(mainnet.id);
		optimismWallet = createTestWalletClient(optimism.id);
		baseWallet = createTestWalletClient(base.id);

		// Fund test account with ETH on all chains
		await mainnetTestClient.setBalance({
			address: testAccount.address,
			value: parseEther("1000"),
		});
		await optimismTestClient.setBalance({
			address: testAccount.address,
			value: parseEther("1000"),
		});
		await baseTestClient.setBalance({
			address: testAccount.address,
			value: parseEther("1000"),
		});

		// Set USDC balances using storage manipulation
		const usdcAmount = parseUnits("100000", 6); // 100k USDC
		await setERC20Balance(mainnetTestClient, USDC_MAINNET, testAccount.address, usdcAmount, 9);
		await setERC20Balance(optimismTestClient, USDC_OPTIMISM, testAccount.address, usdcAmount, 0);
		await setERC20Balance(baseTestClient, USDC_BASE, testAccount.address, usdcAmount, 0);
	});

	describe("atomic-steps mode", () => {
		test("executes ETH transfers sequentially with balance verification", async () => {
			const sendCalls = prepareSendCalls(mainnetWallet, waitForTransactionReceipt, noOpSwitchChain);
			
			const recipient1 = "0x1000000000000000000000000000000000000001" as Address;
			const recipient2 = "0x2000000000000000000000000000000000000002" as Address;
			const amount1 = parseEther("0.1");
			const amount2 = parseEther("0.2");

			const initialBalance1 = await mainnetPublicClient.getBalance({ address: recipient1 });
			const initialBalance2 = await mainnetPublicClient.getBalance({ address: recipient2 });

			const calls: Call[] = [
				{ to: recipient1, data: "0x" as Hex, value: amount1 },
				{ to: recipient2, data: "0x" as Hex, value: amount2 },
			];

			const [txHash, logs] = await sendCalls(
				"test-eth-transfers",
				mainnet.id,
				testAccount.address,
				calls,
				"atomic-steps",
			);

			expect(txHash).toBeDefined();
			expect(txHash).not.toBe("");
			expect(logs).toHaveLength(2);

			// Verify balances increased
			const finalBalance1 = await mainnetPublicClient.getBalance({ address: recipient1 });
			const finalBalance2 = await mainnetPublicClient.getBalance({ address: recipient2 });
			
			expect(finalBalance1 - initialBalance1).toBe(amount1);
			expect(finalBalance2 - initialBalance2).toBe(amount2);
		});

		test("executes ERC20 approvals with allowance verification", async () => {
			const sendCalls = prepareSendCalls(mainnetWallet, waitForTransactionReceipt, noOpSwitchChain);
			
			const spender1 = "0x3000000000000000000000000000000000000001" as Address;
			const spender2 = "0x4000000000000000000000000000000000000002" as Address;
			const amount1 = parseUnits("1000", 6);
			const amount2 = parseUnits("2000", 6);

			const calls: Call[] = [
				{
					to: USDC_MAINNET,
					data: encodeFunctionData({
						abi: erc20Abi,
						functionName: "approve",
						args: [spender1, amount1],
					}),
				},
				{
					to: USDC_MAINNET,
					data: encodeFunctionData({
						abi: erc20Abi,
						functionName: "approve",
						args: [spender2, amount2],
					}),
				},
			];

			const [txHash, logs] = await sendCalls(
				"test-approvals",
				mainnet.id,
				testAccount.address,
				calls,
				"atomic-steps",
			);

			expect(txHash).not.toBe("");
			expect(logs).toHaveLength(2);
			// Each approval emits an event
			expect(logs[0].length).toBeGreaterThan(0);
			expect(logs[1].length).toBeGreaterThan(0);

			// Verify allowances were set
			const allowance1 = await mainnetPublicClient.readContract({
				address: USDC_MAINNET,
				abi: erc20Abi,
				functionName: "allowance",
				args: [testAccount.address, spender1],
			});
			const allowance2 = await mainnetPublicClient.readContract({
				address: USDC_MAINNET,
				abi: erc20Abi,
				functionName: "allowance",
				args: [testAccount.address, spender2],
			});

			expect(allowance1).toBe(amount1);
			expect(allowance2).toBe(amount2);
		});

		test("stops on first failure in atomic mode", async () => {
			const sendCalls = prepareSendCalls(mainnetWallet, waitForTransactionReceipt, noOpSwitchChain);
			
			const recipient = "0x5000000000000000000000000000000000000001" as Address;

			const calls: Call[] = [
				{ to: recipient, data: "0x" as Hex, value: parseEther("0.1") },
				{ to: USDC_MAINNET, data: "0xdeadbeef" as Hex }, // Invalid call - will revert
				{ to: recipient, data: "0x" as Hex, value: parseEther("0.1") },
			];

			await expect(
				sendCalls(
					"test-atomic-fail",
					mainnet.id,
					testAccount.address,
					calls,
					"atomic-steps",
				),
			).rejects.toThrow();
		});
	});

	describe("atomic-multicall mode", () => {
		test("batches multiple ERC20 approvals via Multicall3", async () => {
			// Note: Multicall3 aggregate3 doesn't support ETH value transfers to individual calls
			// It only supports calldata. Use atomic-steps for ETH transfers.
			const sendCalls = prepareSendCalls(mainnetWallet, waitForTransactionReceipt, noOpSwitchChain);
			
			const spenders = Array.from({ length: 3 }, (_, i) => 
				`0x${(8000 + i).toString(16).padStart(40, "0")}` as Address
			);
			const amounts = [
				parseUnits("100", 6),
				parseUnits("200", 6),
				parseUnits("300", 6),
			];

			const calls: Call[] = spenders.map((spender, i) => ({
				to: USDC_MAINNET,
				data: encodeFunctionData({
					abi: erc20Abi,
					functionName: "approve",
					args: [spender, amounts[i]],
				}),
			}));

			const [txHash, logs] = await sendCalls(
				"test-multicall-approvals",
				mainnet.id,
				testAccount.address,
				calls,
				"atomic-multicall",
			);

			expect(txHash).not.toBe("");
			expect(logs).toHaveLength(1); // Single multicall transaction
			expect(logs[0].length).toBeGreaterThan(0); // Should have Approval events
		});

		test("reverts entire batch if one call fails", async () => {
			const sendCalls = prepareSendCalls(mainnetWallet, waitForTransactionReceipt, noOpSwitchChain);
			
			const spender = "0x9000000000000000000000000000000000000001" as Address;
			const amount = parseUnits("100", 6);

			const calls: Call[] = [
				{
					to: USDC_MAINNET,
					data: encodeFunctionData({
						abi: erc20Abi,
						functionName: "approve",
						args: [spender, amount],
					}),
				},
				{ to: USDC_MAINNET, data: "0xbadf00d" as Hex }, // Invalid call
			];

			await expect(
				sendCalls(
					"test-multicall-revert",
					mainnet.id,
					testAccount.address,
					calls,
					"atomic-multicall",
				),
			).rejects.toThrow();

			// Verify allowance was NOT set (entire batch reverted)
			const allowance = await mainnetPublicClient.readContract({
				address: USDC_MAINNET,
				abi: erc20Abi,
				functionName: "allowance",
				args: [testAccount.address, spender],
			});

			expect(allowance).toBe(0n);
		});
	});

	describe("multi-chain coordination", () => {
		test("sequential ETH transfers across multiple chains", async () => {
			const recipient = "0xc000000000000000000000000000000000000001" as Address;
			const amount = parseEther("0.3");

			// Execute transfers on each chain
			const mainnetSendCalls = prepareSendCalls(mainnetWallet, waitForTransactionReceipt, noOpSwitchChain);
			const [mainnetTx] = await mainnetSendCalls(
				"mainnet-transfer",
				mainnet.id,
				testAccount.address,
				[{ to: recipient, data: "0x" as Hex, value: amount }],
				"atomic-steps",
			);

			const optimismSendCalls = prepareSendCalls(optimismWallet, waitForTransactionReceipt, noOpSwitchChain);
			const [optimismTx] = await optimismSendCalls(
				"optimism-transfer",
				optimism.id,
				testAccount.address,
				[{ to: recipient, data: "0x" as Hex, value: amount }],
				"atomic-steps",
			);

			const baseSendCalls = prepareSendCalls(baseWallet, waitForTransactionReceipt, noOpSwitchChain);
			const [baseTx] = await baseSendCalls(
				"base-transfer",
				base.id,
				testAccount.address,
				[{ to: recipient, data: "0x" as Hex, value: amount }],
				"atomic-steps",
			);

			// All txs should be unique
			expect(mainnetTx).not.toBe(optimismTx);
			expect(optimismTx).not.toBe(baseTx);

			// Verify balances on all chains
			const balances = await Promise.all([
				mainnetPublicClient.getBalance({ address: recipient }),
				optimismPublicClient.getBalance({ address: recipient }),
				basePublicClient.getBalance({ address: recipient }),
			]);

			expect(balances[0]).toBeGreaterThanOrEqual(amount);
			expect(balances[1]).toBeGreaterThanOrEqual(amount);
			expect(balances[2]).toBeGreaterThanOrEqual(amount);
		});

		test("parallel operations with mixed success", async () => {
			const recipient1 = "0xd000000000000000000000000000000000000001" as Address;
			const recipient2 = "0xe000000000000000000000000000000000000001" as Address;
			const amount = parseEther("0.1");

			const mainnetSendCalls = prepareSendCalls(mainnetWallet, waitForTransactionReceipt, noOpSwitchChain);
			const optimismSendCalls = prepareSendCalls(optimismWallet, waitForTransactionReceipt, noOpSwitchChain);

			const initialMainnetBalance = await mainnetPublicClient.getBalance({ address: recipient1 });
			const initialOptimismBalance = await optimismPublicClient.getBalance({ address: recipient2 });

			// Execute in parallel
			const [mainnetResult, optimismResult] = await Promise.all([
				mainnetSendCalls(
					"parallel-mainnet",
					mainnet.id,
					testAccount.address,
					[
						{ to: recipient1, data: "0x", value: amount },
						{ to: recipient1, data: "0x", value: amount },
					],
					"atomic-steps",
				),
				optimismSendCalls(
					"parallel-optimism",
					optimism.id,
					testAccount.address,
					[{ to: recipient2, data: "0x", value: amount * 2n }],
					"atomic-steps",
				),
			]);

			expect(mainnetResult[0]).not.toBe("");
			expect(optimismResult[0]).not.toBe("");

			const mainnetBalance = await mainnetPublicClient.getBalance({ address: recipient1 });
			expect(mainnetBalance - initialMainnetBalance).toBe(amount * 2n);

			const optimismBalance = await optimismPublicClient.getBalance({ address: recipient2 });
			expect(optimismBalance - initialOptimismBalance).toBe(amount * 2n);
		});
	});

	describe("complex workflow scenarios", () => {
		test("7-operation approval batch demonstrating batching strategy", async () => {
			// Tests the >6 operation batching pattern from consolidation spec
			// Uses ERC20 approvals which don't require ETH transfers
			const sendCalls = prepareSendCalls(mainnetWallet, waitForTransactionReceipt, noOpSwitchChain);
			
			const spenders = Array.from({ length: 7 }, (_, i) => 
				`0x${(i + 1).toString().padStart(40, "0")}` as Address
			);
			const amounts = Array.from({ length: 7 }, (_, i) => 
				parseUnits(`${(i + 1) * 10}`, 6)
			);

			// First batch: 6 operations (typical max for gas optimization)
			const calls1: Call[] = spenders.slice(0, 6).map((spender, i) => ({
				to: USDC_MAINNET,
				data: encodeFunctionData({
					abi: erc20Abi,
					functionName: "approve",
					args: [spender, amounts[i]],
				}),
			}));

			// Second batch: remaining 1 operation
			const calls2: Call[] = [{
				to: USDC_MAINNET,
				data: encodeFunctionData({
					abi: erc20Abi,
					functionName: "approve",
					args: [spenders[6], amounts[6]],
				}),
			}];

			const [tx1, logs1] = await sendCalls("batch-1", mainnet.id, testAccount.address, calls1, "atomic-steps");
			const [tx2, logs2] = await sendCalls("batch-2", mainnet.id, testAccount.address, calls2, "atomic-steps");

			expect(tx1).not.toBe("");
			expect(tx2).not.toBe("");
			expect(logs1).toHaveLength(6);
			expect(logs2).toHaveLength(1);
			
			// Verify logs show operations executed
			expect(logs1.filter(l => l.length > 0)).toHaveLength(6);
			expect(logs2[0].length).toBeGreaterThan(0);
		});

	});

	describe("batch modes", () => {
		// atomic-batch uses wallet_sendCalls (EIP-5792) which Anvil does not support.
		// It is fully tested in unit tests with mocks.

		test.skip("atomic-batch mode requires EIP-5792 wallet support", () => {
			// Skipped: Anvil doesn't support wallet_sendCalls
		});
	});
});
