import type { ManagedBackend, VerifiedHostProfile } from "./types.ts";

export interface HostProfileIdentity {
  readonly backend: ManagedBackend;
  readonly version: string;
  readonly platform: string;
  readonly architecture: string;
  readonly mode: string;
}

/** 仅匹配完整身份；Auto 验收不能替代高级模式验收。生产调用方只传代码内固定表。 */
export function selectVerifiedHostProfile(profiles: readonly VerifiedHostProfile[], identity: HostProfileIdentity): VerifiedHostProfile | undefined {
  return profiles.find(profile => profile.backend === identity.backend && profile.version === identity.version
    && profile.platform === identity.platform && profile.architecture === identity.architecture && profile.mode === identity.mode);
}
