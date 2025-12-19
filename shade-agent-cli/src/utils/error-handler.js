import chalk from 'chalk';
import select from '@inquirer/select';

// Checks if exit error
export function isExitPromptError(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const errorName = 'name' in error ? error.name : null;
    const errorMessage = 'message' in error && typeof error.message === 'string' ? error.message : null;
    return errorName === 'ExitPromptError' || (errorMessage && errorMessage.includes('SIGINT'));
}

// Helper to handle exit error in catch blocks
export function handleExitPromptError(error) {
    if (isExitPromptError(error)) {
        process.exit(0);
    }
    throw error;
}

// Helper to display validation error
function showValidationError(value, options, errorMessage = null, parentCommand = null, itemType = 'option') {
    if (errorMessage) {
        console.error(chalk.red(errorMessage));
    } else if (parentCommand) {
        // Use "subcommand" for auth subcommands, otherwise use itemType
        const typeLabel = itemType === 'subcommand' ? 'subcommand' : itemType;
        console.error(chalk.red(`Error: '${value}' is not a valid ${typeLabel} for '${parentCommand}'.`));
    } else {
        console.error(chalk.red(`Error: Unknown ${itemType} '${value}'.`));
    }
    
    const label = itemType === 'subcommand' ? 'subcommands' : 'options';
    console.error(chalk.yellow(`\nAvailable ${label}:`));
    options.forEach(option => {
        console.error(`  ${chalk.yellow(option.value)} - ${chalk.blue(option.description)}`);
    });
    
    if (parentCommand) {
        console.error(chalk.yellow(`\nRun 'shade ${parentCommand}' without arguments to see the interactive menu.`));
    } else {
        console.error(chalk.yellow('\nRun \'shade\' without arguments to see the interactive menu.'));
    }
    process.exit(1);
}

// Function to validate and prompt for options
export async function validateAndSelectOption({
    value,
    options,
    message,
    errorMessage = null,
    parentCommand = null,
    itemType = 'option'
}) {
    // Derive validValues from options
    const validValues = options.map(opt => opt.value);
    
    // Validate option if provided
    if (value && !validValues.includes(value)) {
        showValidationError(value, options, errorMessage, parentCommand, itemType);
    }
    
    // Prompt user with options if option provided
    if (!value) {
        value = await select({
            message,
            choices: options.map(opt => ({
                name: `${chalk.yellow(opt.value)} - ${chalk.blue(opt.description)}`,
                value: opt.value
            }))
        });
    }
    
    return value;
}

// Helper for too many arguments error
function handleTooManyArgs(commandName, maxArgs, parentCommand) {
    const args = process.argv.slice(2);
    let cmdIndex;
    
    if (parentCommand) {
        // For subcommands (e.g., auth set)
        const parentIndex = args.indexOf(parentCommand);
        cmdIndex = args.indexOf(commandName, parentIndex);
    } else {
        // For top-level commands
        cmdIndex = args.indexOf(commandName);
    }
    
    if (cmdIndex === -1) {
        // Fallback: just use the command name
        console.error(chalk.red(`Error: No more arguments are required after '${commandName}'.`));
    } else {
        const providedArgs = args.slice(cmdIndex + 1);
        const lastValidArg = maxArgs > 0 && providedArgs.length > maxArgs
            ? providedArgs[Math.min(maxArgs - 1, providedArgs.length - 2)] || commandName
            : commandName;
        console.error(chalk.red(`Error: No more arguments are required after '${lastValidArg}'.`));
    }
    process.exit(1);
}

// Create error handler for commands (handles "too many arguments" and optionally "unknown command/option")
export function createCommandErrorHandler(commandName, options = {}) {
    const {
        maxArgs = 0,
        parentCommand = null,
        validOptions = null,  // If provided, show validation error for unknown command/option
        itemType = 'option'   // 'option' or 'subcommand'
    } = options;
    
    return {
        writeErr: (str) => {
            if (str.includes('too many arguments') || str.includes('unknown option') || str.includes('unknown command')) {
                // Handle unknown command/option with validation error if validOptions provided
                if (validOptions && (str.includes('unknown command') || str.includes('unknown option'))) {
                    const args = process.argv.slice(2);
                    const providedArg = args[1]; // The argument after the command
                    showValidationError(providedArg, validOptions, null, commandName, itemType);
                } else {
                    // Handle "too many arguments"
                    handleTooManyArgs(commandName, maxArgs, parentCommand);
                }
            } else {
                process.stderr.write(str);
            }
        }
    };
}


