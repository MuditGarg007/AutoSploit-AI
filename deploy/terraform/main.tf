terraform {
  required_version = ">= 1.5"
  required_providers {
    vault = {
      source  = "hashicorp/vault"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
}

# GKE-specific inputs/resources were stripped for the self-hosted substrate
# (docs/oracle-a1-h3-runbook.md §3, docs/vps-h3-runbook.md §3): the kind + Cilium +
# gVisor cluster is stood up on the VPS by scripts/m4-bootstrap.sh, not via Terraform,
# and report blobs live in Cloudflare R2, not a GCS bucket. Only the minimal Vault
# (transit engine for the GitHub-token split) remains managed here.

variable "bootstrap_vault_token" {
  type        = string
  description = "Initial root token for the demo Vault, if provisioning a local transit engine. Optional; the Vault may already exist."
  default     = ""
  sensitive   = true
}

variable "vault_addr" {
  type    = string
  default = "http://localhost:8200"
}

provider "vault" {
  address = var.vault_addr
  token   = var.bootstrap_vault_token != "" ? var.bootstrap_vault_token : null
}

# --- Vault: Transit engine + policy + k8s auth role (control-plane.md §9.1) ---
# Only configured when a bootstrap token is supplied (i.e. a demo Vault). In prod
# the Vault is provisioned out-of-band and only the k8s-auth role is created.
resource "vault_mount" "transit" {
  count = var.bootstrap_vault_token != "" ? 1 : 0
  path  = "transit"
  type  = "transit"
}

resource "vault_transit_secret_backend_key" "github_tokens" {
  count     = var.bootstrap_vault_token != "" ? 1 : 0
  backend   = vault_mount.transit[0].path
  name      = "github-tokens"
  deletion_allowed = true
}

# Policy: the plane may only encrypt/decrypt the GitHub-tokens key, never manage it.
resource "vault_policy" "plane_transit" {
  count  = var.bootstrap_vault_token != "" ? 1 : 0
  name   = "autosploit-plane-transit"
  policy = <<EOT
path "transit/encrypt/github-tokens"      { capabilities = ["create", "update"] }
path "transit/decrypt/github-tokens"      { capabilities = ["create", "update"] }
EOT
}

# k8s auth role binding the plane's ServiceAccount to the policy (no static token).
resource "vault_kubernetes_auth_backend_role" "plane" {
  count                          = var.bootstrap_vault_token != "" ? 1 : 0
  backend                        = "kubernetes"
  role_name                      = "autosploit-plane"
  bound_service_account_names    = ["control-plane"]
  bound_service_account_namespaces = ["default"]
  token_policies                 = ["autosploit-plane-transit"]
}
