import { existsSync } from "fs";
import { TappdClient } from "./tappd";

export interface Attestation {
    quote_hex: string;
    collateral: string;
    checksum: string;
    tcb_info: string;
}

/**
 * Detects if the application is running in a TEE 
 * 
 * If it is running in a TEE but this fails for whatever reason,
 * then it will generate a deterministic account ID for the agent.
 * This could be dangerous, however, it will not be able to register in the contract
 * as it will not provide the attestation, which is required for registration.
 * 
 * @returns Promise<boolean> - true if running in a verified TEE environment, false otherwise
 */
export async function getTappdClient(): Promise<TappdClient | undefined> {
    // First check if socket exists
    if (!existsSync('/var/run/tappd.sock')) {
        return undefined;
    }
    
    // Then test if Tappd client actually works, if so return the client
    try {
        const client = new TappdClient();
        await client.getInfo();
        return client;
    } catch (error) {
        return undefined;
    }
}

export async function getAttestation(tappdClient: TappdClient | undefined, agentAccountId: string, keysDerivedWithTEE: boolean): Promise<Attestation> {
    if (!tappdClient || !keysDerivedWithTEE) {
        // If not in a TEE or keys were not derived with TEE, return a dummy attestation
        return {
            quote_hex: 'not-in-a-tee',
            collateral: 'not-in-a-tee',
            checksum: 'not-in-a-tee',
            tcb_info: 'not-in-a-tee',
        }
    } else {
        // If in a TEE, get real attestation
        let tcb_info = (await tappdClient.getInfo()).tcb_info;

        // Parse tcb_info
        if (typeof tcb_info !== 'string') {
            tcb_info = JSON.stringify(tcb_info);
        }

        // Get TDX quote
        const ra = await tappdClient.tdxQuote(agentAccountId, 'raw');
        const quote_hex = ra.quote.replace(/^0x/, '');

        // Get quote collateral
        const formData = new FormData();
        formData.append('hex', quote_hex);
        
        let collateral: string, checksum: string;
        try {
            // Add timeout to prevent hanging indefinitely
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
            
            const response = await fetch('https://proof.t16z.com/api/upload', {
                method: 'POST',
                body: formData,
                signal: controller.signal,
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                console.error(`Failed to get quote collateral: HTTP ${response.status}`);
                throw new Error(`Failed to get quote collateral: HTTP ${response.status}`);
            }
            
            const resHelper = await response.json();
            checksum = resHelper.checksum;
            collateral = JSON.stringify(resHelper.quote_collateral);
        } catch (error) {
            console.error(`Failed to get quote collateral: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to get quote collateral: ${error instanceof Error ? error.message : String(error)}`);
        }
        return {
            quote_hex,
            collateral,
            checksum,
            tcb_info,
        };
    }   
}