import chalk from 'chalk';
import { checkTransactionResponse } from '../../utils/transaction-outcome.js';

// Helper function to create account via faucet service
export async function createAccountViaFaucet(accountId, publicKey) {
    const faucetUrl = 'https://helper.nearprotocol.com/account';
    
    const data = {
        newAccountId: accountId,
        newAccountPublicKey: publicKey,
    };
    
    try {
        console.log(chalk.blue(`\nCreating account via faucet service...`));
        const response = await fetch(faucetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.log(chalk.red(`\nError creating account via faucet: Faucet service failed with status ${response.status}: ${errorText}`));
            process.exit(1);
        }
        
        const result = await response.json();
        
        // Check transaction outcome
        const success = checkTransactionResponse(result);
        
        if (!success) {
            console.log(chalk.red('✗ Account creation failed'));
            process.exit(1);
        }
        
        return true;
    } catch (error) {
        console.log(chalk.red(`\nError creating account via faucet: ${error.message}`));
        process.exit(1);
    }
}
