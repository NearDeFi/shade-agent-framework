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

// Recursively replace placeholders with their values
export function replacePlaceholders(args, replacements) {
    let result = args;
    
    // Handle string args (JSON)
    if (typeof result === 'string') {
        try {
            result = JSON.parse(result);
        } catch (e) {
            // If it's not valid JSON, exit with error
            console.log(chalk.red(`Error: Invalid JSON in args: ${result}`));
            process.exit(1);
        }
    }
    
    // Apply each replacement
    for (const [placeholder, value] of Object.entries(replacements)) {
        result = replacePlaceholderInValue(result, placeholder, value);
    }
    
    return result;
}

