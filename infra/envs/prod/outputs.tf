output "load_balancer_ip" {
  value = module.stack.load_balancer_ip
}

output "hosts" {
  value = module.stack.hosts
}

output "manual_dns_records" {
  value = module.stack.manual_dns_records
}

output "dns_name_servers" {
  value = module.stack.dns_name_servers
}

output "artifact_registry" {
  value = module.stack.artifact_registry
}

output "workload_identity_provider" {
  value = module.stack.workload_identity_provider
}

output "plan_service_account" {
  value = module.stack.plan_service_account
}

output "deploy_service_account" {
  value = module.stack.deploy_service_account
}

output "services" {
  value = module.stack.services
}

output "migrate_job" {
  value = module.stack.migrate_job
}

output "sql_instances" {
  value = module.stack.sql_instances
}

output "buckets" {
  value = module.stack.buckets
}

output "secret_names" {
  value = module.stack.secret_names
}
