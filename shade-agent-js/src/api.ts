import { Provider } from "@near-js/providers";
import { createDefaultProvider, internalFundAgent } from "./utils/near";
import { Attestation, getTappdClient, getAttestation } from "./utils/tee";
import { TappdClient } from "./utils/tappd";
import { deriveAndAddAdditionalKeys, generateAgent, getAgentSigner } from "./utils/agent";
import { Account } from "@near-js/accounts";
import { SerializedReturnValue, TxExecutionStatus, BlockReference } from "@near-js/types";

export interface AgentStatus {
    verified: boolean;
    whitelisted: boolean;
}

interface GetAgentResponse {
    account_id: string;
    verified: boolean;
    whitelisted: boolean;
    codehash?: string | null;
}

export interface ShadeConfig {
    networkId?: "testnet" | "mainnet";
    agentContractId?: string;
    sponsor?: {
        accountId: string;
        privateKey: string;
    }
    rpc?: Provider;
    numKeys?: number;
    derivationPath?: string;
}
  
export class ShadeClient {
    private config: ShadeConfig;
    private tappdClient: TappdClient | undefined; // If undefined, then the agent is not running in a TEE
    private agentAccountId: string;
    private agentPrivateKeys: string[];
    private currentKeyIndex: number;
    private keysDerivedWithTEE: boolean; // true if all keys were derived with TEE entropy, false otherwise
    
    // Private constructor so only `create()` can be used to create an instance
    private constructor(config: ShadeConfig, tappdClient: TappdClient | undefined, accountId: string, agentPrivateKeys: string[], keysDerivedWithTEE: boolean) {
        this.config = config;
        this.tappdClient = tappdClient;
        this.agentAccountId = accountId;
        this.agentPrivateKeys = agentPrivateKeys;
        this.currentKeyIndex = 0;
        this.keysDerivedWithTEE = keysDerivedWithTEE;
    }

    // Async constructor
    static async create(config: ShadeConfig): Promise<ShadeClient> {
        // Validate config before creating instance
        if (config.networkId !== undefined && config.networkId !== "testnet" && config.networkId !== "mainnet") {
            throw new Error("networkId must be either 'testnet' or 'mainnet'");
        }
        
        // Validate sponsor
        if (config.sponsor) {
            if (!config.sponsor.accountId || config.sponsor.accountId.trim() === "") {
                throw new Error("sponsor.accountId is required when sponsor is provided");
            }
            if (!config.sponsor.privateKey || config.sponsor.privateKey.trim() === "") {
                throw new Error("sponsor.privateKey is required when sponsor is provided");
            }
        }

        // Set default numKeys to 1 if undefined
        if (config.numKeys === undefined) {
            config.numKeys = 1;
        }
        // Validate numKeys
        if (!Number.isInteger(config.numKeys) || config.numKeys < 1 || config.numKeys > 100) {
            throw new Error("numKeys must be an integer between 1 and 100");
        }
        
        // Set default provider if networkId is provided but no rpc is set
        if (!config.rpc && config.networkId) {
            config.rpc = createDefaultProvider(config.networkId);
        }

        // Validate that networkId matches the RPC provider's network if both are provided
        if (config.networkId && config.rpc) {
            const rpcNetworkId = await config.rpc.getNetworkId();
            if (rpcNetworkId !== config.networkId) {
                throw new Error(`Network ID mismatch: config.networkId is "${config.networkId}" but RPC provider is connected to "${rpcNetworkId}"`);
            }
        }

        // Detect if running in a TEE
        const tappdClient = await getTappdClient();

        const agentPrivateKeys: string[] = [];
        // Generate agent account ID
        const { accountId, agentPrivateKey, derivedWithTEE } = await generateAgent(tappdClient, config.derivationPath);
        agentPrivateKeys.push(agentPrivateKey);

        // Return agent instance
        return new ShadeClient(config, tappdClient, accountId, agentPrivateKeys, derivedWithTEE);
    }

    /**
     * Retrieves the account ID of the agent
     * @returns The agent's account ID
     */
    accountId(): string {
        return this.agentAccountId;
    }

    async balance(): Promise<bigint> {
        const account = new Account(this.agentAccountId, this.config.rpc);
        return await account.getBalance();
    }

    async isRegistered(): Promise<AgentStatus> {
        const res = await this.view<GetAgentResponse | null>({
            methodName: "get_agent",
            args: {
                account_id: this.agentAccountId,
            },
        });
        
        if (res === null) {
            return {
                verified: false,
                whitelisted: false,
            };
        }
        
        return {
            verified: res.verified,
            whitelisted: res.whitelisted,
        };
    }

    async register(): Promise<boolean> {
        const attestation = await getAttestation(this.tappdClient, this.agentAccountId, this.keysDerivedWithTEE);
        return await this.call({
            methodName: "register_agent",
            args: {
                attestation,
            },
            gas: BigInt("250000000000000"), // 250 TGas (under 300 TGas limit)
        });
    }

    /**
     * Call a view function on the agent contract and return the result
     * @param params
     * @param params.methodName The method that will be called
     * @param params.args Arguments as a valid JSON Object
     * @param params.blockQuery (optional) Block reference for the query
     * @returns A promise that resolves with the result of the view function call
     */
    async view<T extends SerializedReturnValue>(params: {
        methodName: string;
        args: Record<string, unknown>;
        blockQuery?: BlockReference;
    }): Promise<T> {
        if (!this.config.agentContractId) {
            throw new Error("agentContractId is required for view calls");
        }
        if (!this.config.rpc) {
            throw new Error("rpc provider is required for view calls");
        }

        return await this.config.rpc.callFunction(
            this.config.agentContractId,
            params.methodName,
            params.args,
            params.blockQuery
        );
    }

    /**
     * Call a function on the agent contract and return the result
     * @param params
     * @param params.methodName The method that will be called
     * @param params.args Arguments, either as a valid JSON Object or a raw Uint8Array
     * @param params.deposit (optional) Amount of NEAR Tokens to attach to the call
     * @param params.gas (optional) Amount of GAS to use attach to the call
     * @param params.waitUntil (optional) Transaction finality to wait for
     * @returns A promise that resolves with the result of the contract function call
     */
    async call<T extends SerializedReturnValue>(params: {
        methodName: string;
        args: Uint8Array | Record<string, any>;
        deposit?: bigint | string | number;
        gas?: bigint | string | number;
        waitUntil?: TxExecutionStatus;
    }): Promise<T> {
        if (!this.config.agentContractId) {
            throw new Error("agentContractId is required for call functions");
        }
        if (!this.config.rpc) {
            throw new Error("rpc provider is required for call functions");
        }

        // If keys were not previously added to the account, add them now
        if (this.config.numKeys > 1 && this.agentPrivateKeys.length === 1) {
            const { additionalKeys, allDerivedWithTEE } = await deriveAndAddAdditionalKeys(this.config.numKeys - 1, this.tappdClient, this.config.derivationPath);
            this.agentPrivateKeys.push(...additionalKeys);
            // If any additional key was not derived with TEE, set flag to false
            if (!allDerivedWithTEE) {
                this.keysDerivedWithTEE = false;
            }
        }

        // Get the signer for the current key
        // create account object with signer
        const { signer, keyIndex } = getAgentSigner(this.agentPrivateKeys, this.currentKeyIndex);
        this.currentKeyIndex = keyIndex;
        const account = new Account(this.agentAccountId, this.config.rpc, signer);

        return await account.callFunction({
            contractId: this.config.agentContractId,
            methodName: params.methodName,
            args: params.args,
            gas: params.gas,
            deposit: params.deposit,
            waitUntil: params.waitUntil,
        });
    }

    async getAttestation(): Promise<Attestation> {
        return getAttestation(this.tappdClient, this.agentAccountId, this.keysDerivedWithTEE);
    }

    async fundAgent(fundAmount: number): Promise<void> {
        await internalFundAgent(this.agentAccountId, this.config.sponsor.accountId, this.config.sponsor.privateKey, fundAmount, this.config.rpc);
    }

    getAgentPrivateKeys(acknowledgeRisk: boolean = false): string[] {
        if (!acknowledgeRisk) { 
            throw new Error("WARNING: Exporting private keys from the library is a risky operation, you may accidentally leak them from the TEE. Do not use the keys to sign transactions other than to the agent contract. Please acknowledge the risk by setting acknowledgeRisk to true.");
        }
        console.log("WARNING: Exporting private keys from the library is a risky operation, you may accidentally leak them from the TEE. Do not use the keys to sign transactions other than to the agent contract.");
        return this.agentPrivateKeys;
    }
}
  