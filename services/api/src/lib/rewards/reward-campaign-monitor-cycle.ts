export async function runRewardCampaignMonitorCycle<T>(input: {
  reconcileFunding: () => Promise<void>
  monitorIntegrity: () => Promise<T>
  onFundingError: (error: unknown) => Promise<void>
}): Promise<T> {
  try {
    await input.reconcileFunding()
  } catch (error) {
    try {
      await input.onFundingError(error)
    } catch (alertError) {
      console.error("[reward-campaigns] funding reconciliation error reporting failed", alertError)
    }
  }
  return input.monitorIntegrity()
}
