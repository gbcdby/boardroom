// Accepted #153/7030475256; inert source identities only; production registration remains empty.
export const M2_CONTRACT_SOURCES = Object.freeze([
  {
    "artifact": {
      "ref": "m2-contract/sha256/89401f5bddb9a26295fb4a38982fccc47164a8b5c4df82f04f8bb2bb68a671b2/PHYSICAL-RELATIONS.md",
      "sha256": "89401f5bddb9a26295fb4a38982fccc47164a8b5c4df82f04f8bb2bb68a671b2",
      "bytes": "22092"
    },
    "roles": [
      "RegisteredUpgradeDescriptor.sqliteTargetSchemaRef",
      "RegisteredUpgradeDescriptor.postgresTargetSchemaRef"
    ]
  },
  {
    "artifact": {
      "ref": "m2-contract/sha256/2095046041ae0aa558a1e322fe1712606b19688870735af3d104176c0646af1e/S4-M2-TRANSITION-6829646852.md",
      "sha256": "2095046041ae0aa558a1e322fe1712606b19688870735af3d104176c0646af1e",
      "bytes": "20570"
    },
    "roles": [
      "RegisteredUpgradeDescriptor.guardTransitionRef"
    ]
  },
  {
    "artifact": {
      "ref": "m2-contract/sha256/d72f392d5310a09cc5a72987c50b441805d25913b08713fbe9143c446ce6cffb/PHYSICAL-DESIGN.md",
      "sha256": "d72f392d5310a09cc5a72987c50b441805d25913b08713fbe9143c446ce6cffb",
      "bytes": "31572"
    },
    "roles": [
      "RegisteredUpgradeDescriptor.strictDecoderContractRef"
    ]
  },
  {
    "artifact": {
      "ref": "m2-contract/sha256/c7ff5f09fe063c4d8124c0d2a37f726c4c7e687ac3a59b25788632d1d8fe1d06/SOURCE-CLIENT-FORMAT-CONTRACT.json",
      "sha256": "c7ff5f09fe063c4d8124c0d2a37f726c4c7e687ac3a59b25788632d1d8fe1d06",
      "bytes": "3909"
    },
    "roles": [
      "RegisteredUpgradeDescriptor.sourceClientFormatContractRef"
    ]
  },
  {
    "artifact": {
      "ref": "m2-contract/sha256/a18825bd529e22dd5b395f0416d3a26b90d5da773ea2ad4aa22efa20d7c27323/PC-TABLE-UNIVERSE.json",
      "sha256": "a18825bd529e22dd5b395f0416d3a26b90d5da773ea2ad4aa22efa20d7c27323",
      "bytes": "1088510"
    },
    "roles": [
      "AllowedDeltaManifest.schemaBefore",
      "AllowedDeltaManifest.schemaAfter"
    ]
  },
  {
    "artifact": {
      "ref": "m2-contract/sha256/688245bdc8dc8cfb32e8c9c2ea9139629f4b5d5844efd44d05a968e49dd6d220/CONTROLLED-MIGRATION-DEFINITION.json",
      "sha256": "688245bdc8dc8cfb32e8c9c2ea9139629f4b5d5844efd44d05a968e49dd6d220",
      "bytes": "152437"
    },
    "roles": [
      "Migration22Entry.registeredMigration"
    ]
  }
] as const);
