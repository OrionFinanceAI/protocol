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
epochs = 365
tvl = 1_000_000
balance_ratio = 0.005
initial_buffer = balance_ratio * tvl
solvency_threshold = 0  # Buffer floor

# --- Simulated slippage model (Gaussian + extreme events) ---
np.random.seed(42)
base_slippage = np.random.normal(0.001, 0.0003, size=epochs)
extreme_events = np.random.binomial(1, 0.01, size=epochs)
extreme_slippage = np.random.normal(0.03, 0.02, size=epochs) * extreme_events
slippage_series = np.clip(base_slippage + extreme_slippage, -0.001, 0.001)

# Plot slippage series
plt.figure(figsize=(10, 6))
plt.plot(slippage_series, color='purple', alpha=0.7, linewidth=1.5)
plt.title('Simulated Slippage Events Over Time', fontsize=12, pad=15)
plt.xlabel('Execution Step', fontsize=10)
plt.ylabel('Slippage Amount', fontsize=10)
plt.grid(True, linestyle='--', alpha=0.3)
plt.tight_layout()
plt.show()

# --- Dynamic fee function with smoothing ---
class SmoothFeeController:
    def __init__(self, tvl, target_ratio, max_fee_change=0.001, smoothing_factor=0.1, deadband=0.001):
        self.tvl = tvl
        self.target_ratio = target_ratio
        self.max_fee_change = max_fee_change  # Maximum fee change per step
        self.smoothing_factor = smoothing_factor  # Exponential smoothing factor
        self.deadband = deadband  # Deadband around target to prevent oscillations
        self.previous_fee = 0.0
        self.smoothed_error = 0.0
    
    def calculate_fee_rate(self, current_buffer):
        buffer_ratio = current_buffer / self.tvl
        error = self.target_ratio - buffer_ratio
        
        # Apply deadband to prevent oscillations around target
        if abs(error) < self.deadband:
            error = 0.0
        
        # Exponential smoothing of the error
        self.smoothed_error = (self.smoothing_factor * error + 
                              (1 - self.smoothing_factor) * self.smoothed_error)
        
        # Proportional control with smoothed error
        k = 1.
        target_fee = k * self.smoothed_error
        
        # Rate limiting to prevent sharp changes
        max_change = self.max_fee_change
        fee_change = target_fee - self.previous_fee
        fee_change = np.clip(fee_change, -max_change, max_change)
        
        new_fee = self.previous_fee + fee_change
        new_fee = max(0.0, new_fee)  # Ensure non-negative fees
        
        self.previous_fee = new_fee
        return new_fee

# Initialize the smooth fee controller
fee_controller = SmoothFeeController(
    tvl=tvl,
    target_ratio=balance_ratio,
    max_fee_change=0.0005,  # 0.05% max change per step
    smoothing_factor=0.1,   # 10% weight to new error
    deadband=0.001          # 0.1% deadband around target
)
# + protocol_gas_epoch (oracle for USDC/ETH exchange to compute one part, historical average for the other?) + zama_decryption_costs # + 50% of the estimated savings due to netting (can we compute it?)


# Original simple fee function for comparison
def simple_fee_rate(current_buffer, tvl):
    buffer_ratio = current_buffer / tvl
    x_star = balance_ratio
    k = 1
    fee = k * (x_star - buffer_ratio)
    return max(0.0, fee)

# --- Tracking variables ---
buffer_over_time = [initial_buffer]
fees_collected = []
fee_rates = []
original_fee_rates = []  # For comparison

# --- Simulation loop ---
for i in range(epochs):
    current_buffer = buffer_over_time[-1]
    fee_rate = fee_controller.calculate_fee_rate(current_buffer)
    original_fee_rate = simple_fee_rate(current_buffer, tvl)
    fees = fee_rate * tvl

    slippage = slippage_series[i]
    total_slippage_cost = slippage * tvl

    new_buffer = max(current_buffer + fees - total_slippage_cost, 0)  # Clamp buffer at 0
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
ax1.axhline(y=solvency_threshold, color='red', linestyle='--', label="Buffer Floor")
ax1.set_xlabel("Batch Execution Step")
ax1.set_ylabel("Buffer ($)")
ax1.set_title("Buffer Level Evolution Over Time")
ax1.legend()
ax1.grid(True, alpha=0.3)

# Highlight insolvency events
insolvent_steps = [i for i, b in enumerate(buffer_over_time) if b <= solvency_threshold]
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

# Figure 4: Fees Collected
ax4 = axes[1, 1]
ax4.plot(fees_collected, label="Fees Collected ($)", color='orange', linewidth=2)
ax4.set_xlabel("Batch Execution Step")
ax4.set_ylabel("Fees Collected ($)")
ax4.set_title("Fees Collected Over Time")
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
buffer_ratio = [b / tvl for b in buffer_over_time]
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
final_buffer_ratio = buffer_over_time[-1] / tvl
print(f"\nFinal Buffer/TVL Ratio: {final_buffer_ratio:.4f} ({final_buffer_ratio*100:.2f}%)")
print(f"Target Buffer/TVL Ratio: {balance_ratio:.4f} ({balance_ratio*100:.2f}%)")

print("="*60)
