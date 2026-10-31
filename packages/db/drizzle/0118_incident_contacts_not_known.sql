-- Whether the emergency services were called and whether the GP was contacted may be recorded as
-- "Not known yet" (null) on an incident (recommended answer to H-264, 31/10/2026; HZ-090): the
-- question stays open, with a task for the person in charge, and the reporter is never pushed to
-- guess yes or no. Expand only: the default stays false, so an earlier API or app that sends a yes
-- or no keeps working, and nothing already stored changes.
ALTER TABLE "incident" ALTER COLUMN "emergency_services_called" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "incident" ALTER COLUMN "gp_contacted" DROP NOT NULL;
