# Vault policy for the control-plane pod identity (Kubernetes auth role
# "control-plane", hard-coded in
# control-plane/src/domains/identity/vault/vault.service.ts:37).
#
# Least privilege: the plane only ever hands plaintext in / ciphertext out of the
# Transit engine — it never reads the key material (docs/control-plane.md §4.A,
# §9.1). So this grants ONLY encrypt + decrypt on the github-tokens key. Transit
# encrypt/decrypt are POST endpoints, hence the "update" capability.
path "transit/encrypt/github-tokens" {
  capabilities = ["update"]
}

path "transit/decrypt/github-tokens" {
  capabilities = ["update"]
}
