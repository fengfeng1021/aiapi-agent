import { capabilityStore, inferDefaultCapabilities, type ModelCapability } from './provider-probe.js'

export interface SanitizeResult {
  reasoningEffort?: string | undefined
  serviceTier?: string | undefined
  strippedParams: string[]
}

export interface FailureLearningResult {
  recovered: boolean
  offendingParam?: string
  updatedCapability: ModelCapability
}

/**
 * Adaptive Parameter Sanitizer that pre-flights and self-heals parameter compatibility.
 */
export class AdaptiveParamSanitizer {
  /**
   * Cleanses parameters before building configuration or calling thread/start.
   */
  static sanitize(
    providerId: string,
    modelId: string,
    desiredEffort?: string,
    desiredTier?: string,
  ): SanitizeResult {
    const cap = capabilityStore.get(providerId, modelId) || inferDefaultCapabilities(providerId, modelId)
    const strippedParams: string[] = []

    let reasoningEffort: string | undefined
    if (cap.supportsReasoningEffort) {
      reasoningEffort = desiredEffort || cap.maxReasoningEffort || 'high'
    } else if (desiredEffort) {
      strippedParams.push('reasoning_effort')
    }

    let serviceTier: string | undefined
    if (cap.supportsServiceTier) {
      serviceTier = desiredTier || 'default'
    } else if (desiredTier) {
      strippedParams.push('service_tier')
    }

    return {
      reasoningEffort,
      serviceTier,
      strippedParams,
    }
  }

  /**
   * Determines whether an error returned from Codex App-Server or an upstream platform
   * is caused by an incompatible parameter that can be self-healed.
   */
  static isParamCompatibilityError(errorMessage: string): boolean {
    const msg = errorMessage.toLowerCase()
    return (
      msg.includes('reasoning_effort') ||
      msg.includes('reasoning effort') ||
      msg.includes('service_tier') ||
      msg.includes('service tier') ||
      msg.includes('developer role') ||
      msg.includes('unrecognized request argument') ||
      msg.includes('extra inputs are not permitted') ||
      msg.includes('unsupported parameter') ||
      msg.includes('unknown parameter') ||
      msg.includes('max_completion_tokens') ||
      msg.includes('temperature is not supported for reasoning models')
    )
  }

  /**
   * Learns from a runtime error, patches the persistent capability store,
   * and provides details on what was stripped so the turn can self-heal.
   */
  static learnFromFailure(
    providerId: string,
    modelId: string,
    errorMessage: string,
  ): FailureLearningResult {
    const msg = errorMessage.toLowerCase()
    const patch: Partial<ModelCapability> = {}
    let offendingParam: string | undefined

    if (msg.includes('reasoning_effort') || msg.includes('reasoning effort')) {
      patch.supportsReasoningEffort = false
      offendingParam = 'reasoning_effort'
    } else if (msg.includes('service_tier') || msg.includes('service tier')) {
      patch.supportsServiceTier = false
      offendingParam = 'service_tier'
    } else if (msg.includes('developer role')) {
      patch.supportsDeveloperRole = false
      offendingParam = 'developer_role'
    } else if (msg.includes('max_completion_tokens')) {
      patch.maxTokensField = 'max_tokens'
      offendingParam = 'max_completion_tokens'
    }

    if (offendingParam) {
      const updated = capabilityStore.patch(providerId, modelId, patch)
      return {
        recovered: true,
        offendingParam,
        updatedCapability: updated,
      }
    }

    return {
      recovered: false,
      updatedCapability: capabilityStore.get(providerId, modelId) || inferDefaultCapabilities(providerId, modelId),
    }
  }
}
