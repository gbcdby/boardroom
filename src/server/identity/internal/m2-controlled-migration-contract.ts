// #153 issuecomment-7021777100 accepts D01–D05 of the exact frozen definition below.
// This is a controlled VALUE contract, not db/migrate.ts's executable Migration.
// Its checksum domain is fixed structural phase source before identifier rendering;
// the legacy runner's checksum domain remains its actual executed SQL. No SQL is exported.
import type { ArtifactRef } from "../m2-value-contracts.ts";

type ControlledM22Definition = Readonly<{
  kind: "controlled-m22-value-definition";
  version: 22;
  name: "profile_configuration_authority";
  checksumDomain: "m2-fixed-phase-source/v1";
  definitionRef: ArtifactRef;
  dialects: Readonly<Record<"sqlite" | "postgres", Readonly<{
    checksum: string; sourceBytes: number; sourceSha256: string;
  }>>>;
}>;

// Full definition identity is mandatory: the short checksum alone does not bind
// the name, checksum domain, excluded phases or controlled execution boundary.
export const CONTROLLED_M22: ControlledM22Definition = Object.freeze({
  kind: "controlled-m22-value-definition", version: 22, name: "profile_configuration_authority",
  checksumDomain: "m2-fixed-phase-source/v1",
  definitionRef: Object.freeze({
    ref: "m2-contract/sha256/688245bdc8dc8cfb32e8c9c2ea9139629f4b5d5844efd44d05a968e49dd6d220/CONTROLLED-MIGRATION-DEFINITION.json",
    sha256: "688245bdc8dc8cfb32e8c9c2ea9139629f4b5d5844efd44d05a968e49dd6d220", bytes: "152437",
  }),
  dialects: Object.freeze({
    sqlite: Object.freeze({ checksum: "41d93b6d6ad261c5", sourceBytes: 66956,
      sourceSha256: "41d93b6d6ad261c50fc57606de6c1a02d75eefab04f8c9c6f08bf7b859a52e17" }),
    postgres: Object.freeze({ checksum: "aece9775f7cdfdda", sourceBytes: 67312,
      sourceSha256: "aece9775f7cdfddae516266d156fbf76ed8d2816f5ff5fe903af83c686a3e775" }),
  }),
});
