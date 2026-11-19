// #153 issuecomment-7023345768: fixed source metadata for the finite pair/M22 value consumer.
// Exact source bytes remain in the accepted frozen contracts; no per-request source IO or decoding.
// This pair omits activationReceipt and is not ProfileCurrentClientFormat, CF facts or native authority.
export const M2_PROFILE_WRITER_CONTRACT = Object.freeze({
  writerFormat: "s2-profile-config/v1" as const,
  profileFormatPair: Object.freeze({ protocolVersion: 2 as const,
    writerFormatDigest: "c94dfbd3199953af3740188aff54566578708e0ee6267440aa27c71db51fac03" }),
  writerFormatDescriptor: Object.freeze({
    ref: "m2-contract/sha256/c94dfbd3199953af3740188aff54566578708e0ee6267440aa27c71db51fac03/WRITER-FORMAT-DESCRIPTOR.json",
    sha256: "c94dfbd3199953af3740188aff54566578708e0ee6267440aa27c71db51fac03", bytes: "2399",
  }),
  sourceClientFormatContract: Object.freeze({
    ref: "m2-contract/sha256/c7ff5f09fe063c4d8124c0d2a37f726c4c7e687ac3a59b25788632d1d8fe1d06/SOURCE-CLIENT-FORMAT-CONTRACT.json",
    sha256: "c7ff5f09fe063c4d8124c0d2a37f726c4c7e687ac3a59b25788632d1d8fe1d06", bytes: "3909",
  }),
  expectedM22Definition: Object.freeze({
    ref: "m2-contract/sha256/688245bdc8dc8cfb32e8c9c2ea9139629f4b5d5844efd44d05a968e49dd6d220/CONTROLLED-MIGRATION-DEFINITION.json",
    sha256: "688245bdc8dc8cfb32e8c9c2ea9139629f4b5d5844efd44d05a968e49dd6d220", bytes: "152437",
  }),
});
