import chalk from 'chalk';

// Replace placeholder with value
function replacePlaceholderInValue(val, placeholder, value) {
    if (typeof val === 'string') {
        if (val === placeholder) {
            return value;
        }
        return val;
    }
    if (Array.isArray(val)) {
        return val.map(v => replacePlaceholderInValue(v, placeholder, value));
    }
    if (val && typeof val === 'object') {
        return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, replacePlaceholderInValue(v, placeholder, value)]));
    }
    return val;
}

// Check if a placeholder exists anywhere in the args object
function hasPlaceholder(args, placeholder) {
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

// Recursively replace placeholders with their values
// Only replaces placeholders that actually exist in the args
export function replacePlaceholders(args, replacements) {
    let result = args;
    
    // Handle string args (JSON)
    if (typeof result === 'string') {
        // First, replace placeholders in the string (handles unquoted placeholders in JSON)
        for (const [placeholder, value] of Object.entries(replacements)) {
            if (result.includes(placeholder)) {
                // Convert value to proper JSON format using JSON.stringify
                // This handles strings (quotes), booleans (true/false), numbers, null, etc.
                const jsonValue = JSON.stringify(value);
                result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), jsonValue);
            }
        }
        
        // Now try to parse the JSON
        try {
            result = JSON.parse(result);
        } catch (e) {
            // If it's still not valid JSON, exit with error
            console.log(chalk.red(`Error: Invalid JSON in args: ${result}`));
            process.exit(1);
        }
    } else {
        // For non-string args, use the recursive replacement
        for (const [placeholder, value] of Object.entries(replacements)) {
            if (hasPlaceholder(result, placeholder)) {
                result = replacePlaceholderInValue(result, placeholder, value);
            }
        }
    }
    
    return result;
}

