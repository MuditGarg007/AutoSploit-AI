terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
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

variable "project_id" {
  type        = string
  description = "GCP project (demo substrate, docs/control-plane.md §7)."
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "cluster_name" {
  type    = string
  default = "autosploit-demo"
}

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

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "vault" {
  address = var.vault_addr
  token   = var.bootstrap_vault_token != "" ? var.bootstrap_vault_token : null
}

# --- GKE Autopilot cluster (only spun up when demoing, §7) ---
resource "google_container_cluster" "autosploit" {
  name     = var.cluster_name
  location = var.region

  # Autopilot = no node pool management; cost stays near zero when the cluster
  # is torn down between demos (orchestration.md §7).
  enable_autopilot = true

  # Minimal default; private cluster keeps the plane off the public internet.
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
  }

  deletion_protection = false
}

# --- GHCR image pull secret ---
resource "google_service_account" "ghcr_pull" {
  account_id   = "autosploit-ghcr-pull"
  display_name = "Pulls the control-plane image from GHCR"
}

# --- IAM role bindings for the deployment service account ---
resource "google_service_account" "plane" {
  account_id   = "autosploit-plane"
  display_name = "Control plane workload identity"
}

# --- Object store bucket (Reports slice E + Kafka Connect S3 sink, §8.2) ---
resource "google_storage_bucket" "reports" {
  name          = "autosploit-reports-${var.project_id}"
  location      = var.region
  force_destroy = true
  uniform_bucket_level_access = true
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

# --- Outputs ---
output "cluster_endpoint" {
  value = google_container_cluster.autosploit.endpoint
}

output "cluster_ca_certificate" {
  value = google_container_cluster.autosploit.master_auth[0].cluster_ca_certificate
  sensitive = true
}

output "reports_bucket" {
  value = google_storage_bucket.reports.name
}