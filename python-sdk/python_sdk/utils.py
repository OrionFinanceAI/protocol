from .chain_interactions import get_whitelisted_vaults, get_curator_intent_decimals
import random
import numpy as np

random.seed(42) # Curator-set private seed for irreproducibility

# TODO: coprocessor, for encoded intents: to check FHE encrypted intents associated with protocol public FHE context.

def validate_order(order_intent: dict, fuzz: bool = False):
    whitelisted_vaults = get_whitelisted_vaults()
    curator_intent_decimals = get_curator_intent_decimals()

    # Validate all tokens are whitelisted
    invalid_tokens = [token for token in order_intent.keys() if token not in whitelisted_vaults]
    if invalid_tokens:
        raise ValueError(f"The following tokens are not whitelisted: {invalid_tokens}")

    # Validate all amounts are positive
    if any(weight <= 0 for weight in order_intent.values()):
        raise ValueError("All amounts must be positive")

    # Validate the sum of amounts is approximately 1 (within tolerance for floating point error)
    TOLERANCE = 1e-10
    if not np.isclose(sum(order_intent.values()), 1, atol=TOLERANCE):
        raise ValueError("The sum of amounts is not 1 (within floating point tolerance).")

    if fuzz:
        # Add remaining whitelisted vaults with small random amounts
        for vault in whitelisted_vaults:
            if vault not in order_intent.keys():
                order_intent[vault] = random.randint(1, 10) / 10 ** curator_intent_decimals

        # Normalize again to sum to 1
        order_intent = {token: weight / sum(order_intent.values()) for token, weight in order_intent.items()}

    order_intent = {token: weight * 10 ** curator_intent_decimals for token, weight in order_intent.items()}
    rounded_values = round_with_fixed_sum(list(order_intent.values()), 10 ** curator_intent_decimals)
    order_intent = dict(zip(order_intent.keys(), rounded_values))

    return order_intent

def round_with_fixed_sum(values, target_sum=None):
    values = np.asarray(values, dtype=np.float64)
    
    if target_sum is None:
        target_sum = int(round(np.sum(values)))

    floored = np.floor(values).astype(int)
    remainder = int(round(target_sum - np.sum(floored)))

    # Get the fractional parts and their indices
    fractional_parts = values - floored
    indices = np.argsort(-fractional_parts)  # Descending order

    # Allocate the remaining units
    result = floored.copy()
    result[indices[:remainder]] += 1

    return result.tolist()