import { Provider } from "@near-js/providers";
import { internalFundAgent, createAccountObject } from "./utils/near";
import {
  Attestation,
  getDstackClient,
  internalGetAttestation,
} from "./utils/tee";
import { DstackClient } from "@phala/dstack-sdk";
import { ensureKeysSetup, generateAgent, getAgentSigner } from "./utils/agent";
import { validateShadeConfig } from "./utils/validation";
import {
  SerializedReturnValue,
  TxExecutionStatus,
  BlockReference,
} from "@near-js/types"; 
import { NEAR } from "@near-js/tokens";

export interface AgentStatus {
  registered: boolean;
  whitelisted: boolean;
  codehash_is_approved: boolean;
}

interface GetAgentResponse {
  account_id: string;
  registered: boolean;
  whitelisted: boolean;
  codehash?: string | null;
  codehash_is_approved: boolean;
}

/**
 * Configuration object for creating a ShadeClient instance
 */
export interface ShadeConfig {
  /** Network ID ('testnet' or 'mainnet'), defaults to 'testnet' if not provided */
  networkId?: "testnet" | "mainnet";
  /** The NEAR contract ID for the agent contract */
  agentContractId?: string;
  /** Sponsor account configuration for funding the agent account */
  sponsor?: {
    /** The sponsor's NEAR account ID */
    accountId: string;
    /** The sponsor's private key */
    privateKey: string;
  };
  /** Custom NEAR RPC provider. If not provided, a default provider will be created based on networkId */
  rpc?: Provider;
  /** Number of keys to use for the agent (1-100), defaults to 1 if not provided */
  numKeys?: number;
  /** Derivation path for deterministic key generation for local testing (needs to be a randomly unique string)*/
  derivationPath?: string;
}

export class ShadeClient {
  private config: ShadeConfig;
  private dstackClient: DstackClient | undefined; // If undefined, then the agent is not running in a TEE
  private agentAccountId: string;
  private agentPrivateKeys: string[];
  private currentKeyIndex: number;
  private keysDerivedWithTEE: boolean; // true if all keys were derived with TEE entropy, false otherwise
  private keysChecked: boolean; // true if the number of keys have been checked (happens on the first call), false otherwise

  // Private constructor so only `create()` can be used to create an instance
  private constructor(
    config: ShadeConfig,
    dstackClient: DstackClient | undefined,
    accountId: string,
    agentPrivateKeys: string[],
    keysDerivedWithTEE: boolean,
  ) {
    this.config = config;
    this.dstackClient = dstackClient;
    this.agentAccountId = accountId;
    this.agentPrivateKeys = agentPrivateKeys;
    this.currentKeyIndex = 0;
    this.keysDerivedWithTEE = keysDerivedWithTEE;
    this.keysChecked = false;
  }

  /**
   * Creates a new ShadeClient instance asynchronously
   * @param config - Configuration object for the Shade client (see ShadeConfig interface for details)
   * @returns Promise that resolves to a ShadeClient instance
   * @throws Error if configuration is invalid, network ID mismatch, or key generation fails
   */
  static async create(config: ShadeConfig): Promise<ShadeClient> {
    // Validate and normalize configuration
    await validateShadeConfig(config);

    // Detect if running in a TEE
    const dstackClient = await getDstackClient();

    // Generate agent account ID and private key
    const agentPrivateKeys: string[] = [];
    const { accountId, agentPrivateKey, derivedWithTEE } = await generateAgent(
      dstackClient,
      config.derivationPath,
    );
    agentPrivateKeys.push(agentPrivateKey);

    // Return agent instance
    return new ShadeClient(
      config,
      dstackClient,
      accountId,
      agentPrivateKeys,
      derivedWithTEE,
    );
  }

  /**
   * Gets the NEAR account ID of the agent
   * @returns The agent's account ID
   */
  accountId(): string {
    return this.agentAccountId;
  }


  /**
   * Gets the NEAR balance of the agent account in human readable format (e.g. 1 = one NEAR)
   * @returns Promise that resolves to the account balance in NEAR tokens, if the agent account does not exist, returns 0
   * @throws Error if network request fails
   */
  async balance(): Promise<number> {
    const account = createAccountObject(
      this.agentAccountId,
      this.config.rpc!,
    );
    try {
      const balance = await account.getBalance();
      return parseFloat(NEAR.toDecimal(balance));
    } catch (error: any) {
      // If the account doesn't exist, return 0 instead of throwing
      if (error?.type === "AccountDoesNotExist") {
        return 0;
      }
      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Checks the agent's registration status on the agent contract
   * @returns Promise that resolves to an AgentStatus object containing registered, whitelisted, and codehash_is_approved booleans
   * @throws Error if agentContractId is not configured or if view call fails
   */
  async registrationStatus(): Promise<AgentStatus> {
    if (!this.config.agentContractId) {
      throw new Error(
        "agentContractId is required for checking registration status",
      );
    }

    const res = await this.view<GetAgentResponse | null>({
      methodName: "get_agent",
      args: {
        account_id: this.agentAccountId,
      },
    });

    if (res === null) {
      return {
        registered: false,
        whitelisted: false,
        codehash_is_approved: false,
      };
    }

    return {
      registered: res.registered,
      whitelisted: res.whitelisted,
      codehash_is_approved: res.codehash_is_approved,
    };
  }

  /**
   * Registers the agent in the agent contract
   * @returns Promise that resolves to true if registration was successful
   * @throws Error if agentContractId is not configured, if fetching attestation fails (network errors, timeouts), or if contract call fails
   */
  async register(): Promise<boolean> {
    if (!this.config.agentContractId) {
      throw new Error("agentContractId is required for registering the agent");
    }

    const attestation = await internalGetAttestation(
      this.dstackClient,
      this.agentAccountId,
      this.keysDerivedWithTEE,
    );

    // Call the register_agent function on the agent contract
    return await this.call({
      methodName: "register_agent",
      args: {
        attestation,
      },
      gas: BigInt("250000000000000"), // 250 TGas
    });
  }

  /**
   * Call a view function on the agent contract and return the result
   * @param params
   * @param params.methodName The method that will be called
   * @param params.args Arguments as a valid JSON Object
   * @param params.blockQuery (optional) Block reference for the query
   * @returns A promise that resolves with the result of the view function call
   * @throws Error if agentContractId is not configured or if RPC call fails
   */
  async view<T extends SerializedReturnValue>(params: {
    methodName: string;
    args: Record<string, unknown>;
    blockQuery?: BlockReference;
  }): Promise<T> {
    if (!this.config.agentContractId) {
      throw new Error("agentContractId is required for view calls");
    }

    // Call the view function on the agent contract
    return await this.config.rpc!.callFunction(
      this.config.agentContractId,
      params.methodName,
      params.args,
      params.blockQuery,
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
   * @throws Error if agentContractId is not configured, if key derivation fails, or if transaction fails
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

    // Check keys are the correct number and adjust if needed
    const { keysToAdd, wasChecked } = await ensureKeysSetup(
      this.agentAccountId,
      this.agentPrivateKeys,
      this.config.rpc!,
      this.config.numKeys!,
      this.dstackClient,
      this.config.derivationPath,
      this.keysDerivedWithTEE,
      this.keysChecked,
    );
    this.agentPrivateKeys.push(...keysToAdd);
    if (wasChecked) {
      this.keysChecked = true;
    }

    // Get the signer for the current key and create an account object with this signer
    const { signer, keyIndex } = getAgentSigner(
      this.agentPrivateKeys,
      this.currentKeyIndex,
    );
    this.currentKeyIndex = keyIndex;
    const account = createAccountObject(
      this.agentAccountId,
      this.config.rpc!,
      signer,
    );

    // Call the function on the agent contract
    return await account.callFunction({
      contractId: this.config.agentContractId,
      methodName: params.methodName,
      args: params.args,
      gas: params.gas,
      deposit: params.deposit,
      waitUntil: params.waitUntil,
    });
  }

  /**
   * Gets the TEE attestation for the agent
   * @returns Promise that resolves to the attestation object
   * @throws Error if fetching quote collateral fails (network errors, HTTP errors, timeouts)
   */
  async getAttestation(): Promise<Attestation> {
    return internalGetAttestation(
      this.dstackClient,
      this.agentAccountId,
      this.keysDerivedWithTEE,
    );
  }

  /**
   * Funds the agent account with NEAR tokens from the sponsor account
   * @param fundAmount - Amount of NEAR tokens to transfer to the agent account in human readable format (e.g. 1 = one NEAR)
   * @returns Promise that resolves when funding is complete
   * @throws Error if sponsor is not configured or if transfer fails after retries
   */
  async fundAgent(fundAmount: number): Promise<void> {
    if (!this.config.sponsor) {
      throw new Error("sponsor is required for funding the agent account");
    }

    await internalFundAgent(
      this.agentAccountId,
      this.config.sponsor.accountId,
      this.config.sponsor.privateKey,
      fundAmount,
      this.config.rpc!,
    );
  }

  /**
   * Gets the agent's private keys (use with caution)
   * @param acknowledgeRisk - Must be set to true to acknowledge the risk of exporting private keys
   * @returns Array of private key strings
   * @throws Error if acknowledgeRisk is not set to true
   */
  getAgentPrivateKeys(acknowledgeRisk: boolean = false): string[] {
    if (!acknowledgeRisk) {
      throw new Error(
        "WARNING: Exporting private keys from the library is a risky operation, you may accidentally leak them from the TEE. Do not use the keys to sign transactions other than to the agent contract. Please acknowledge the risk by setting acknowledgeRisk to true.",
      );
    }
    console.log(
      "WARNING: Exporting private keys from the library is a risky operation, you may accidentally leak them from the TEE. Do not use the keys to sign transactions other than to the agent contract.",
    );

    return this.agentPrivateKeys;
  }
}
