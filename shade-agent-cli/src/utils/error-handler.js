// Helper function to check if error is a SIGINT/ExitPromptError
export function isExitPromptError(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const errorName = 'name' in error ? error.name : null;
    const errorMessage = 'message' in error && typeof error.message === 'string' ? error.message : null;
    return errorName === 'ExitPromptError' || (errorMessage && errorMessage.includes('SIGINT'));
}

// Helper to handle ExitPromptError in catch blocks
// If it's an ExitPromptError, exit gracefully; otherwise, re-throw
export function handleExitPromptError(error) {
    if (isExitPromptError(error)) {
        process.exit(0);
    }
    throw error;
}

import chalk from 'chalk';

// Helper to show invalid argument error in consistent format
export function showInvalidArgumentError(invalidArg, commandName, options) {
    console.error(chalk.red(`Error: '${invalidArg}' is not a valid ${commandName} for 'auth'.`));
    console.error(chalk.yellow('\nAvailable options:'));
    options.forEach(option => {
        console.error(`  ${chalk.yellow(option.value)} - ${chalk.blue(option.description)}`);
    });
    process.exit(1);
}

