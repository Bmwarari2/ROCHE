output "load_balancer_ip" {
  description = "The external load balancer's address; the hosts point here."
  value       = module.load_balancer.ip_address
}

output "hosts" {
  value = local.hosts
}

output "manual_dns_records" {
  description = "Records to create in the domain's own DNS when the zone is not in this project."
  value       = module.dns.manual_records
}

output "dns_name_servers" {
  value = module.dns.name_servers
}

output "artifact_registry" {
  description = "Image prefix for docker push."
  value       = module.registry.repository_url
}

output "workload_identity_provider" {
  description = "Repository variable GCP_WORKLOAD_IDENTITY_PROVIDER."
  value       = module.github_wif.workload_identity_provider
}

output "plan_service_account" {
  description = "Repository variable GCP_PLAN_SERVICE_ACCOUNT."
  value       = module.github_wif.plan_service_account
}

output "deploy_service_account" {
  description = "Repository variable GCP_DEPLOY_SERVICE_ACCOUNT."
  value       = module.github_wif.deploy_service_account
}

output "services" {
  description = "Cloud Run service names."
  value = merge(
    {
      api       = module.svc_api.name
      worker    = module.svc_worker.name
      web       = module.svc_web.name
      powersync = module.svc_powersync.name
    },
    var.enable_flagsmith ? { flagsmith = module.svc_flagsmith[0].name } : {},
  )
}

output "migrate_job" {
  description = "Run with: gcloud run jobs execute <name> --region europe-west2 --wait"
  value       = module.job_migrate.name
}

output "sql_instances" {
  value = {
    main         = module.db_main.instance_name
    sync_storage = module.db_sync_storage.instance_name
  }
}

output "buckets" {
  value = {
    documents     = module.bucket_documents.name
    exports       = module.bucket_exports.name
    audit_archive = module.bucket_audit_archive.name
    logs          = module.bucket_logs.name
  }
}

output "secret_names" {
  description = "Secrets to fill with infra/scripts/seed-secrets.sh."
  value       = module.secrets.secret_names
}
