import net from 'net';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { URL } from 'url';

export interface DeriveKeyResponse {
    key: string;
    certificate_chain: string[];

    asUint8Array: (max_length?: number) => Uint8Array;
}

export type Hex = `0x${string}`;

export type TdxQuoteHashAlgorithms =
    | 'sha256'
    | 'sha384'
    | 'sha512'
    | 'sha3-256'
    | 'sha3-384'
    | 'sha3-512'
    | 'keccak256'
    | 'keccak384'
    | 'keccak512'
    | 'raw';

export interface TdxQuoteResponse {
    quote: Hex;
    event_log: string;

    replayRtmrs: () => string[];
}

/**
 * Converts various data types to hexadecimal string representation
 * @param data - Data to convert (string, Buffer, or Uint8Array)
 * @returns Hexadecimal string representation of the data
 */
export function to_hex(data: string | Buffer | Uint8Array): string {
    if (typeof data === 'string') {
        return Buffer.from(data).toString('hex');
    }
    if (data instanceof Uint8Array) {
        return Buffer.from(data).toString('hex');
    }
    return (data as Buffer).toString('hex');
}

/**
 * Converts an X.509 PEM private key to a Uint8Array
 * @param pem - PEM formatted private key string
 * @param max_length - Maximum length of the resulting array (optional)
 * @returns Uint8Array representation of the private key
 */
function x509key_to_uint8array(pem: string, max_length?: number) {
    const content = pem
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\n/g, '');
    const binaryDer = atob(content);
    if (!max_length) {
        max_length = binaryDer.length;
    }
    const result = new Uint8Array(max_length);
    for (let i = 0; i < max_length; i++) {
        result[i] = binaryDer.charCodeAt(i);
    }
    return result;
}

/**
 * Replays RTMR (Runtime Measurement Register) history
 * @param history - Array of hex strings representing RTMR history
 * @returns Hex string of the computed RTMR value
 */
function replay_rtmr(history: string[]): string {
    const INIT_MR =
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
    if (history.length === 0) {
        return INIT_MR;
    }
    let mr = Buffer.from(INIT_MR, 'hex');
    for (const content of history) {
        // Convert hex string to buffer
        let contentBuffer = Buffer.from(content, 'hex');
        // Pad content with zeros if shorter than 48 bytes
        if (contentBuffer.length < 48) {
            const padding = Buffer.alloc(48 - contentBuffer.length, 0);
            contentBuffer = Buffer.concat([contentBuffer, padding]);
        }
        mr = crypto
            .createHash('sha384')
            .update(Buffer.concat([mr, contentBuffer]))
            .digest() as Buffer<ArrayBuffer>;
    }
    return mr.toString('hex');
}

interface EventLog {
    imr: number;
    digest: string;
}

/**
 * Replays RTMRs from event log
 * @param event_log - Array of event log entries with IMR and digest
 * @returns Record mapping IMR index to computed RTMR value
 */
function reply_rtmrs(event_log: EventLog[]): Record<number, string> {
    const rtmrs: Array<string> = [];
    for (let idx = 0; idx < 4; idx++) {
        const history = event_log
            .filter((event) => event.imr === idx)
            .map((event) => event.digest);
        rtmrs[idx] = replay_rtmr(history);
    }
    return rtmrs;
}

/**
 * Sends an RPC request to a Tappd endpoint
 * @param endpoint - The endpoint URL or Unix socket path
 * @param path - The RPC path to call
 * @param payload - JSON payload to send
 * @returns Promise with the response data
 */
export function send_rpc_request<T = any>(
    endpoint: string,
    path: string,
    payload: string,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const abortController = new AbortController();
        const timeout = setTimeout(() => {
            abortController.abort();
            reject(new Error('Request timed out'));
        }, 30_000); // 30 seconds timeout

        const isHttp =
            endpoint.startsWith('http://') || endpoint.startsWith('https://');

        if (isHttp) {
            const url = new URL(path, endpoint);
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            };

            const req = (url.protocol === 'https:' ? https : http).request(
                url,
                options,
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        clearTimeout(timeout);
                        try {
                            const result = JSON.parse(data);
                            resolve(result as T);
                        } catch (error) {
                            reject(new Error('Failed to parse response'));
                        }
                    });
                },
            );

            req.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });

            abortController.signal.addEventListener('abort', () => {
                req.destroy();
                reject(new Error('Request aborted'));
            });

            req.write(payload);
            req.end();
        } else {
            const client = net.createConnection({ path: endpoint }, () => {
                client.write(`POST ${path} HTTP/1.1\r\n`);
                client.write(`Host: localhost\r\n`);
                client.write(`Content-Type: application/json\r\n`);
                client.write(`Content-Length: ${payload.length}\r\n`);
                client.write('\r\n');
                client.write(payload);
            });

            let data = '';
            let headers: Record<string, string> = {};
            let headersParsed = false;
            let contentLength = 0;
            let bodyData = '';

            client.on('data', (chunk) => {
                data += chunk;
                if (!headersParsed) {
                    const headerEndIndex = data.indexOf('\r\n\r\n');
                    if (headerEndIndex !== -1) {
                        const headerLines = data
                            .slice(0, headerEndIndex)
                            .split('\r\n');
                        headerLines.forEach((line) => {
                            const [key, value] = line.split(': ');
                            if (key && value) {
                                headers[key.toLowerCase()] = value;
                            }
                        });
                        headersParsed = true;
                        contentLength = parseInt(
                            headers['content-length'] || '0',
                            10,
                        );
                        bodyData = data.slice(headerEndIndex + 4);
                    }
                } else {
                    bodyData += chunk;
                }

                if (headersParsed && bodyData.length >= contentLength) {
                    client.end();
                }
            });

            client.on('end', () => {
                clearTimeout(timeout);
                try {
                    const result = JSON.parse(bodyData.slice(0, contentLength));
                    resolve(result as T);
                } catch (error) {
                    reject(new Error('Failed to parse response'));
                }
            });

            client.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });

            abortController.signal.addEventListener('abort', () => {
                client.destroy();
                reject(new Error('Request aborted'));
            });
        }
    });
}

/**
 * Client for interacting with the Tappd service
 */
export class TappdClient {
    private endpoint: string;

    /**
     * Creates a new TappdClient instance
     * @param endpoint - The Tappd endpoint (default: '/var/run/tappd.sock')
     */
    constructor(endpoint: string = '/var/run/tappd.sock') {
        this.endpoint = endpoint;
    }

    /**
     * Gets information about the Tappd service and TEE environment
     * @returns Promise with Tappd service information including TCB info
     */
    async getInfo(): Promise<any> {
        const result = await send_rpc_request<any>(
            this.endpoint,
            '/prpc/Tappd.Info',
            '',
        );

        return result;
    }

    /**
     * Extends RTMR3 with an event and payload
     * @param event - Event name to log
     * @param payload - Event payload (string or object)
     * @returns Promise with the result of the event emission
     */
    async extendRtmr3(event: string, payload: string | object): Promise<any> {
        const payloadJson =
            typeof payload === 'string' ? payload : JSON.stringify(payload);
        const result = await send_rpc_request<DeriveKeyResponse>(
            this.endpoint,
            '/prpc/Tappd.EmitEvent',
            JSON.stringify({ event, payload: payloadJson }),
        );
        return result;
    }

    /**
     * Derives a cryptographic key using TEE hardware
     * @param path - Key derivation path (optional)
     * @param subject - Subject for key derivation (optional)
     * @param alt_names - Alternative names for the key (optional)
     * @returns Promise with derived key response including certificate chain
     */
    async deriveKey(
        path?: string,
        subject?: string,
        alt_names?: string[],
    ): Promise<DeriveKeyResponse> {
        let raw: Record<string, any> = {
            path: path || '',
            subject: subject || path || '',
        };
        if (alt_names && alt_names.length) {
            raw['alt_names'] = alt_names;
        }
        const payload = JSON.stringify(raw);
        const result = await send_rpc_request<DeriveKeyResponse>(
            this.endpoint,
            '/prpc/Tappd.DeriveKey',
            payload,
        );
        Object.defineProperty(result, 'asUint8Array', {
            get: () => (length?: number) =>
                x509key_to_uint8array(result.key, length),
            enumerable: true,
            configurable: false,
        });
        return Object.freeze(result);
    }

    /**
     * Generates a TDX (Trust Domain Extensions) quote for TEE attestation
     * @param report_data - Data to include in the quote (string, Buffer, or Uint8Array)
     * @param hash_algorithm - Hash algorithm to use (default: undefined, uses 'raw' for direct data)
     * @returns Promise with TDX quote response including quote and event log
     * @throws Error if report data is too large for raw mode or if Tappd returns an error
     */
    async tdxQuote(
        report_data: string | Buffer | Uint8Array,
        hash_algorithm?: TdxQuoteHashAlgorithms,
    ): Promise<TdxQuoteResponse> {
        let hex = to_hex(report_data);
        if (hash_algorithm === 'raw') {
            if (hex.length > 128) {
                throw new Error(
                    `Report data is too large, it should less then 64 bytes when hash_algorithm is raw.`,
                );
            }
            if (hex.length < 128) {
                hex = hex.padStart(128, '0');
            }
        }
        const payload = JSON.stringify({ report_data: hex, hash_algorithm });
        const result = await send_rpc_request<TdxQuoteResponse>(
            this.endpoint,
            '/prpc/Tappd.TdxQuote',
            payload,
        );
        if ('error' in result) {
            const err = result['error'] as string;
            throw new Error(err);
        }
        Object.defineProperty(result, 'replayRtmrs', {
            get: () => () =>
                reply_rtmrs(JSON.parse(result.event_log) as EventLog[]),
            enumerable: true,
            configurable: false,
        });
        return Object.freeze(result);
    }
}
