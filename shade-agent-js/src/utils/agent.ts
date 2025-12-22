import { createHash } from 'node:crypto';
import { TappdClient } from './tappd';
import { generateSeedPhrase } from 'near-seed-phrase';
import { PublicKey, KeyPair, KeyPairString } from '@near-js/crypto';
import { KeyPairSigner } from '@near-js/signers';

export async function generateAgent(tappdClient: TappdClient | undefined, derivationPath: string | undefined): Promise<{ accountId: string, agentPrivateKey: string, derivedWithTEE: boolean }> {
    const { hash, usedTEE } = await deriveHash(tappdClient, derivationPath);
    const seedInfo = generateSeedPhrase(hash);

    const accountId = Buffer.from(PublicKey.from(seedInfo.publicKey).data).toString('hex').toLowerCase();

    return {
        accountId,
        agentPrivateKey: seedInfo.secretKey,
        derivedWithTEE: usedTEE,
    };
}

function deriveHashFromPath(derivationPath: string): Buffer {
    return createHash('sha256').update(Buffer.from(derivationPath)).digest();
}

function deriveHashFromRandom(): Buffer {
    const randomArray = new Uint8Array(32);
    crypto.getRandomValues(randomArray);
    const randomString = Buffer.from(randomArray).toString('hex');
    return createHash('sha256').update(Buffer.from(randomString)).digest();
}

async function deriveHashForTEE(tappdClient: TappdClient): Promise<Buffer> {
    // JS crypto random
    const randomArray = new Uint8Array(32);
    crypto.getRandomValues(randomArray);
    const randomString = Buffer.from(randomArray).toString('hex');

    // Entropy from TEE hardware
    const keyFromTee = await tappdClient.deriveKey(
        randomString,
        randomString,
    );

    // Hash of JS crypto random and TEE entropy
    return Buffer.from(
        await crypto.subtle.digest(
            'SHA-256',
            Buffer.concat([randomArray, keyFromTee.asUint8Array(32)]),
        ),
    );
}

async function deriveHash(tappdClient: TappdClient | undefined, derivationPath: string | undefined): Promise<{ hash: Buffer, usedTEE: boolean }> {
    let hash: Buffer;
    let usedTEE: boolean;
    
    if (!tappdClient && derivationPath) {
        // If not in a TEE and a derivation path is provided, use it to generate the hash
        // if different users use the same derivation path, they will get the same account ID 
        // so they should generate it to be unique
        hash = deriveHashFromPath(derivationPath);
        usedTEE = false;
    } else if (!tappdClient && !derivationPath) {
        // If it is not in a TEE and no derivation path is provided, generate a random hash
        hash = deriveHashFromRandom();
        usedTEE = false;
    } else {
        // If it is in a TEE generate a hash from the entropy from the TEE hardware and a random string
        hash = await deriveHashForTEE(tappdClient);
        usedTEE = true;
    }
    
    return { hash, usedTEE };
}

export async function deriveAndAddAdditionalKeys(
    numKeys: number,
    tappdClient: TappdClient | undefined,
    derivationPath: string | undefined
): Promise<{ additionalKeys: string[], allDerivedWithTEE: boolean }> {
    const { keys, allDerivedWithTEE } = await deriveAdditionalKeys(numKeys, tappdClient, derivationPath);
    return {
        additionalKeys: keys,
        allDerivedWithTEE,
    };
}

async function deriveAdditionalKeys(
    numKeys: number,
    tappdClient: TappdClient | undefined,
    derivationPath: string | undefined
): Promise<{ keys: string[], allDerivedWithTEE: boolean }> {
    // Generate numKeys additional keys
    // Run all derivations in parallel for better performance for TEE
    const keyPromises = Array.from({ length: numKeys }, async (_, index) => {
        const i = index + 1; // Start from 1
        // For additional keys with derivation path, append key index
        const keyDerivationPath = derivationPath ? `${derivationPath}-${i}` : undefined;
        const { hash, usedTEE } = await deriveHash(tappdClient, keyDerivationPath);
        const seedInfo = generateSeedPhrase(hash);
        // Return both the key and whether it was derived with TEE
        return {
            key: seedInfo.secretKey,
            derivedWithTEE: usedTEE,
        };
    });
    
    const results = await Promise.all(keyPromises);
    const keys = results.map(r => r.key);
    // Check if all keys were derived with TEE
    const allDerivedWithTEE = results.every(r => r.derivedWithTEE);
    
    return { keys, allDerivedWithTEE };
}

export function getAgentSigner(agentPrivateKeys: string[], currentKeyIndex: number): { signer: KeyPairSigner, keyIndex: number } {
    if (agentPrivateKeys.length === 0) {
        throw new Error('No agent keys available');
    }
    if (agentPrivateKeys.length === 1) {
        return {
            signer: KeyPairSigner.fromSecretKey(agentPrivateKeys[0] as KeyPairString),
            keyIndex: 0,
        };
    }
    currentKeyIndex++;
    if (currentKeyIndex > agentPrivateKeys.length - 1) {
        currentKeyIndex = 0;
    }
    return {
        signer: KeyPairSigner.fromSecretKey(agentPrivateKeys[currentKeyIndex] as KeyPairString),
        keyIndex: currentKeyIndex,
    };
}