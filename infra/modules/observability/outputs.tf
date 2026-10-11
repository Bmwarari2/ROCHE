output "alerts_topic_arn" {
  description = "SNS topic that receives every alarm and budget notification."
  value       = aws_sns_topic.alerts.arn
}
