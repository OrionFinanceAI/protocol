# # Stochastic Optimal Control Framework for Buffer Management

# ## Problem Description

# We consider a financial system where a **buffer** is maintained to absorb slippage and transaction costs arising from
# stochastic market events. The buffer must satisfy the following criteria:

# - **Positivity Constraint:** The buffer should remain non-negative at all times to ensure solvency.
# - **Buffer Minimization:** The buffer size should be as small as possible relative to the Total Value Locked (TVL) to
#   reduce capital inefficiency.
# - **Smooth Fee Dynamics:** The dynamic fee rate, which adjusts the buffer level, should evolve smoothly over time to
#   avoid sharp fee spikes that can discourage market participants.

# The system is influenced by a stochastic slippage process with a **non-zero mean** and occasional extreme events,
# modeled as a mixture of Gaussian noise and rare jump components.

# ---

# ## Control Objective

# Define the control policy \( \pi \) as a mapping from the current buffer state \( B_t \) to a fee rate \( F_t = \pi(B_t)
# \).

# The goal is to find a policy \( \pi \) that balances:

# 1. **Solvency:** Keep \( B_t \geq 0 \) for all \( t \).
# 2. **Capital Efficiency:** Minimize the buffer ratio

# \[ \frac{B_t}{V} \]

# over time, ideally keeping it close to a target \( x^\star \). 3. **Smoothness:** Ensure \( F_t \) varies smoothly,
# avoiding abrupt changes.

import numpy as np
import matplotlib.pyplot as plt

# --- Simulation parameters ---
epochs = 365 * 2
# --- Simulated slippage model (Gaussian + extreme events) ---
np.random.seed(42)
# Models continuous, minor slippage due to market impact + micro-volatility (e.g., drift and diffusion in a Brownian motion).
base_slippage = np.random.normal(0.0005, 0.001, size=epochs)

# Simulates rare market stress conditions — adapter mismatch, liquidity crunch, MEV front-runs, stale pricing.
extreme_events = np.random.binomial(1, 0.02, size=epochs) 
extreme_slippage = np.random.normal(0.0, 0.03, size=epochs) * extreme_events

raw_slippage_series = base_slippage + extreme_slippage
# Controlling execution and reverting high slippage events:
# Rerefence: Uniswap, Curve, Yearn, Balancer.
# Note that optimal execution can lead to lower slippage, this is an upper bound used to have a conservative
# estimation of the slippage statistics and design a robust and capital efficient buffer.
# This bound is saying: "if the execution engine is unable to find an execution policy with an average slippage below this,
# (partially) revert the transaction".
slippage_bound = 0.005
# Setting a bit above the standard 0.03. At the same time, in the multivariate case, the portfolio slippage is lower, given is weighted average of slippages all of max this value.
# So geometrically, it's still possible to have this at the portfolio level, but the more assets, the less probable.
slippage_series = np.clip(raw_slippage_series, -slippage_bound, slippage_bound)

# Simulate dynamic TVL growing in time arriving "at regime" and look at the population of the buffer as the protocol TVL changes.
noise = np.random.normal(0.0, 100_000.0, size=epochs)
tvl = np.power(np.linspace(2, 10, epochs), 2) * 50_000 + noise
tvl = np.maximum(50_000, tvl)

target_ratio = slippage_bound * 1.1 # bigger than slippage bound to ensure solvency while using a smoother fee time series (second order buffer).
initial_buffer = target_ratio * tvl[0] # Setting initial buffer to target ratio to avoid big initial fees.

# Create figure with 3 subplots
fig, (ax1, ax2, ax3) = plt.subplots(1, 3, figsize=(20, 6))

# Base slippage subplot (Gaussian noise)
ax1.plot(base_slippage, color='blue', alpha=0.7, linewidth=1.5)
ax1.set_title('Base Market Impact (Gaussian)', fontsize=12, pad=15)
ax1.set_xlabel('Execution Step', fontsize=10)
ax1.set_ylabel('Slippage Amount', fontsize=10)
ax1.grid(True, linestyle='--', alpha=0.3)

# Raw slippage subplot (with extreme events)
ax2.plot(raw_slippage_series, color='purple', alpha=0.7, linewidth=1.5)
ax2.set_title('Raw Slippage (with Extreme Events)', fontsize=12, pad=15)
ax2.set_xlabel('Execution Step', fontsize=10)
ax2.set_ylabel('Slippage Amount', fontsize=10)
ax2.grid(True, linestyle='--', alpha=0.3)

# Clipped slippage subplot (controlled execution)
ax3.plot(slippage_series, color='green', alpha=0.7, linewidth=1.5)
ax3.set_title('Controlled Execution (Clipped)', fontsize=12, pad=15)
ax3.set_xlabel('Execution Step', fontsize=10)
ax3.set_ylabel('Slippage Amount', fontsize=10)
ax3.grid(True, linestyle='--', alpha=0.3)

plt.tight_layout()

# --- Dynamic fee function with smoothing ---
class SmoothFeeController:
    def __init__(self, target_ratio, smoothing_factor):
        self.target_ratio = target_ratio
        self.smoothing_factor = smoothing_factor  # Exponential smoothing factor
        self.smoothed_error = 0.0
    
    def calculate_fee_rate(self, current_buffer, current_tvl):
        buffer_ratio = current_buffer / current_tvl
        # If buffer is below slippage bound, return the slippage bound.
        if buffer_ratio < slippage_bound:
            new_fee = 1.000001 * (slippage_bound - buffer_ratio)
            return new_fee
        
        error = self.target_ratio - buffer_ratio

        # Exponential smoothing of the error
        self.smoothed_error = (self.smoothing_factor * error + 
                            (1 - self.smoothing_factor) * self.smoothed_error)
        
        # Proportional control with smoothed error
        k = 1.
        new_fee = k * self.smoothed_error
                
        new_fee = max(0.0, new_fee)  # Ensure non-negative fees

        return new_fee

# Initialize the smooth fee controller
fee_controller = SmoothFeeController(
    target_ratio=target_ratio,
    smoothing_factor=0.05,
)
# + protocol_gas_epoch
# (chainlink price for USDC/ETH exchange to compute one part, historical average gwei per protocol epoch for the other?) 
# + zama_decryption_costs 
# # + 50% of the estimated savings due to netting (can we compute it?)
# + protocol_fee?

# Original simple fee function for comparison
def simple_fee_rate(current_buffer, current_tvl):
    buffer_ratio = current_buffer / current_tvl
    k = 1
    fee = k * (target_ratio - buffer_ratio)
    return max(0.0, fee)

# --- Tracking variables ---
buffer_over_time = [initial_buffer]
fees_collected = []
fee_rates = []
original_fee_rates = []  # For comparison

# --- Simulation loop ---
for i in range(epochs):
    current_buffer = buffer_over_time[-1]
    current_tvl = tvl[i]
    fee_rate = fee_controller.calculate_fee_rate(current_buffer, current_tvl)
    original_fee_rate = simple_fee_rate(current_buffer, current_tvl)
    fees = fee_rate * current_tvl

    slippage = slippage_series[i]
    total_slippage_cost = slippage * current_tvl

    new_buffer = current_buffer + fees - total_slippage_cost
    buffer_over_time.append(new_buffer)
    fees_collected.append(fees)
    fee_rates.append(fee_rate)
    original_fee_rates.append(original_fee_rate)

# --- Plotting results ---

# Create subplots in a 3x2 grid
fig, axes = plt.subplots(3, 2, figsize=(16, 12))
fig.suptitle('Buffer Simulation Results', fontsize=16, fontweight='bold')

# Figure 1: Buffer Level Over Time
ax1 = axes[0, 0]
ax1.plot(buffer_over_time, label="Buffer Level ($)", color='blue', linewidth=2)
ax1.axhline(y=0, color='red', linestyle='--', label="Buffer Floor")
ax1.set_xlabel("Batch Execution Step")
ax1.set_ylabel("Buffer ($)")
ax1.set_title("Buffer Level Evolution Over Time")
ax1.legend()
ax1.grid(True, alpha=0.3)

# Highlight insolvency events
insolvent_steps = [i for i, b in enumerate(buffer_over_time) if b <= 0]
if insolvent_steps:
    ax1.scatter(insolvent_steps, [buffer_over_time[i] for i in insolvent_steps], color='red', s=10, label="Insolvent")

# Figure 2: Dynamic Fee Rate Comparison
ax2 = axes[0, 1]
ax2.plot([rate * 100 for rate in fee_rates], label="Smooth Fee Rate (%)", color='green', linewidth=2)
ax2.plot([rate * 100 for rate in original_fee_rates], label="Original Fee Rate (%)", color='red', linewidth=1, alpha=0.7)
ax2.set_xlabel("Batch Execution Step")
ax2.set_ylabel("Fee Rate (%)")
ax2.set_title("Fee Rate Evolution: Smooth vs Original")
ax2.legend()
ax2.grid(True, alpha=0.3)

# Figure 3: Slippage Events
ax3 = axes[1, 0]
ax3.plot(slippage_series, label="Slippage Amount", color='purple', linewidth=1, alpha=0.7)
ax3.set_xlabel("Batch Execution Step")
ax3.set_ylabel("Slippage Amount")
ax3.set_title("Slippage Events Over Time")
ax3.legend()
ax3.grid(True, alpha=0.3)

# Figure 4: Fees Collected with Moving Averages
ax4 = axes[1, 1]
ax4.plot(fees_collected, label="Fees Collected ($)", color='orange', linewidth=2, alpha=0.8)

# Calculate multiple moving averages
window_sizes = [30, 90, 180, 360]  # Different window sizes for moving averages
colors = ['blue', 'green', 'red', 'purple']
labels = ['MA(30)', 'MA(90)', 'MA(180)', 'MA(360)']

for i, window in enumerate(window_sizes):
    if len(fees_collected) >= window:
        # Calculate moving average
        ma = []
        for j in range(len(fees_collected)):
            if j < window - 1:
                ma.append(np.nan)  # Not enough data for full window
            else:
                ma.append(np.mean(fees_collected[j-window+1:j+1]))
        
        ax4.plot(ma, label=labels[i], color=colors[i], linewidth=1.5, alpha=0.8)

ax4.set_xlabel("Batch Execution Step")
ax4.set_ylabel("Fees Collected ($)")
ax4.set_title("Fees Collected Over Time with Moving Averages")
ax4.legend()
ax4.grid(True, alpha=0.3)

# Figure 5: Fee Rate Changes (First Differences)
ax5 = axes[2, 0]
smooth_fee_changes = np.diff([rate * 100 for rate in fee_rates])
original_fee_changes = np.diff([rate * 100 for rate in original_fee_rates])
ax5.plot(smooth_fee_changes, label="Smooth Fee Changes (%)", color='green', linewidth=1, alpha=0.8)
ax5.plot(original_fee_changes, label="Original Fee Changes (%)", color='red', linewidth=1, alpha=0.6)
ax5.axhline(y=0, color='black', linestyle='-', alpha=0.3)
ax5.set_xlabel("Batch Execution Step")
ax5.set_ylabel("Fee Rate Change (%)")
ax5.set_title("Fee Rate Changes Over Time")
ax5.legend()
ax5.grid(True, alpha=0.3)

# Figure 6: Buffer Health Ratio
ax6 = axes[2, 1]
buffer_ratio = [b / t for b, t in zip(buffer_over_time, tvl)]
ax6.plot(buffer_ratio, label="Buffer/TVL Ratio", color='purple', linewidth=2)
ax6.axhline(y=0.02, color='red', linestyle='--', label="2% Threshold")
ax6.axhline(y=0.05, color='orange', linestyle='--', label="5% Threshold")
ax6.set_xlabel("Batch Execution Step")
ax6.set_ylabel("Buffer/TVL Ratio")
ax6.set_title("Buffer Health Ratio Over Time")
ax6.legend()
ax6.grid(True, alpha=0.3)

plt.tight_layout()
plt.show()

# --- Summary Statistics ---
print("\n" + "="*60)
print("FEE SMOOTHNESS ANALYSIS")
print("="*60)

# Calculate fee rate volatility (standard deviation of changes)
smooth_fee_changes = np.diff([rate * 100 for rate in fee_rates])
original_fee_changes = np.diff([rate * 100 for rate in original_fee_rates])

smooth_volatility = np.std(smooth_fee_changes)
original_volatility = np.std(original_fee_changes)

print(f"Original Fee Rate Volatility: {original_volatility:.4f}% per step")
print(f"Smooth Fee Rate Volatility:   {smooth_volatility:.4f}% per step")
print(f"Volatility Reduction:         {((original_volatility - smooth_volatility) / original_volatility * 100):.1f}%")

# Calculate maximum fee rate changes
max_smooth_change = np.max(np.abs(smooth_fee_changes))
max_original_change = np.max(np.abs(original_fee_changes))

print(f"\nMaximum Fee Rate Change:")
print(f"Original: {max_original_change:.4f}%")
print(f"Smooth:   {max_smooth_change:.4f}%")
print(f"Reduction: {((max_original_change - max_smooth_change) / max_original_change * 100):.1f}%")

# Calculate average fee rates
avg_smooth_fee = np.mean([rate * 100 for rate in fee_rates])
avg_original_fee = np.mean([rate * 100 for rate in original_fee_rates])

print(f"\nAverage Fee Rates:")
print(f"Original: {avg_original_fee:.4f}%")
print(f"Smooth:   {avg_smooth_fee:.4f}%")

# Buffer performance metrics
final_buffer_ratio = buffer_over_time[-1] / tvl[-1]
print(f"\nFinal Buffer/TVL Ratio: {final_buffer_ratio:.4f} ({final_buffer_ratio*100:.2f}%)")

print("="*60)
