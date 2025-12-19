// Checks if a transaction outcome indicates success or failure
// Returns true if successful, false if failed
export function checkTransactionOutcome(outcome) {
    // Check if outcome has transaction_outcome
    const txOutcome = outcome.transaction_outcome;
    if (!txOutcome) {
        return false;
    }
    
    // Check execution status
    if (outcome.status) {
        // Handle SuccessValue - check if it's bytes "false"
        if (outcome.status.SuccessValue !== undefined) {
            const successValue = outcome.status.SuccessValue;
            let decodedValue = successValue;
            
            // Try to decode if it's base64
            if (typeof successValue === 'string') {
                try {
                    const decoded = Buffer.from(successValue, 'base64').toString('utf8');
                    decodedValue = decoded;
                } catch (e) {
                    // Not base64, use as-is
                    decodedValue = successValue;
                }
            }
            
            // Check if the value is "false" (as bytes or string)
            if (decodedValue === false || decodedValue === 'false' || decodedValue === Buffer.from('false').toString('base64')) {
                return false;
            }
            
            // Success!
            return true;
        }
        
        // Handle Failure
        if (outcome.status.Failure) {
            return false;
        }
        
        // Handle other statuses (NotStarted, Started - should be unreachable)
        if (outcome.status.NotStarted || outcome.status.Started) {
            return false;
        }
    }
    
    // If we get here and have a transaction outcome, assume success
    // This handles cases where the status might not be in the expected format
    return true;
}

// Checks a transaction response that may have final_execution_outcome or be the outcome directly
export function checkTransactionResponse(response) {
    // Check if response has final_execution_outcome
    if (response.final_execution_outcome) {
        return checkTransactionOutcome(response.final_execution_outcome);
    }
    
    // Check if the response itself is the outcome
    if (response.status && response.transaction_outcome) {
        return checkTransactionOutcome(response);
    }
    
    // Invalid response structure
    return false;
}
