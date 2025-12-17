/**
 * Recursively replace a placeholder identifier with a value throughout an args object
 * @param {any} args - The args object (can be string, object, array, etc.)
 * @param {string} placeholder - The placeholder to replace (e.g., '<CODEHASH>')
 * @param {any} value - The value to replace it with
 * @returns {any} - The args object with placeholders replaced
 */
export function replacePlaceholder(args, placeholder, value) {
    const replace = (val) => {
        if (typeof val === 'string') {
            if (val === placeholder) {
                return value;
            }
            return val;
        }
        if (Array.isArray(val)) {
            return val.map(replace);
        }
        if (val && typeof val === 'object') {
            return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, replace(v)]));
        }
        return val;
    };
    
    // Handle string args (JSON)
    if (typeof args === 'string') {
        try {
            const parsed = JSON.parse(args);
            const replaced = replace(parsed);
            return replaced;
        } catch (e) {
            // If it's not valid JSON, just return as-is
            return args === placeholder ? value : args;
        }
    }
    
    return replace(args);
}

/**
 * Check if a placeholder exists anywhere in the args object
 * @param {any} args - The args object
 * @param {string} placeholder - The placeholder to search for
 * @returns {boolean} - True if placeholder exists, false otherwise
 */
export function hasPlaceholder(args, placeholder) {
    const check = (val) => {
        if (typeof val === 'string') {
            return val === placeholder;
        }
        if (Array.isArray(val)) {
            return val.some(check);
        }
        if (val && typeof val === 'object') {
            return Object.values(val).some(check);
        }
        return false;
    };
    
    // Handle string args (JSON)
    if (typeof args === 'string') {
        if (args === placeholder) {
            return true;
        }
        try {
            const parsed = JSON.parse(args);
            return check(parsed);
        } catch (e) {
            return false;
        }
    }
    
    return check(args);
}

/**
 * Recursively replace multiple placeholders with their values
 * @param {any} args - The args object
 * @param {Object} replacements - Object mapping placeholder strings to their values
 * @returns {any} - The args object with all placeholders replaced
 */
export function replacePlaceholders(args, replacements) {
    let result = args;
    
    // Handle string args (JSON)
    if (typeof result === 'string') {
        try {
            result = JSON.parse(result);
        } catch (e) {
            // If it's not valid JSON, treat as plain string
            for (const [placeholder, value] of Object.entries(replacements)) {
                if (result === placeholder) {
                    return value;
                }
            }
            return result;
        }
    }
    
    // Apply each replacement
    for (const [placeholder, value] of Object.entries(replacements)) {
        result = replacePlaceholder(result, placeholder, value);
    }
    
    return result;
}

