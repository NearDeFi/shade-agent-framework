// Convert TeraGas (TGas) to Gas units
export function tgasToGas(tgas) {
    return BigInt(tgas) * BigInt(1000000000000);
}

